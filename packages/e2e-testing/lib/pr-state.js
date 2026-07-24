'use strict';

/**
 * REQ-001 trigger check for /ensemble:author-playwright-tests.
 *
 * A test-authoring session may only start once implement-trd-beads has
 * shipped a PR boundary for the target branch — shells out to `gh` (this
 * repo's convention, see packages/git/skills/git-town for other `gh pr`
 * usage) rather than hand-rolling a GitHub API client.
 */

const { execFileSync } = require('child_process');

const NO_OPEN_PR_MESSAGE =
  'No open PR found for this branch. Run `/ensemble:implement-trd-beads` first ' +
  'to ship a PR boundary before starting an author-playwright-tests session.';

/** Default `gh` invocation — swappable via the `exec` option for tests. */
function defaultExec(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: 'pipe' });
}

/**
 * Check whether an open PR exists for the given branch.
 *
 * @param {string} branch - branch name to check (e.g. current git branch)
 * @param {object} [opts]
 * @param {(args: string[]) => string} [opts.exec] - injectable `gh` invocation, returns raw stdout
 * @returns {{hasOpenPr: boolean, state: string|null, url: string|null, number: number|null}}
 */
function checkPrState(branch, opts = {}) {
  const exec = opts.exec || defaultExec;
  const args = ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,state,url'];

  let raw;
  try {
    raw = exec(args);
  } catch {
    // gh missing, unauthenticated, no repo, network error, etc. — no PR to find.
    return { hasOpenPr: false, state: null, url: null, number: null };
  }

  let prs;
  try {
    prs = JSON.parse(raw);
  } catch {
    return { hasOpenPr: false, state: null, url: null, number: null };
  }

  if (!Array.isArray(prs) || prs.length === 0) {
    return { hasOpenPr: false, state: null, url: null, number: null };
  }

  const pr = prs[0];
  return {
    hasOpenPr: true,
    state: pr.state || 'OPEN',
    url: pr.url || null,
    number: typeof pr.number === 'number' ? pr.number : null,
  };
}

module.exports = { checkPrState, NO_OPEN_PR_MESSAGE };
