'use strict';

/**
 * Put a scoping label on every bead that belongs to one TRD.
 *
 * `bv --robot-plan --label <L>` scopes a plan to one TRD only when beads carry <L>; a label
 * nothing carries is silently ignored and bv returns the unscoped plan. Beads scaffolded
 * before labels existed need this backfill, and it is safe to run every time.
 */

const { resolveCategory } = require('./toolchain/config');
const { loadAdapter } = require('./toolchain/adapters');
const { detectAdapter } = require('./toolchain/detect');
const { runCapabilitySync } = require('./toolchain/runner');

const IDS_PER_CALL = 50; // bounds how many ids one runBr('label', 'add', ...) batch labels

/** br 0.2.x wraps list output as { issues: [...] }; older versions print a bare array. */
const issuesOf = (parsed) => (Array.isArray(parsed) ? parsed : (parsed && parsed.issues) || []);

/**
 * Resolve and load the `tracker` category's adapter (TRD-2026-8d825f54 TRD-025, PRD AC-016-2),
 * the same `resolveCategory`/`loadAdapter` pipeline `toolchain-cli.js#run` uses for every other
 * capability call -- never `br` directly. Confirmation/ledger/preflight gating (TRD-014/015/
 * 017) governs only the shell-invoked `toolchain-cli run` surface; this in-process CLI routing
 * intentionally omits it, matching every capability this file calls (`tracker.list`,
 * `tracker.label`), neither of which this adapter's own confirmation policy applies to outside
 * that surface.
 *
 * @returns {{manifest: object}}
 * @throws {Error} whatever `resolveCategory`/`loadAdapter` throws; `runBr`'s only caller
 *   (`ensureLabel`) never catches it, so an unresolved tracker surfaces as a thrown error out
 *   of `ensureLabel` exactly as an unusable `br` binary did before this change.
 */
function resolveTrackerAdapter() {
  const projectRoot = process.cwd();
  const env = process.env;
  const resolved = resolveCategory('tracker', { projectRoot, env, detect: detectAdapter });
  const loaded = loadAdapter(resolved.value, { projectRoot, env, interactive: false });
  return { manifest: loaded.manifest };
}

/** Raise a failed runner envelope as a thrown `Error` (the same shape `execFileSync` used to throw). */
function raiseOnFailure(result) {
  const err = new Error(result.error.message);
  err.code = result.error.code;
  throw err;
}

/**
 * Stand-in for `br`, routed through the toolchain runner's `tracker.list`/`tracker.label`
 * capabilities (TRD-025) instead of spawning `br` directly. Keeps `runBr`'s original argv-in/
 * JSON-string-out contract so `ensureLabel` below needs no change: `args` is the same raw `br`
 * argv shape `ensureLabel` already builds (`['list', ...]` / `['label', 'add', ...]`).
 *
 * `tracker.label`'s adapter run template has exactly one `${ids}` placeholder -- one argv
 * element, never split into several (`runner.js#buildArgv`'s own header) -- so it can only
 * ever label ONE issue per call; a batch therefore calls it once per id, discarding each call's
 * return value (the `label add` calls below already discard `run(...)`'s return value, same as
 * before this change). The outer `IDS_PER_CALL` batching in `ensureLabel` is unchanged: it
 * still bounds how many ids this function is asked to label in one `runBr` call.
 *
 * @param {string[]} args e.g. `['list', '--all', '--limit', '0', '--json']` or
 *   `['label', 'add', <id>, ..., '-l', <label>, '--json']`
 * @returns {string} raw JSON text (only the `list` call's text is read by `ensureLabel`)
 */
function runBr(args) {
  const { manifest } = resolveTrackerAdapter();
  const execFileOptions = { cwd: process.cwd() };
  // Synchronous: killed-on-timeout containment is direct-child-only, never a detached
  // descendant (runner.js's "## runCapabilitySync" header section) -- acceptable for both
  // calls below since `br list`/`br label add` are short, one-shot invocations.

  if (args[0] === 'list') {
    const result = runCapabilitySync(manifest, 'tracker.list', {}, { timeoutMs: 60000, execFileOptions });
    if (!result.ok) raiseOnFailure(result);
    return result.data;
  }

  if (args[0] === 'label' && args[1] === 'add') {
    const flagAt = args.indexOf('-l');
    const ids = args.slice(2, flagAt);
    const labels = args[flagAt + 1];
    let data = '';
    for (const id of ids) {
      const result = runCapabilitySync(manifest, 'tracker.label', { ids: id, labels }, { timeoutMs: 60000, execFileOptions });
      if (!result.ok) raiseOnFailure(result);
      data = result.data;
    }
    return data;
  }

  throw new Error(`beads-label: runBr does not know how to route 'br ${args.join(' ')}' through the tracker runner`);
}

/**
 * Does `title` belong to the scope entry `match`? A TRD scope entry such as "[trd:foo" (no
 * closing delimiter) must not match the beads of a sibling TRD "[trd:foo-v2]", so it has to be
 * followed by `]`, `:` or the end of the title. Any other entry (a TRD entry that already ends
 * with `]` or `:`, or a non-TRD entry) is a plain substring match.
 */
function titleMatches(title, match) {
  if (!match.startsWith('[trd:') || /[\]:]$/.test(match)) return title.includes(match);
  for (let at = title.indexOf(match); at !== -1; at = title.indexOf(match, at + 1)) {
    const next = title[at + match.length];
    if (next === undefined || next === ']' || next === ':') return true;
  }
  return false;
}

/**
 * @param {{label: string, match: string}} opts  match = substring of the TRD's bead titles, e.g. "[trd:<slug>"
 * @param {(args: string[]) => string} [run]     stand-in for `br`, for tests
 * @returns {{label: string, matched: number, labeled: number, already: number}}
 */
function ensureLabel({ label, match } = {}, run = runBr) {
  if (!label || !match) throw new Error('beads-label needs --label and --match');

  const mine = issuesOf(JSON.parse(run(['list', '--all', '--limit', '0', '--json']))).filter((b) =>
    titleMatches(String(b.title || ''), match)
  );
  const missing = mine.filter((b) => !(Array.isArray(b.labels) && b.labels.includes(label)));

  for (let i = 0; i < missing.length; i += IDS_PER_CALL) {
    run(['label', 'add', ...missing.slice(i, i + IDS_PER_CALL).map((b) => b.id), '-l', label, '--json']);
  }
  return { label, matched: mine.length, labeled: missing.length, already: mine.length - missing.length };
}

module.exports = { ensureLabel, titleMatches };
