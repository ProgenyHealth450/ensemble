'use strict';

/**
 * Finding ledger validation, actionability classification, deduplication,
 * head-scoped merge and scope-violation detection for the PR-review cycle.
 *
 * NO side effects, NO shell, NO network calls. Pure functions over plain
 * finding objects shaped as:
 *   { id, source, locationOrLink, severity, failureMode, disposition,
 *     evidence, originalTextOrLink, unresolvedThread?, uncertain?, reason?,
 *     headSha?, file? }
 *
 * FAIL CLOSED. A missing, non-array or ill-typed input is never read as "an
 * empty ledger" or "nothing to see": validateLedger answers
 * `{ ok: false, reason, offendingIds: [] }`, dedupeFindings, mergeFindings and
 * scopeViolations answer `{ ok: false, reason }` in place of their array (so a
 * caller can tell the two apart with Array.isArray), and a finding that cannot
 * be read is treated as actionable by isActionable -- it can never be waved
 * through.
 */

const { redact } = require('./pr-review-state');

const REQUIRED_FIELDS = [
  'id',
  'source',
  'locationOrLink',
  'severity',
  'failureMode',
  'disposition',
  'evidence',
  'originalTextOrLink',
];

/** Optional flags that, when present, must be real booleans. */
const FLAGS = ['unresolvedThread', 'uncertain', 'cleared', 'preExisting'];

const VALID_DISPOSITIONS = new Set(['fix', 'duplicate', 'not-applicable', 'deferred', 'adjudicate', 'resolved']);

/**
 * The closed set the library enforces (AC-007-2). What each word MEANS -- what
 * counts as Important rather than Nit -- stays editable prose in the skill and
 * REVIEW.md (AC-007-3); only these three words are graded here.
 */
const SEVERITIES = Object.freeze(['important', 'nit', 'pre-existing']);

/**
 * The prior vocabulary, read without loss (AC-007-4): Critical and Major are
 * Important, Minor and Nitpick are Nit. The canonical words map to themselves,
 * so normalizing twice is the same as normalizing once.
 */
const LEGACY_SEVERITY_MAP = Object.freeze({
  critical: 'important',
  major: 'important',
  minor: 'nit',
  nitpick: 'nit',
  important: 'important',
  nit: 'nit',
  'pre-existing': 'pre-existing',
  preexisting: 'pre-existing',
  'pre existing': 'pre-existing',
});

/**
 * The canonical severity of a finding's word, or `null` when the word is not
 * one this library knows. Null is the fail-closed answer: every caller treats
 * an unrecognised severity as actionable rather than guessing a rank for it.
 *
 * Letter case is ignored, nothing else is: a padded or decorated word (`"
 * minor"`, `"minor!"`) is NOT recognised, the same rule the rest of this file
 * has always applied to severities.
 */
function normalizeSeverity(value) {
  if (typeof value !== 'string') return null;
  const key = value.toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEGACY_SEVERITY_MAP, key) ? LEGACY_SEVERITY_MAP[key] : null;
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Text with something in it: a string that is not blank. Numbers, booleans and containers are not text. */
function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** `Array.from` first, so a hole in a sparse array is an undefined entry rather than a skipped one. */
function everyEntry(list, predicate) {
  return Array.from(list).every(predicate);
}

function rejection(reason) {
  return { ok: false, reason };
}

/**
 * A finding is usable only when it is an object whose required fields are all
 * text (the id may also be a finite number), whose disposition is drawn from
 * the allowed set, and whose optional flags, when present, are booleans.
 */
function isUsableFinding(finding) {
  if (!isObject(finding)) return false;
  for (const field of REQUIRED_FIELDS) {
    const value = finding[field];
    const usable = field === 'id' ? isText(value) || Number.isFinite(value) : isText(value);
    if (!usable) return false;
  }
  if (!VALID_DISPOSITIONS.has(finding.disposition)) return false;
  return FLAGS.every((flag) => finding[flag] === undefined || typeof finding[flag] === 'boolean');
}

/**
 * Every finding must carry id, source, location-or-link, severity, failure
 * mode, a disposition drawn from the allowed set, evidence, and original
 * text or link -- else it is rejected with the offending ids. Anything but an
 * array of findings is rejected outright.
 */
function validateLedger(findings) {
  if (!Array.isArray(findings)) return { ok: false, reason: 'findings must be an array', offendingIds: [] };
  const offendingIds = [];
  for (const finding of Array.from(findings)) {
    if (!isUsableFinding(finding)) offendingIds.push(isObject(finding) ? finding.id : null);
  }
  return { ok: offendingIds.length === 0, offendingIds };
}

/**
 * The taxonomy audit of a ledger, kept separate from validateLedger so the
 * shape of that long-standing result is unchanged: which findings carry a
 * severity outside the closed set (AC-007-2) and which are not anchored to a
 * file and line. Neither is fatal -- an unrecognised severity stays actionable
 * and no finding is dropped -- but both are named so a report can show them.
 *
 * @returns {{ok:boolean, unrecognisedSeverityIds:Array, unanchoredIds:Array}|{ok:false, reason:string, ...}}
 */
function auditTaxonomy(findings) {
  const empty = { unrecognisedSeverityIds: [], unanchoredIds: [] };
  if (!Array.isArray(findings)) return { ok: false, reason: 'findings must be an array', ...empty };
  if (!everyEntry(findings, isObject)) return { ok: false, reason: 'findings must contain only objects', ...empty };

  const unrecognisedSeverityIds = [];
  const unanchoredIds = [];
  for (const finding of Array.from(findings)) {
    if (normalizeSeverity(finding.severity) === null) unrecognisedSeverityIds.push(finding.id);
    if (anchorOf(finding) === null) unanchoredIds.push(finding.id);
  }
  return { ok: unrecognisedSeverityIds.length === 0 && unanchoredIds.length === 0, unrecognisedSeverityIds, unanchoredIds };
}

/** A flag that is neither absent nor exactly false: true, but also "true", 1, null, {} -- none can be read as "no". */
function isUnsettled(flag) {
  return flag !== undefined && flag !== false;
}

/**
 * Whether a finding still blocks.
 *
 * Pre-existing never blocks (AC-007-1): it names a problem the PR did not
 * introduce, is reported in its own bucket and is not the author's to answer.
 * Everything else blocks until it is answered: an Important finding always, a
 * Nit unless it is deferred with a recorded reason, any finding with an open
 * thread or an uncertain flag, and any finding whose severity cannot be read.
 * A finding answered with a recorded resolution reason (AC-008-2) or cleared
 * by a later head that changed the cited location (AC-008-3) stops blocking,
 * but an open thread outranks both: a disputed finding is still answered.
 *
 * Fail closed: a finding that is not an object, an unrecognised severity, a
 * flag that is not exactly false or absent, a `cleared` that is not exactly
 * `true`, or a resolution with no text reason, all stay actionable.
 */
function isActionable(finding) {
  if (!isObject(finding)) return true;

  const severity = normalizeSeverity(finding.severity);
  if (severity === 'pre-existing') return false;
  if (isUnsettled(finding.unresolvedThread) || isUnsettled(finding.uncertain)) return true;
  if (finding.cleared === true) return false;
  if (isObject(finding.resolution) && isText(finding.resolution.reason)) return false;
  if (severity === 'important') return true;
  if (severity === 'nit') {
    const deferredWithReason = finding.disposition === 'deferred' && isText(finding.reason);
    return !deferredWithReason;
  }
  return true;
}

function dedupeKey(finding) {
  return `${finding.locationOrLink || ''}::${finding.failureMode || ''}`;
}

/**
 * The order duplicates collapse in. The canonical words rank Important above
 * Nit above Pre-existing; the legacy words keep the finer order they were
 * written with (critical above major, minor above nitpick), so a ledger
 * recorded before the taxonomy change collapses exactly as it did before.
 */
const SEVERITY_RANK = { critical: 4, important: 3, major: 3, minor: 2, nit: 1, nitpick: 1, 'pre-existing': 0 };
// isActionable treats a missing or unrecognised severity as actionable, so it ranks with Important, not below Nit.
const UNRECOGNISED_SEVERITY_RANK = SEVERITY_RANK.important;

function severityRank(finding) {
  const severity = String((finding && finding.severity) || '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(SEVERITY_RANK, severity)
    ? SEVERITY_RANK[severity]
    : UNRECOGNISED_SEVERITY_RANK;
}

/** The head a finding was recorded on, or undefined when it carries none (absent, null or blank). */
function headOf(finding) {
  return hasValue(finding && finding.headSha) ? finding.headSha : undefined;
}

/**
 * The member a duplicate group collapses onto: an actionable member beats a
 * non-actionable one, then the more severe wins, then the first seen. The
 * collapsed entry is therefore actionable whenever any member is -- a
 * deferred Minor can never hide a Critical, whichever of them comes first.
 */
function collapseBase(group) {
  let base = group[0];
  let baseActionable = isActionable(base);
  for (let index = 1; index < group.length; index += 1) {
    const candidate = group[index];
    const candidateActionable = isActionable(candidate);
    const outranks =
      candidateActionable !== baseActionable ? candidateActionable : severityRank(candidate) > severityRank(base);
    if (outranks) {
      base = candidate;
      baseActionable = candidateActionable;
    }
  }
  return base;
}

/**
 * Duplicate findings (same location + failure mode) share one fix id and
 * keep every original link. The group collapses onto its most severe
 * actionable member (see collapseBase), and an actionable entry never keeps a
 * `deferred` disposition.
 *
 * @returns {Object[]|{ok:false, reason:string}}  The findings, or a rejection when `findings` is not an array of objects.
 */
function dedupeFindings(findings) {
  if (!Array.isArray(findings)) return rejection('findings must be an array');
  if (!everyEntry(findings, isObject)) return rejection('findings must contain only objects');

  const groups = new Map();
  for (const finding of findings) {
    const key = dedupeKey(finding);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(finding);
  }

  const result = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    const fixId = group.find((f) => f.fixId)?.fixId || group[0].id;
    const originalLinks = group
      .map((f) => f.originalTextOrLink)
      .filter((link) => hasValue(link));
    const collapsed = { ...collapseBase(group), fixId, originalLinks };
    if (collapsed.disposition === 'deferred' && isActionable(collapsed)) {
      collapsed.disposition = collapsed.uncertain === true ? 'adjudicate' : 'fix';
    }
    result.push(collapsed);
  }
  return result;
}

/**
 * Whether an incoming finding replaces the existing entry for the same key.
 *   - The existing entry was recorded on a different head: its disposition
 *     says nothing about the current head, so the finding is re-opened.
 *   - The incoming finding is more severe, or is actionable where the
 *     existing entry is not (e.g. a deferred Minor now raised as an open
 *     thread): the more cautious record wins.
 * An unchanged re-observation for the same head keeps its disposition.
 */
function supersedes(existing, incoming, headSha) {
  const currentHead = hasValue(headSha) ? headSha : headOf(incoming);
  const existingHead = headOf(existing);
  if (existingHead !== undefined && currentHead !== undefined && existingHead !== currentHead) return true;
  return severityRank(incoming) > severityRank(existing) || (isActionable(incoming) && !isActionable(existing));
}

/** A recorded head that is present but is not text: neither a head nor "no head". Null and blank mean no head. */
function hasForeignHead(finding) {
  return finding.headSha !== undefined && finding.headSha !== null && typeof finding.headSha !== 'string';
}

/**
 * Merge newly observed findings into an existing, already-dispositioned
 * ledger for a given head. An already-dispositioned finding for the same
 * head is not re-opened unless the new observation escalates it (more
 * severe, or actionable where the entry was not); an entry recorded on a
 * different head is re-opened. Genuinely new findings are added.
 *
 * Both lists must be arrays of objects -- an absent ledger is `[]`, said so --
 * and `headSha`, when given, must be text. A rejection is returned instead of
 * a merge, so findings are never silently dropped by a misspelt argument.
 *
 * @returns {Object[]|{ok:false, reason:string}}
 */
function mergeFindings(existingLedger, incomingFindings, headSha) {
  if (!Array.isArray(existingLedger)) return rejection('existingLedger must be an array');
  if (!Array.isArray(incomingFindings)) return rejection('incomingFindings must be an array');
  if (headSha !== undefined && !isText(headSha)) return rejection('headSha must be a non-empty string when given');
  if (!everyEntry(existingLedger, isObject) || !everyEntry(incomingFindings, isObject)) {
    return rejection('ledger entries must be objects');
  }
  if (existingLedger.some(hasForeignHead) || incomingFindings.some(hasForeignHead)) {
    return rejection('a finding headSha must be a string');
  }

  const merged = existingLedger.slice();
  const indexByKey = new Map();
  merged.forEach((finding, index) => indexByKey.set(dedupeKey(finding), index));

  for (const finding of incomingFindings) {
    const incomingHead = headOf(finding);
    if (incomingHead !== undefined && hasValue(headSha) && incomingHead !== headSha) continue;
    const key = dedupeKey(finding);
    if (!indexByKey.has(key)) {
      indexByKey.set(key, merged.length);
      merged.push(finding);
    } else if (supersedes(merged[indexByKey.get(key)], finding, headSha)) {
      merged[indexByKey.get(key)] = finding;
    }
  }
  return merged;
}

/** The file a ledger entry covers: its own `file`, else the file part of its location. Only text counts. */
function coveredFile(entry) {
  if (isText(entry.file)) return entry.file;
  return isText(entry.locationOrLink) ? entry.locationOrLink.split(':')[0] : undefined;
}

/**
 * Each changed file outside the declared scope without a corresponding
 * ledger entry is returned as a violation. All three arguments are required:
 * `changedFiles` and `scope` arrays of file names, `ledger` an array of
 * finding objects. Anything else is rejected rather than read as "nothing
 * changed" or "everything is in scope".
 *
 * @returns {string[]|{ok:false, reason:string}}
 */
function scopeViolations(changedFiles, scope, ledger) {
  if (!Array.isArray(changedFiles)) return rejection('changedFiles must be an array');
  if (!Array.isArray(scope)) return rejection('scope must be an array');
  if (!Array.isArray(ledger)) return rejection('ledger must be an array');
  if (!everyEntry(changedFiles, isText)) return rejection('changedFiles must contain only non-empty strings');
  if (!everyEntry(scope, isText)) return rejection('scope must contain only non-empty strings');
  if (!everyEntry(ledger, isObject)) return rejection('ledger must contain only objects');

  const allowed = new Set(scope);
  const covered = new Set();
  for (const entry of ledger) {
    const file = coveredFile(entry);
    if (file !== undefined && file.trim() !== '') covered.add(file);
  }

  return changedFiles.filter((file) => !allowed.has(file) && !covered.has(file));
}

/**
 * The file and line a finding is anchored to, or `null` when it carries no
 * `file:line` anchor (a bare link, a file with no line, a malformed line).
 * Presented findings must be anchored (AC-007-2); an unanchored one is named
 * by validateLedger rather than quietly presented without a location.
 */
function anchorOf(finding) {
  if (!isObject(finding) || !isText(finding.locationOrLink)) return null;
  const match = /^(.+?):(\d+)(?::\d+)?$/.exec(finding.locationOrLink.trim());
  if (match === null) return null;
  const line = Number(match[2]);
  if (!Number.isInteger(line) || line < 1) return null;
  return { file: match[1], line };
}

/**
 * One finding, read into the current taxonomy and redacted.
 *
 * The canonical severity replaces the written word and the written word is
 * kept as `originalSeverity`, so a Critical/Major/Minor/Nitpick ledger reads
 * as Important/Nit with nothing lost and nothing rewritten in silence
 * (AC-007-4). An unrecognised word is KEPT as written and flagged
 * `severityRecognised: false`: it must stay visible and it stays actionable.
 * Credential-shaped text is redacted with the review-state redaction before
 * the finding is recorded anywhere (AC-024-2).
 */
function normalizeFinding(finding) {
  if (!isObject(finding)) return finding;
  const canonical = normalizeSeverity(finding.severity);
  const normalized = { ...redact(finding) };
  normalized.severityRecognised = canonical !== null;
  normalized.preExisting = canonical === 'pre-existing';
  if (canonical !== null) {
    if (finding.severity !== canonical) normalized.originalSeverity = finding.severity;
    normalized.severity = canonical;
  }
  return normalized;
}

/**
 * A whole ledger read into the current taxonomy, in the order given and with
 * every entry kept.
 *
 * @returns {Object[]|{ok:false, reason:string}}  Rejects anything that is not
 *   an array of finding objects, so a misread ledger is never an empty one.
 */
function normalizeLedger(findings) {
  if (!Array.isArray(findings)) return rejection('findings must be an array');
  if (!everyEntry(findings, isObject)) return rejection('findings must contain only objects');
  return Array.from(findings).map(normalizeFinding);
}

/** Presentation order: Important (and anything unreadable) first, then Nit, then Pre-existing. */
const PRESENTATION_ORDER = { important: 0, nit: 1, 'pre-existing': 2 };
const UNRECOGNISED_PRESENTATION_ORDER = PRESENTATION_ORDER.important;

function presentationRank(finding) {
  const severity = normalizeSeverity(finding && finding.severity);
  return severity === null ? UNRECOGNISED_PRESENTATION_ORDER : PRESENTATION_ORDER[severity];
}

/**
 * The findings sorted for presentation: Important first (AC-007-2), then Nit,
 * then Pre-existing. The sort is stable, so findings of one severity keep the
 * order the reviewers reported them in. A severity that cannot be read sorts
 * with Important -- it is never buried at the bottom of the list.
 *
 * @returns {Object[]|{ok:false, reason:string}}
 */
function sortFindings(findings) {
  const normalized = normalizeLedger(findings);
  if (!Array.isArray(normalized)) return normalized;
  return normalized
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => presentationRank(a.finding) - presentationRank(b.finding) || a.index - b.index)
    .map((entry) => entry.finding);
}

/**
 * The findings split into the buckets a report presents: Important, Nit and
 * Pre-existing (reported separately and never blocking, AC-007-1), plus
 * `unrecognised` for severities this library does not know and `blocking` for
 * everything still to be answered. Each bucket is in presentation order.
 *
 * @returns {{ok:true, findings:Object[], important:Object[], nits:Object[],
 *   preExisting:Object[], unrecognised:Object[], blocking:Object[]}|{ok:false, reason:string}}
 */
function partitionFindings(findings) {
  const sorted = sortFindings(findings);
  if (!Array.isArray(sorted)) return { ok: false, reason: sorted.reason };

  const bucket = (name) => sorted.filter((finding) => normalizeSeverity(finding.severity) === name);
  return {
    ok: true,
    findings: sorted,
    important: bucket('important'),
    nits: bucket('nit'),
    preExisting: bucket('pre-existing'),
    unrecognised: sorted.filter((finding) => normalizeSeverity(finding.severity) === null),
    blocking: sorted.filter((finding) => isActionable(finding)),
  };
}

/**
 * Records the author's answer to a finding (AC-008-2): the reason is stored on
 * the finding, the disposition becomes `resolved` and the finding stops
 * blocking -- unless its thread is still open, which isActionable keeps
 * actionable until the thread is closed.
 *
 * Fail closed: a resolution with no text reason is REFUSED and the finding is
 * returned unchanged, still blocking. "Closed with no reason" is not a thing
 * this library can record.
 *
 * @param {Object} finding
 * @param {{reason:string, by?:string, at?:string}} resolution
 * @returns {{ok:true, finding:Object}|{ok:false, reason:string, finding:Object}}
 */
function recordResolution(finding, resolution) {
  if (!isObject(finding)) return { ok: false, reason: 'a resolution needs a finding object', finding };
  if (!isObject(resolution) || !isText(resolution.reason)) {
    return { ok: false, reason: 'a resolution needs a text reason', finding };
  }

  const record = { reason: redact(resolution.reason.trim()) };
  if (isText(resolution.by)) record.by = redact(resolution.by.trim());
  if (isText(resolution.at)) record.at = resolution.at.trim();

  return { ok: true, finding: { ...normalizeFinding(finding), disposition: 'resolved', resolution: record } };
}

/** One changed location: `'path'`, `'path:line'`, or `{ path, lines?: number[] }`. `lines: null` means the whole file. */
function readChangedLocation(entry) {
  if (isText(entry)) {
    const anchored = /^(.+?):(\d+)$/.exec(entry.trim());
    return anchored === null ? { path: entry.trim(), lines: null } : { path: anchored[1], lines: [Number(anchored[2])] };
  }
  if (!isObject(entry) || !isText(entry.path)) return null;
  if (entry.lines === undefined || entry.lines === null) return { path: entry.path.trim(), lines: null };
  if (!Array.isArray(entry.lines) || !everyEntry(entry.lines, (line) => Number.isInteger(line) && line >= 1)) return null;
  return { path: entry.path.trim(), lines: Array.from(entry.lines) };
}

/**
 * Clears findings a later head fixed (AC-008-3).
 *
 * A finding recorded on an earlier head clears when the new head changed the
 * location it cited AND no reviewer reported it again at that head: the code
 * it described is gone, so it is marked `cleared` and stops blocking. A
 * finding already recorded on `headSha` is not cleared by its own head, and a
 * re-reported finding is never cleared.
 *
 * Fail closed: any request shape it cannot read is REFUSED. "Clear everything"
 * is never the answer to a malformed call.
 *
 * @param {{ledger:Object[], changedLocations:Array, headSha:string, reReported?:Object[]}} input
 * @returns {{ok:true, findings:Object[], cleared:Array}|{ok:false, reason:string}}
 */
function clearFixedFindings(input) {
  if (!isObject(input)) return rejection('invalid-input');
  const { ledger, changedLocations, headSha } = input;
  const reReported = input.reReported === undefined ? [] : input.reReported;

  if (!Array.isArray(ledger)) return rejection('ledger must be an array');
  if (!everyEntry(ledger, isObject)) return rejection('ledger must contain only objects');
  if (!Array.isArray(changedLocations)) return rejection('changedLocations must be an array');
  if (!Array.isArray(reReported)) return rejection('reReported must be an array');
  if (!everyEntry(reReported, isObject)) return rejection('reReported must contain only objects');
  if (!isText(headSha)) return rejection('headSha must be a non-empty string');

  const locations = Array.from(changedLocations).map(readChangedLocation);
  if (locations.some((location) => location === null)) {
    return rejection('a changed location must be a path, a path:line, or { path, lines[] }');
  }

  const reReportedKeys = new Set(reReported.map(dedupeKey));
  const cleared = [];

  const findings = ledger.map((entry) => {
    const normalized = normalizeFinding(entry);
    if (headOf(entry) === headSha) return normalized;
    if (reReportedKeys.has(dedupeKey(entry))) return normalized;

    const anchor = anchorOf(entry);
    const file = anchor === null ? coveredFile(entry) : anchor.file;
    if (file === undefined) return normalized;

    const touched = locations.some(
      (location) => location.path === file && (location.lines === null || anchor === null || location.lines.includes(anchor.line))
    );
    if (!touched) return normalized;

    cleared.push(entry.id);
    return { ...normalized, cleared: true, clearedBy: headSha, clearedReason: 'location-changed' };
  });

  return { ok: true, findings, cleared };
}

module.exports = {
  validateLedger,
  auditTaxonomy,
  isActionable,
  dedupeFindings,
  mergeFindings,
  scopeViolations,
  normalizeSeverity,
  normalizeFinding,
  normalizeLedger,
  anchorOf,
  sortFindings,
  partitionFindings,
  recordResolution,
  clearFixedFindings,
  SEVERITIES,
  LEGACY_SEVERITY_MAP,
};
