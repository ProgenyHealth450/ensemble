'use strict';

/**
 * Risk-tier assignment: change kinds, the sensitive floor and raise-only
 * proposals (TRD-023, REQ-012, REQ-013, REQ-015).
 *
 * NO side effects, NO shell, NO network, NO file reads. A pure function over
 * the classifier's output and the path classification from
 * `pr-review-paths.js`.
 *
 * The tier comes from the CHANGE, never from the author (AC-012-2): `author`
 * and `maintainers` may be passed for the record, and neither is read when the
 * tier is computed.
 *
 * FAIL CLOSED, which for a risk tier means MORE review, never less:
 *   - a request, or a path classification, this module cannot read is `high`
 *     with `ok:false`;
 *   - a missing, unknown or uncited kind is `other`, which is Medium: a
 *     classifier that says nothing cannot buy a cheaper review;
 *   - a second assessment that is not exactly `false` raises the tier;
 *   - a proposal may raise a tier; lowering one needs a CODEOWNERS-checked
 *     owner decision, and nothing lowers it below the sensitive floor.
 *
 * The Low WAIVER and the effective tier it produces are TRD-041's: this
 * function answers the assigned tier and the facts behind it.
 */

/** The closed set of tiers, cheapest first. */
const TIERS = Object.freeze(['low', 'medium', 'high']);

/** The closed set of change kinds (data model: unknown or uncited = `other`). */
const KINDS = Object.freeze(['docs', 'copy', 'additive-behind-flag', 'product', 'other']);

/** The kinds that, on their own, make a PR Low risk (AC-012-1). */
const LOW_KINDS = Object.freeze(['docs', 'copy', 'additive-behind-flag']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const isPathList = (value) => Array.isArray(value) && value.every((entry) => isText(entry));

/** A word from a closed set, compared on letter case only -- a padded word is not the word. */
function fromSet(value, set) {
  if (typeof value !== 'string') return null;
  const key = value.toLowerCase();
  return set.includes(key) ? key : null;
}

const rank = (tier) => TIERS.indexOf(tier);
const higher = (left, right) => (rank(left) >= rank(right) ? left : right);
const raiseOne = (tier) => TIERS[Math.min(rank(tier) + 1, TIERS.length - 1)];

/** The fail-closed answer: the deepest tier, the reason named, nothing granted. */
function blocked(reason) {
  return {
    ok: false,
    tier: 'high',
    baseTier: 'high',
    floor: 'high',
    kinds: [],
    uncitedPaths: [],
    reasons: [reason],
    raised: [],
    lowered: [],
    ignored: [],
    warnings: [reason],
  };
}

/**
 * Reads the path classification: either a `classifyPaths` result or a plain
 * `{ sensitive, high }`. Returns null when it cannot be read, and `blocked`
 * when `classifyPaths` itself refused the request.
 */
function readPaths(value, warnings) {
  if (!isObject(value)) return null;
  if (value.ok === false) return { blocked: true };
  if (!isPathList(value.sensitive === undefined ? [] : value.sensitive)) return null;
  if (!isPathList(value.high === undefined ? [] : value.high)) return null;

  let changedPaths = null;
  if (Array.isArray(value.paths)) {
    const entries = Array.from(value.paths);
    if (entries.every((entry) => isObject(entry) && isText(entry.path))) {
      changedPaths = entries.map((entry) => entry.path);
    } else if (entries.every((entry) => isText(entry))) {
      changedPaths = entries.slice();
    } else {
      warnings.push('invalid-changed-paths');
    }
  }

  return {
    blocked: false,
    sensitive: value.sensitive === undefined ? [] : value.sensitive.slice(),
    high: value.high === undefined ? [] : value.high.slice(),
    changedPaths,
  };
}

/**
 * Reads the classifier's `kinds`, normalizing each record to a known kind.
 * A record that is not an object, carries no kind, carries a word outside the
 * closed set, or cites no readable path list, becomes `other` -- and `other`
 * is Medium. A "docs" claim that cites nothing checkable is exactly the claim
 * that must not buy a cheaper review.
 */
function readKinds(value, reasons, warnings) {
  if (!Array.isArray(value) || value.length === 0) {
    reasons.push('no-kinds-cited');
    return [];
  }

  return Array.from(value).map((record) => {
    if (!isObject(record)) {
      warnings.push('invalid-kind-record');
      return { kind: 'other', declared: record === undefined ? null : record, paths: [] };
    }

    const declaredKind = fromSet(record.kind, KINDS);
    if (declaredKind === null && !reasons.includes('unknown-kind')) reasons.push('unknown-kind');

    const pathsReadable = isPathList(record.paths);
    if (!pathsReadable) warnings.push('invalid-kind-paths');

    const kind = declaredKind === null || !pathsReadable ? 'other' : declaredKind;
    const entry = { kind, paths: pathsReadable ? record.paths.slice() : [] };
    if (kind !== declaredKind) entry.declared = record.kind === undefined ? null : record.kind;
    return entry;
  });
}

/**
 * Assigns the risk tier for a PR.
 *
 * @param {Object} input
 * @param {Array<{kind:string, paths:string[]}>} input.kinds  The classifier's output.
 * @param {Object} input.paths          A `classifyPaths` result, or `{ sensitive[], high[], paths? }`.
 * @param {Object} [input.secondAssessment]  `{ needsAnotherPerson, reason, evidencePaths[] }`.
 * @param {string} [input.proposedTier]      A tier proposed by an agent or the author.
 * @param {{login:string, isCodeOwner:boolean}} [input.proposedBy]  Who proposed it; only an
 *   explicitly CODEOWNERS-checked owner may lower a tier.
 * @param {string} [input.author]       Recorded, never read: the tier comes from the change.
 * @returns {{ok:boolean, tier:string, baseTier:string, floor:string|null, kinds:Object[],
 *   uncitedPaths:string[], reasons:string[], raised:Array, lowered:Array, ignored:Array, warnings:string[]}}
 */
function assignTier(input) {
  if (!isObject(input)) return blocked('invalid-input');

  const reasons = [];
  const warnings = [];
  const raised = [];
  const lowered = [];
  const ignored = [];

  const classification = readPaths(input.paths, warnings);
  if (classification === null) return blocked('invalid-path-classification');
  if (classification.blocked) return blocked('path-classification-blocked');

  // --- The kind of change (AC-012-1) --------------------------------------
  const kinds = readKinds(input.kinds, reasons, warnings);
  const citedPaths = new Set(kinds.flatMap((entry) => entry.paths));
  const uncitedPaths = classification.changedPaths === null
    ? []
    : classification.changedPaths.filter((path) => !citedPaths.has(path));
  if (uncitedPaths.length > 0) reasons.push('uncited-path');

  const everyKindLow = kinds.length > 0 && kinds.every((entry) => LOW_KINDS.includes(entry.kind));
  let baseTier;
  if (everyKindLow && uncitedPaths.length === 0) {
    baseTier = 'low';
    reasons.push('all-kinds-low-risk');
  } else {
    baseTier = 'medium';
    if (kinds.some((entry) => entry.kind === 'product')) reasons.push('product-change');
  }

  // --- The sensitive floor (AC-013-3) -------------------------------------
  let floor = null;
  if (classification.sensitive.length > 0) {
    floor = 'high';
    reasons.push('sensitive-path');
  }
  if (classification.high.length > 0) {
    floor = 'high';
    reasons.push('owner-high-path');
  }

  let tier = floor === null ? baseTier : higher(baseTier, floor);

  // --- The second assessment (AC-012-3) -----------------------------------
  const assessment = input.secondAssessment;
  if (assessment !== undefined && assessment !== null) {
    let needsAnotherPerson;
    let reason;
    if (isObject(assessment)) {
      needsAnotherPerson = assessment.needsAnotherPerson;
      reason = isText(assessment.reason) ? assessment.reason : 'second-assessment-unreadable';
    } else {
      // Not a record at all: it cannot say "no", so it is read as "yes".
      warnings.push('invalid-second-assessment');
      needsAnotherPerson = true;
      reason = 'second-assessment-unreadable';
    }

    if (needsAnotherPerson !== false) {
      if (needsAnotherPerson !== true) reason = 'second-assessment-unreadable';
      const next = raiseOne(tier);
      if (next !== tier) raised.push({ from: tier, to: next, reason });
      tier = next;
    }
  }

  // --- The proposal: raise-only (AC-013-2) --------------------------------
  if (input.proposedTier !== undefined && input.proposedTier !== null && input.proposedTier !== '') {
    const proposed = fromSet(input.proposedTier, TIERS);
    const by = isObject(input.proposedBy) && isText(input.proposedBy.login) ? input.proposedBy.login : null;
    const isCodeOwner = isObject(input.proposedBy) && input.proposedBy.isCodeOwner === true;

    if (proposed === null) {
      warnings.push('unknown-proposed-tier');
    } else if (rank(proposed) > rank(tier)) {
      raised.push({ from: tier, to: proposed, reason: 'proposed-tier' });
      tier = proposed;
    } else if (rank(proposed) < rank(tier)) {
      if (!isCodeOwner) {
        ignored.push({ proposedTier: proposed, by, reason: 'lowering-needs-code-owner' });
      } else if (floor !== null && rank(proposed) < rank(floor)) {
        // The sensitive floor holds against everyone: to lower it, change the
        // declaration on the target branch, not the tier on this PR.
        ignored.push({ proposedTier: proposed, by, reason: 'sensitive-floor-holds' });
      } else {
        lowered.push({ from: tier, to: proposed, by });
        tier = proposed;
      }
    }
  }

  return {
    ok: true,
    tier,
    baseTier,
    floor,
    kinds,
    uncitedPaths,
    reasons,
    raised,
    lowered,
    ignored,
    warnings,
  };
}

module.exports = { assignTier, TIERS, KINDS, LOW_KINDS };
