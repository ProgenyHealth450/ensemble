'use strict';

/**
 * Local CI gate rollout and rollback (TRD-010).
 *
 * Pure planning: nothing here performs GitHub I/O. A caller supplies a
 * branch-protection response and gets back a snapshot or a PLAN (an ordered
 * list of {method, path, body} calls) that the repository owner reviews and
 * applies. Enablement preconditions read only local files plus facts the caller
 * injects. FAIL CLOSED: a malformed response, a placeholder App id or a missing
 * precondition refuses rather than guessing.
 *
 * Only the required-status-check list is edited (PATCH
 * .../protection/required_status_checks). Every other part of the protection
 * (enforce_admins, reviews, restrictions, strict) is therefore untouched and a
 * rollback that restores the checks restores the whole protection.
 */

const fs = require('fs');
const path = require('path');
const { checkEnablementReady } = require('./local-ci-timing');
const { redact } = require('./local-ci-app');

const SKILL_DIR = ['packages', 'development', 'skills', 'local-ci-gate'];
const PROOF_PATH = ['docs', 'proofs', 'local-ci-app-pin-proof.md'];
const ACCEPTED_HEADING = '## App status accepted';
const REJECTED_HEADING = '## Personal-token status rejected';

/**
 * Which step the repository owner (a branch-protection admin) approves. Every
 * plan step that changes protection carries requiresOwnerApproval:true.
 */
const OWNER_APPROVALS = Object.freeze([
  Object.freeze({ step: 'snapshot', approver: 'repository admin', needed: false, what: 'read-only GET of the current protection; no approval beyond read access to the setting' }),
  Object.freeze({ step: 'first-success-status', approver: 'repository owner', needed: true, what: 'approves publishing the first real local-ci success status from the App on a current head commit' }),
  Object.freeze({ step: 'enable-protection', approver: 'repository admin', needed: true, what: 'approves the required-status-check change (local App-pinned status required, hosted checks no longer required)' }),
  Object.freeze({ step: 'rollback-protection', approver: 'repository admin', needed: true, what: 'approves restoring the snapshot (hosted checks required again)' }),
]);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

/** Deep copy without GitHub's derived `url` fields, which are not part of a write. */
function stripUrls(v) {
  if (Array.isArray(v)) return v.map(stripUrls);
  if (isObject(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (k !== 'url' && !k.endsWith('_url')) out[k] = stripUrls(x);
    return out;
  }
  return v;
}

function refuse(problems) {
  return { ok: false, problems: Array.isArray(problems) ? problems : [problems] };
}

function protectionPath(snapshot, suffix) {
  return `/repos/${snapshot.repo}/branches/${snapshot.branch}/protection${suffix}`;
}

/**
 * Capture a branch-protection response. `repo` is owner/name, `branch` the
 * protected branch, `now` an injected Date or ISO string.
 * Returns {ok:true, snapshot} or {ok:false, problems}.
 */
function snapshotProtection(response, { repo, branch, now } = {}) {
  const problems = [];
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) problems.push('repo must be owner/name');
  if (typeof branch !== 'string' || branch === '' || /\s/.test(branch)) problems.push('branch must be a non-empty name');
  const stamp = now instanceof Date ? now.toISOString() : now;
  if (typeof stamp !== 'string' || Number.isNaN(Date.parse(stamp))) problems.push('now must be a Date or ISO timestamp');
  if (!isObject(response)) return refuse([...problems, 'response must be an object']);

  const rsc = response.required_status_checks;
  let requiredStatusChecks = null;
  if (!isObject(rsc)) {
    problems.push('required_status_checks must be present as an object (nothing to replace otherwise)');
  } else {
    if (typeof rsc.strict !== 'boolean') problems.push('required_status_checks.strict must be a boolean');
    if (!Array.isArray(rsc.checks)) {
      problems.push('required_status_checks.checks must be an array (with app_id)');
    } else {
      const checks = [];
      rsc.checks.forEach((c, i) => {
        const okApp = c && (c.app_id === null || (Number.isInteger(c.app_id) && c.app_id > 0));
        if (!isObject(c) || typeof c.context !== 'string' || c.context === '' || !okApp) {
          problems.push(`required_status_checks.checks[${i}] needs a context and an app_id (positive integer or null)`);
        } else {
          checks.push({ context: c.context, app_id: c.app_id });
        }
      });
      if (checks.length === rsc.checks.length) requiredStatusChecks = { strict: rsc.strict, checks };
    }
  }
  if (!isObject(response.enforce_admins) || typeof response.enforce_admins.enabled !== 'boolean') {
    problems.push('enforce_admins.enabled must be a boolean');
  }
  // GitHub OMITS these two keys when they are not configured (the real response for a branch with
  // neither has no such keys), so an absent key means "not configured" and is read as null. A key that
  // is present must still be an object or null; anything else is a malformed response, not a guess.
  for (const key of ['required_pull_request_reviews', 'restrictions']) {
    if (key in response && response[key] !== null && !isObject(response[key])) problems.push(`${key} must be an object or null`);
  }
  if (problems.length > 0) return refuse(problems);

  return {
    ok: true,
    snapshot: {
      repo,
      branch,
      takenAt: new Date(stamp).toISOString(),
      required_status_checks: requiredStatusChecks,
      enforce_admins: { enabled: response.enforce_admins.enabled },
      required_pull_request_reviews: isObject(response.required_pull_request_reviews) ? stripUrls(response.required_pull_request_reviews) : null,
      restrictions: isObject(response.restrictions) ? stripUrls(response.restrictions) : null,
    },
  };
}

function validSnapshot(snapshot) {
  if (!isObject(snapshot)) return 'snapshot must be an object';
  const again = snapshotProtection(snapshot, { repo: snapshot.repo, branch: snapshot.branch, now: snapshot.takenAt });
  return again.ok ? null : `snapshot is not a valid protection snapshot: ${again.problems.join('; ')}`;
}

/** The GitHub write body: app_id null (any source) is written as -1. */
const writeChecks = (checks) => checks.map((c) => ({ context: c.context, app_id: c.app_id === null ? -1 : c.app_id }));

function step(id, snapshot, body, extra) {
  return {
    id,
    method: 'PATCH',
    path: protectionPath(snapshot, '/required_status_checks'),
    body,
    changesProtection: true,
    requiresOwnerApproval: true,
    ...extra,
  };
}

const verifyStep = (snapshot) => ({
  id: 'verify',
  method: 'GET',
  path: protectionPath(snapshot, ''),
  body: null,
  changesProtection: false,
  requiresOwnerApproval: false,
});

/**
 * Plan making the local App-pinned status the required check and dropping the
 * hosted ones. Does not perform anything. `appId` must be a positive integer.
 */
function planEnable({ snapshot, statusContext, appId, replaces } = {}) {
  const bad = validSnapshot(snapshot);
  if (bad) return refuse(bad);
  const problems = [];
  if (typeof statusContext !== 'string' || statusContext.trim() === '') problems.push('statusContext must be a non-empty string');
  if (!Number.isInteger(appId) || appId <= 0) {
    problems.push(`appId must be a positive integer (got ${typeof appId === 'string' ? JSON.stringify(appId) : String(appId)}); a placeholder or missing App id refuses`);
  }
  // `replaces` names the required checks the local gate covers (the approval set's job names). Only those
  // are removed; every OTHER required check (a secret scan, a deploy preview) stays required, because the
  // gate does not run it. A name that is not currently required is refused, not ignored: it is almost
  // certainly a typo that would leave a hosted check in place while the runbook reports success.
  const current = snapshot.required_status_checks.checks.map((c) => c.context);
  if (!Array.isArray(replaces) || replaces.length === 0 || !replaces.every((c) => typeof c === 'string' && c.trim() !== '')) {
    problems.push('replaces must be a non-empty list of the required check names the local gate covers');
  } else {
    const unknown = replaces.filter((c) => !current.includes(c));
    if (unknown.length > 0) problems.push(`replaces names checks that are not currently required: ${unknown.join(', ')}`);
  }
  if (problems.length > 0) return refuse(problems);
  const kept = snapshot.required_status_checks.checks.filter((c) => !replaces.includes(c.context));
  return {
    ok: true,
    keeps: kept.map((c) => c.context),
    steps: [
      step('enable-protection', snapshot, {
        strict: snapshot.required_status_checks.strict,
        checks: [...writeChecks(kept), { context: statusContext, app_id: appId }],
      }, { removes: [...replaces] }),
      verifyStep(snapshot),
    ],
  };
}

/** Plan restoring the snapshot's required checks with their original app_ids. */
function planRollback({ snapshot } = {}) {
  const bad = validSnapshot(snapshot);
  if (bad) return refuse(bad);
  return {
    ok: true,
    steps: [
      step('rollback-protection', snapshot, {
        strict: snapshot.required_status_checks.strict,
        checks: writeChecks(snapshot.required_status_checks.checks),
      }),
      verifyStep(snapshot),
    ],
  };
}

/**
 * Proof-note structure check. The note must have both headed sections, each with
 * a `Response: HTTP <code>` line (2xx for acceptance, 4xx for rejection) and a
 * `Date: YYYY-MM-DD` line, and must contain no credential (redact is the oracle).
 */
function checkProofNote(text) {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, reasons: ['proof note is empty'] };
  const reasons = [];
  const section = (heading) => {
    const start = text.indexOf(heading);
    if (start < 0) return null;
    const rest = text.slice(start + heading.length);
    const next = rest.search(/^## /m);
    return next < 0 ? rest : rest.slice(0, next);
  };
  const check = (heading, codePattern, what) => {
    const body = section(heading);
    if (body === null) return reasons.push(`proof note lacks the section "${heading}"`);
    if (!codePattern.test(body)) reasons.push(`"${heading}" records no observed ${what} response line`);
    if (!/^Date: \d{4}-\d{2}-\d{2}\s*$/m.test(body)) reasons.push(`"${heading}" records no "Date: YYYY-MM-DD" line`);
  };
  check(ACCEPTED_HEADING, /^Response: HTTP 2\d\d\b/m, 'App-status acceptance (HTTP 2xx)');
  check(REJECTED_HEADING, /^Response: HTTP 4\d\d\b/m, 'personal-token rejection (HTTP 4xx)');
  if (redact(text) !== text) reasons.push('proof note contains something that looks like a credential');
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/**
 * Enablement preconditions. Returns {ok, reasons[]}; ok only when every one holds.
 * `repoRoot` locates default files; `paths` ({measurementNote, proofNote,
 * baselineNote}) overrides them. `hasReportedSuccess` is a caller-supplied fact:
 * the local status context has already reported success on the repository.
 */
function checkEnablementPreconditions({ repoRoot, paths, hasReportedSuccess } = {}) {
  const reasons = [];
  const given = isObject(paths) ? paths : {};
  const root = typeof repoRoot === 'string' && repoRoot !== '' ? repoRoot : null;
  const resolve = (key, parts) => (typeof given[key] === 'string' && given[key] !== '' ? given[key] : root ? path.join(root, ...parts) : null);
  const measurement = resolve('measurementNote', [...SKILL_DIR, 'MEASUREMENT.md']);
  const proof = resolve('proofNote', PROOF_PATH);
  const baseline = resolve('baselineNote', [...SKILL_DIR, 'BASELINE.md']);

  if (measurement === null) reasons.push('measurement note: no repoRoot or paths.measurementNote given');
  else {
    const r = checkEnablementReady({ notePath: measurement });
    if (!r.ok) reasons.push(`measurement note: ${r.reason}`);
  }

  if (proof === null) reasons.push('App-pin proof: no repoRoot or paths.proofNote given');
  else {
    let text = null;
    try {
      text = fs.readFileSync(proof, 'utf8');
    } catch (e) {
      reasons.push(`App-pin proof note missing at ${proof}: the App client has not been shown to satisfy an App-pinned required check (TRD-001 is open)`);
    }
    if (text !== null) {
      const r = checkProofNote(text);
      if (!r.ok) for (const x of r.reasons) reasons.push(`App-pin proof note: ${x}`);
    }
  }

  if (hasReportedSuccess !== true) {
    reasons.push('the local status context has not reported success on this repository: post a real success status on a current head commit first (GitHub only allows a check to be required if it succeeded in the repository within the past seven days)');
  }

  if (baseline === null) reasons.push('baseline note: no repoRoot or paths.baselineNote given');
  else if (!fs.existsSync(baseline)) reasons.push(`baseline note missing at ${baseline}`);

  return { ok: reasons.length === 0, reasons };
}

module.exports = {
  OWNER_APPROVALS,
  ACCEPTED_HEADING,
  REJECTED_HEADING,
  snapshotProtection,
  planEnable,
  planRollback,
  checkProofNote,
  checkEnablementPreconditions,
};
