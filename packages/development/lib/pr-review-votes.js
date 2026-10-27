'use strict';

/**
 * Verification vote tally: which candidate findings the author is actually
 * asked to answer (TRD-016, REQ-005, REQ-006).
 *
 * NO side effects, NO shell, NO network, NO file reads. A pure function over
 * candidate findings and the votes independent verifiers cast on them.
 *
 * The rule the whole review loop rests on: a finding is PRESENT only when a
 * STRICT MAJORITY of the verifiers the depth EXPECTS voted it real -- 2 of 3
 * at Standard, 3 of 5 at Deep. The denominator is the expected count, never
 * the number of votes that happened to arrive, so a verifier that timed out,
 * crashed or was never dispatched can never be read as agreement.
 *
 * FAIL CLOSED, which here means two different things at once, and both
 * matter:
 *
 *   - nothing is ever waved through: a request, a finding or a vote this
 *     module cannot read never produces a `present` finding;
 *   - nothing is ever dropped (REQ-006): a finding whose votes cannot be read
 *     comes back as `unverified` and PRESENTED, with the reason attached. A
 *     silently discarded finding is the one outcome this module must not
 *     have.
 *
 * Outcomes:
 *   `present`     the majority voted it real -- the author answers it;
 *   `filtered`    a non-finding, or the majority was not reached;
 *   `disputed`    critical or security-relevant, and the verifiers split or
 *                 rejected it: a person decides, not a vote (AC-006-2);
 *   `unverified`  verification did not run, or could not be read, for this
 *                 finding -- presented and marked.
 *
 * Per-finding degradation, ledger recording and the author-facing wording of
 * these outcomes are TRD-039's.
 */

/** The verifiers each depth expects (AC-005-1). Quick runs no verification at all. */
const EXPECTED_VERIFIERS = Object.freeze({ quick: 0, standard: 3, deep: 5 });

/** The only verdicts that are votes. Anything else is not a vote (not a "no", not a "yes"). */
const VERDICTS = Object.freeze(['real', 'not-real', 'abstain']);

/** Kinds that need no answer from the author (AC-005-2). */
const NON_FINDING_KINDS = Object.freeze(['style', 'diagnostic', 'cleanup']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';

/** Text identity for ids that may be written as a string or a finite number. */
const identity = (value) => (isText(value) ? value.trim() : Number.isFinite(value) ? String(value) : null);

/** A strict majority of `expected`: 2 of 3, 3 of 5, 1 of 1. */
function majorityOf(expected) {
  if (!Number.isInteger(expected) || expected < 0) return null;
  return Math.floor(expected / 2) + 1;
}

/** The fail-closed answer: nothing verified, nothing presented as agreed, the reason named. */
function blocked(reason) {
  return { ok: false, verification: 'blocked', reason, findings: [], presented: [] };
}

/** Whether a finding is in the security lane: a person adjudicates it, never a vote alone. */
function isSecurityLane(finding) {
  if (finding.security === true) return true;
  if (finding.lane === 'security') return true;
  if (finding.critical === true) return true;
  return isText(finding.severity) && finding.severity.trim().toLowerCase() === 'critical';
}

/** Whether a finding needs no answer: style, diagnostic or cleanup. The security lane is never one. */
function isNonFinding(finding) {
  if (isSecurityLane(finding)) return false;
  if (finding.nonFinding === true) return true;
  return isText(finding.kind) && NON_FINDING_KINDS.includes(finding.kind.trim().toLowerCase());
}

/**
 * Counts the votes that actually count for one finding.
 *
 * A vote is discarded, with its reason recorded, when the verifier is the
 * finding's own reviewer (nobody verifies themselves), when the verdict is
 * not one of real / not-real / abstain, when the verifier is unnamed, or when
 * that verifier has already voted on this finding.
 */
function countVotes(finding) {
  const votes = finding.votes === undefined || finding.votes === null ? [] : finding.votes;
  if (!Array.isArray(votes)) return { ok: false, reason: 'unreadable-votes' };

  const reviewer = isText(finding.reviewer) ? finding.reviewer.trim().toLowerCase() : null;
  const counted = { real: 0, notReal: 0, abstain: 0 };
  const ignoredVotes = [];
  const seen = new Set();

  for (const vote of Array.from(votes)) {
    if (!isObject(vote)) return { ok: false, reason: 'unreadable-votes' };
    const verifier = isText(vote.verifier) ? vote.verifier.trim() : null;
    if (verifier === null) {
      ignoredVotes.push({ verifier: null, reason: 'unnamed-verifier' });
      continue;
    }
    const key = verifier.toLowerCase();
    if (reviewer !== null && key === reviewer) {
      ignoredVotes.push({ verifier, reason: 'own-finding' });
      continue;
    }
    const verdict = isText(vote.verdict) ? vote.verdict.trim().toLowerCase() : null;
    if (verdict === null || !VERDICTS.includes(verdict)) {
      ignoredVotes.push({ verifier, reason: 'unknown-verdict' });
      continue;
    }
    if (seen.has(key)) {
      ignoredVotes.push({ verifier, reason: 'duplicate-vote' });
      continue;
    }
    seen.add(key);
    if (verdict === 'real') counted.real += 1;
    else if (verdict === 'not-real') counted.notReal += 1;
    else counted.abstain += 1;
  }

  return { ok: true, counted, ignoredVotes };
}

/**
 * Tallies verifier votes over the candidate findings of one review round.
 *
 * @param {Object} input
 * @param {Object[]} input.findings  Candidate findings, each `{ id, severity?, kind?,
 *   security?, reviewer?, votes:[{ verifier, verdict }] }`.
 * @param {string} input.depth       `quick` | `standard` | `deep`.
 * @param {number} [input.expectedVerifiers]  Overrides the depth's expected count.
 * @returns {{ok:boolean, verification:string, reason?:string, findings:Object[], presented:Object[]}}
 */
function tallyVotes(input) {
  if (!isObject(input)) return blocked('invalid-input');
  if (!Array.isArray(input.findings)) return blocked('findings must be an array');
  if (!input.findings.every(isObject)) return blocked('findings must contain only objects');

  const depth = isText(input.depth) ? input.depth.trim().toLowerCase() : null;
  if (depth === null || !Object.prototype.hasOwnProperty.call(EXPECTED_VERIFIERS, depth)) {
    return blocked(`unknown depth ${JSON.stringify(input.depth)} (expected quick, standard or deep)`);
  }

  let expected = EXPECTED_VERIFIERS[depth];
  if (input.expectedVerifiers !== undefined) {
    if (!Number.isInteger(input.expectedVerifiers) || input.expectedVerifiers < 0) {
      return blocked('expectedVerifiers must be an integer >= 0 when given');
    }
    expected = input.expectedVerifiers;
  }

  const ids = input.findings.map((finding) => identity(finding.id));
  if (ids.some((id) => id === null)) return blocked('every finding needs an id');

  const needed = majorityOf(expected);
  const quick = expected === 0;

  const findings = input.findings.map((finding, index) => {
    const base = { ...finding, id: finding.id };
    const votes = countVotes(finding);

    if (!votes.ok) {
      // Unreadable votes: the finding stays, marked, and is presented.
      return {
        ...base,
        outcome: 'unverified',
        reason: votes.reason,
        presented: true,
        tally: { real: 0, notReal: 0, abstain: 0, expected, needed },
        ignoredVotes: [],
      };
    }

    const tally = { ...votes.counted, expected, needed };
    const entry = { ...base, tally, ignoredVotes: votes.ignoredVotes };

    if (quick) {
      // No verifier was expected, so no vote can speak for this finding.
      return { ...entry, outcome: 'unverified', reason: 'verification-not-performed', presented: true };
    }

    if (isNonFinding(finding)) {
      return { ...entry, outcome: 'filtered', reason: 'non-finding', presented: false };
    }

    if (votes.counted.real >= needed) {
      return { ...entry, outcome: 'present', reason: 'verifier-majority', presented: true };
    }

    if (isSecurityLane(finding)) {
      // Critical and security-relevant findings are never closed by a vote:
      // they go to a person (AC-006-2).
      return { ...entry, outcome: 'disputed', reason: 'security-finding-not-verified', presented: true };
    }

    return { ...entry, outcome: 'filtered', reason: 'verifier-majority-not-reached', presented: false, index };
  });

  const cleaned = findings.map((entry) => {
    const copy = { ...entry };
    delete copy.index;
    return copy;
  });

  const result = {
    ok: true,
    verification: quick ? 'not-performed' : 'performed',
    findings: cleaned,
    presented: cleaned.filter((entry) => entry.presented),
  };
  if (quick) result.reason = 'depth-quick-no-verifiers';
  return result;
}

module.exports = { tallyVotes, majorityOf, EXPECTED_VERIFIERS, VERDICTS, NON_FINDING_KINDS };
