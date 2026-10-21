'use strict';

/**
 * Finding and CI-failure sweep.
 *
 * Given already-fetched facts for recently merged PRs -- unresolved bot
 * findings (PR number + comment id) and failed hosted-CI runs on landed
 * commits (check run id) -- and the set of dedupe keys already represented by
 * beads, returns only the findings/failures that are NOT yet tracked.
 *
 * Pure: no network, no side effects, nothing runs outside a call a
 * maintainer started. The dedupe key is derived only from identifiers, never
 * from text, so re-running yields the same key.
 *
 * FAIL CLOSED: an entry whose identity cannot be read is never dropped or
 * treated as tracked; it is reported in `invalid`. Malformed top-level input
 * throws.
 */

function isId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0;
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
}

function findingKey(prNumber, commentId) {
  if (!isId(prNumber) || !isId(commentId)) return null;
  return `finding:pr${prNumber}:comment${commentId}`;
}

function failureKey(checkRunId) {
  if (!isId(checkRunId)) return null;
  return `ci-failure:checkrun${checkRunId}`;
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function toKeySet(tracked) {
  if (tracked instanceof Set) return tracked;
  if (Array.isArray(tracked)) return new Set(tracked);
  throw new TypeError('trackedKeys must be a Set or array of dedupe keys');
}

function findUntracked(facts, trackedKeys) {
  if (!isObject(facts)) throw new TypeError('facts must be an object');
  const { findings, failures } = facts;
  if (!Array.isArray(findings)) throw new TypeError('facts.findings must be an array');
  if (!Array.isArray(failures)) throw new TypeError('facts.failures must be an array');
  const tracked = toKeySet(trackedKeys);

  const result = { findings: [], failures: [], invalid: [] };
  const seen = new Set();

  for (const entry of findings) {
    const key = isObject(entry) ? findingKey(entry.prNumber, entry.commentId) : null;
    if (key === null) { result.invalid.push({ kind: 'finding', entry }); continue; }
    if (entry.resolved === true || tracked.has(key) || seen.has(key)) continue;
    seen.add(key);
    result.findings.push({ ...entry, key });
  }
  for (const entry of failures) {
    const key = isObject(entry) ? failureKey(entry.checkRunId) : null;
    if (key === null) { result.invalid.push({ kind: 'failure', entry }); continue; }
    if (tracked.has(key) || seen.has(key)) continue;
    seen.add(key);
    result.failures.push({ ...entry, key });
  }
  return result;
}

module.exports = { findUntracked, findingKey, failureKey };
