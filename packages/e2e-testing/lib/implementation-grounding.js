'use strict';

/**
 * TRD-004: implementation-grounding lookup for /ensemble:author-playwright-tests.
 *
 * Given a REQ-NNN and a TRD path, resolves the real code that satisfies that
 * REQ so a later interactive session can ground a proposed Playwright test in
 * the actual implementing diff rather than PRD prose alone:
 *
 *   1. Parse the TRD (via the existing packages/development/lib/trd-cli.js
 *      `parse` subcommand — reused, not re-implemented) to get `tasksById`.
 *   2. Find the task(s) whose `satisfies` includes the REQ.
 *   3. For each task's `targetFiles`, get that file's git diff on the current
 *      branch vs. its merge-base with main/origin main.
 *
 * Implementation AC (TRD-004): a REQ whose implementing files can't be
 * located never silently returns nothing and never throws — it reports an
 * explicit grounding gap instead. Every early-exit path below returns a
 * `{grounded: false, gap: true, reason}` result rather than throwing.
 *
 * Follows the injectable-exec convention from ./pr-state.js so the sibling
 * TRD-004-TEST task can stub git / trd-cli / file-system calls.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_TRD_CLI_PATH = path.resolve(__dirname, '../../development/lib/trd-cli.js');
const DEFAULT_BASE_BRANCH_CANDIDATES = ['main', 'origin/main'];

/** Default `git` invocation — swappable via `opts.gitExec` for tests. */
function defaultGitExec(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe' });
}

/**
 * Default TRD parse — shells out to the shared trd-cli.js `parse` subcommand
 * (reusing the existing deterministic parser) and returns its `trd` object.
 * Swappable via `opts.parseTrd` for tests (avoids spawning a real subprocess).
 */
function defaultParseTrd(trdPath, opts) {
  const trdCliPath = (opts && opts.trdCliPath) || DEFAULT_TRD_CLI_PATH;
  let raw;
  try {
    raw = execFileSync(process.execPath, [trdCliPath, 'parse', trdPath], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (err) {
    // trd-cli.js always writes {"error": "..."} to stdout even on its
    // non-zero-exit failure paths — prefer that specific message over the
    // generic "Command failed" wrapper execFileSync throws.
    raw = err.stdout;
    if (!raw) throw err;
  }
  const result = JSON.parse(raw);
  if (result.error) {
    throw new Error(result.error);
  }
  return result.trd;
}

/** Build the standard "grounding gap" result shape. Never throw — always this instead. */
function gap(reqId, trdPath, reason) {
  return { grounded: false, gap: true, reqId, trdPath, reason };
}

/**
 * Resolve the merge-base SHA of HEAD against the first reachable candidate
 * branch (opts.baseBranch if given, else 'main' then 'origin/main').
 * Returns null (never throws) if none of the candidates resolve.
 */
function resolveMergeBase(gitExec, baseBranch) {
  const candidates = baseBranch ? [baseBranch] : DEFAULT_BASE_BRANCH_CANDIDATES;
  for (const branch of candidates) {
    try {
      const sha = gitExec(['merge-base', 'HEAD', branch]).trim();
      if (sha) return { branch, sha };
    } catch {
      // branch doesn't exist locally / no merge-base — try the next candidate
    }
  }
  return null;
}

/** Diff a single file between the merge-base SHA and HEAD. Returns null (not throw) on git failure. */
function diffFile(gitExec, mergeBaseSha, file) {
  try {
    return gitExec(['diff', mergeBaseSha, 'HEAD', '--', file]);
  } catch {
    return null;
  }
}

/**
 * Ground a REQ in its real implementing code.
 *
 * @param {string} reqId - e.g. "REQ-002"
 * @param {string} trdPath - path to the TRD markdown file
 * @param {object} [opts]
 * @param {(args: string[]) => string} [opts.gitExec] - injectable git runner
 * @param {(trdPath: string, opts: object) => object} [opts.parseTrd] - injectable TRD parser
 * @param {(p: string) => boolean} [opts.existsSync] - injectable fs.existsSync
 * @param {string} [opts.trdCliPath] - override path to trd-cli.js (passed to the default parseTrd)
 * @param {string} [opts.baseBranch] - override the branch to merge-base against
 * @returns {{grounded: true, reqId: string, files: string[], diffs: Array<{file:string, diff:string}>, partialGaps: string[]}
 *          | {grounded: false, gap: true, reqId: string, trdPath: string, reason: string}}
 */
function groundImplementation(reqId, trdPath, opts = {}) {
  const gitExec = opts.gitExec || defaultGitExec;
  const parseTrd = opts.parseTrd || defaultParseTrd;
  const existsSync = opts.existsSync || fs.existsSync;

  if (!reqId) return gap(reqId, trdPath, 'No REQ id was provided');
  if (!trdPath) return gap(reqId, trdPath, 'No TRD path was provided');

  const normalizedReqId = String(reqId).toUpperCase();

  let trd;
  try {
    trd = parseTrd(trdPath, opts);
  } catch (err) {
    return gap(reqId, trdPath, `Failed to parse TRD '${trdPath}': ${err.message}`);
  }

  const tasksById = (trd && trd.tasksById) || {};
  const matchingTasks = Object.values(tasksById).filter(
    (task) => Array.isArray(task.satisfies) && task.satisfies.includes(normalizedReqId)
  );

  if (matchingTasks.length === 0) {
    return gap(reqId, trdPath, `No task in '${trdPath}' satisfies ${normalizedReqId}`);
  }

  const targetFiles = [];
  for (const task of matchingTasks) {
    for (const file of task.targetFiles || []) {
      if (!targetFiles.includes(file)) targetFiles.push(file);
    }
  }

  if (targetFiles.length === 0) {
    const taskIds = matchingTasks.map((t) => t.id).join(', ');
    return gap(reqId, trdPath, `${normalizedReqId} maps to task(s) ${taskIds} but none declare Target Files`);
  }

  const mergeBase = resolveMergeBase(gitExec, opts.baseBranch);
  if (!mergeBase) {
    return gap(reqId, trdPath, 'Could not resolve a merge-base branch (main/origin/main) to diff against');
  }

  const diffs = [];
  const ungrounded = [];

  for (const file of targetFiles) {
    if (!existsSync(file)) {
      ungrounded.push(`${file} (not found on disk)`);
      continue;
    }
    const diff = diffFile(gitExec, mergeBase.sha, file);
    if (diff === null) {
      ungrounded.push(`${file} (git diff failed)`);
      continue;
    }
    if (diff.trim() === '') {
      ungrounded.push(`${file} (no diff vs ${mergeBase.branch} — never touched)`);
      continue;
    }
    diffs.push({ file, diff });
  }

  if (diffs.length === 0) {
    return gap(
      reqId,
      trdPath,
      `All target file(s) for ${normalizedReqId} are ungrounded: ${ungrounded.join('; ')}`
    );
  }

  return {
    grounded: true,
    reqId: normalizedReqId,
    files: diffs.map((d) => d.file),
    diffs,
    // Files that were listed as Target Files but couldn't be grounded even
    // though the REQ overall was — surfaced rather than silently dropped.
    partialGaps: ungrounded,
  };
}

module.exports = {
  groundImplementation,
  // exported for unit testing of the helpers
  resolveMergeBase,
  diffFile,
  DEFAULT_TRD_CLI_PATH,
};
