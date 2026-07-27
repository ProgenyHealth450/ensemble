'use strict';

/**
 * REQ-001 trigger check for /ensemble:author-playwright-tests.
 *
 * A test-authoring session may only start once implement-trd-beads has
 * shipped a PR boundary for the target branch. TRD-003's original
 * `checkPrState()` shells out to `gh` (GitHub CLI) — fine for a
 * GitHub-hosted repo, but this TRD's own consuming repo (CRIBs) is hosted on
 * Azure DevOps Repos, where `gh pr list` cannot resolve anything at all.
 * `checkPrState()`'s exec-failure path silently returns `hasOpenPr: false`,
 * so an Azure-DevOps-hosted repo would permanently report "no open PR"
 * regardless of true PR state (TRD-031, v1.2.0).
 *
 * TRD-031 adds two things, additive only — `checkPrState()`'s own GitHub
 * behavior is untouched:
 *   1. `detectRepoHost(opts)` - classify the `origin` remote as
 *      'github' | 'azure-devops' | 'unknown', parsing
 *      {organization, project, repository} out of an Azure DevOps URL.
 *   2. `checkPrStateAdo(branch, prs)` - pure decision logic (no MCP client
 *      here — Azure DevOps MCP tools are only invocable by the orchestrating
 *      agent at conversation time, matching ado-test-suite.js's/
 *      ado-test-case-sync.js's established boundary) that normalizes an
 *      already-fetched Azure DevOps PR list into the exact same
 *      {hasOpenPr, state, url, number, baseBranch} shape checkPrState()
 *      returns for GitHub, so nothing downstream needs to know which host
 *      produced it.
 *
 * The orchestrator (author-playwright-tests.yaml) calls detectRepoHost()
 * first, then either checkPrState() (github/unknown) or an Azure DevOps MCP
 * PR-list call followed by checkPrStateAdo() (azure-devops).
 *
 * Both functions also surface `baseBranch` (the PR's real target/base
 * branch) so the orchestrator can pass it to implementation-grounding.js's
 * `groundImplementation(reqId, trdPath, {baseBranch})` instead of letting
 * that module fall back to its hardcoded main/origin-main default — a repo
 * like CRIBs, where feature branches target `integration` rather than
 * `main`, would otherwise ground against the wrong branch entirely. Found
 * live-dogfooding this feature against a real CRIBs PR, where a manual diff
 * against `main` pulled in unrelated already-integrated work as if it
 * belonged to the PR under test.
 *
 * checkPrStateAdo() also accepts the Azure DevOps MCP server's numeric
 * `status` representation, not just the raw REST API's string form — see
 * `isAdoStatusActive()` below.
 */

const { execFileSync } = require('child_process');

const NO_OPEN_PR_MESSAGE =
  'No open PR found for this branch. Run `/ensemble:implement-trd-beads` first ' +
  'to ship a PR boundary before starting an author-playwright-tests session.';

/** Default `gh` invocation — swappable via the `exec` option for tests. */
function defaultExec(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: 'pipe' });
}

/** Default `origin` remote-URL lookup — swappable via `opts.gitExec` for tests. */
function defaultGitExec() {
  return execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: 'pipe' });
}

// https://dev.azure.com/<org>/<project>/_git/<repo>, optionally with a
// "user@" prefix and/or a trailing ".git" — the modern ADO Repos URL shape.
const AZURE_DEVOPS_MODERN_RE = /dev\.azure\.com\/(?:[^/@]+@)?([^/]+)\/([^/]+)\/_git\/([^/]+?)(?:\.git)?\/?$/i;
// https://<org>.visualstudio.com/<project>/_git/<repo> — the legacy ADO URL shape.
const AZURE_DEVOPS_LEGACY_RE = /([^/.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+?)(?:\.git)?\/?$/i;

/**
 * Classify the repo's `origin` remote by git host, so the orchestrator knows
 * whether to use `checkPrState()` (GitHub) or an Azure DevOps MCP PR-list
 * call + `checkPrStateAdo()`. Never throws — an unresolvable remote is
 * `{host: 'unknown', remoteUrl: null}`, not an exception.
 *
 * @param {object} [opts]
 * @param {() => string} [opts.gitExec] - injectable `git remote get-url origin` runner
 * @returns {{host: 'github', remoteUrl: string}
 *          |{host: 'azure-devops', remoteUrl: string, organization: string, project: string, repository: string}
 *          |{host: 'unknown', remoteUrl: string|null}}
 */
function detectRepoHost(opts = {}) {
  const gitExec = opts.gitExec || defaultGitExec;

  let remoteUrl;
  try {
    remoteUrl = String(gitExec()).trim();
  } catch {
    return { host: 'unknown', remoteUrl: null };
  }
  if (!remoteUrl) {
    return { host: 'unknown', remoteUrl: null };
  }

  if (/github\.com/i.test(remoteUrl)) {
    return { host: 'github', remoteUrl };
  }

  const modernMatch = remoteUrl.match(AZURE_DEVOPS_MODERN_RE);
  if (modernMatch) {
    return {
      host: 'azure-devops',
      remoteUrl,
      organization: modernMatch[1],
      project: decodeURIComponent(modernMatch[2]),
      repository: decodeURIComponent(modernMatch[3]),
    };
  }

  const legacyMatch = remoteUrl.match(AZURE_DEVOPS_LEGACY_RE);
  if (legacyMatch) {
    return {
      host: 'azure-devops',
      remoteUrl,
      organization: legacyMatch[1],
      project: decodeURIComponent(legacyMatch[2]),
      repository: decodeURIComponent(legacyMatch[3]),
    };
  }

  return { host: 'unknown', remoteUrl };
}

/**
 * Check whether an open PR exists for the given branch (GitHub, via `gh`).
 *
 * `baseBranch` is surfaced so callers (e.g. author-playwright-tests.yaml's
 * implementation-grounding step) can diff against the PR's real target
 * branch instead of guessing main/origin-main — see implementation-grounding.js's
 * own `opts.baseBranch`.
 *
 * @param {string} branch - branch name to check (e.g. current git branch)
 * @param {object} [opts]
 * @param {(args: string[]) => string} [opts.exec] - injectable `gh` invocation, returns raw stdout
 * @returns {{hasOpenPr: boolean, state: string|null, url: string|null, number: number|null, baseBranch: string|null}}
 */
function checkPrState(branch, opts = {}) {
  const exec = opts.exec || defaultExec;
  const args = ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,state,url,baseRefName'];

  let raw;
  try {
    raw = exec(args);
  } catch {
    // gh missing, unauthenticated, no repo, network error, etc. — no PR to find.
    return { hasOpenPr: false, state: null, url: null, number: null, baseBranch: null };
  }

  let prs;
  try {
    prs = JSON.parse(raw);
  } catch {
    return { hasOpenPr: false, state: null, url: null, number: null, baseBranch: null };
  }

  if (!Array.isArray(prs) || prs.length === 0) {
    return { hasOpenPr: false, state: null, url: null, number: null, baseBranch: null };
  }

  const pr = prs[0];
  return {
    hasOpenPr: true,
    state: pr.state || 'OPEN',
    url: pr.url || null,
    number: typeof pr.number === 'number' ? pr.number : null,
    baseBranch: pr.baseRefName || null,
  };
}

/**
 * True when an Azure DevOps PR `status` value means "active", regardless of
 * which representation the caller sent it in. The raw Azure DevOps REST API
 * returns `status` as the string `"active"`, but the Azure DevOps MCP server
 * observed in practice serializes it as the underlying .NET
 * `PullRequestStatus` enum's numeric ordinal instead (`1` = Active; `0` =
 * NotSet, `2` = Abandoned, `3` = Completed) — a real repo's live PR list came
 * back as `status: 1`, which the string-only check below used to miss
 * entirely, always reporting `hasOpenPr: false` regardless of branch match.
 */
function isAdoStatusActive(status) {
  if (typeof status === 'number') return status === 1;
  if (typeof status === 'string') return status.toLowerCase() === 'active';
  return false;
}

/**
 * Check whether an open PR exists for the given branch, given a PR list the
 * orchestrator already fetched from the Azure DevOps MCP server (e.g. its
 * `repo_list_pull_requests_by_repo_or_project`-equivalent tool). Pure — no
 * MCP client here, matching ado-test-suite.js's/ado-test-case-sync.js's
 * established boundary. Returns the exact same shape `checkPrState()` does.
 *
 * Azure DevOps PR resource fields used: `status` (see `isAdoStatusActive()`
 * for the string/numeric representations accepted), `sourceRefName` (e.g.
 * "refs/heads/feature/x"), `targetRefName` (surfaced as `baseBranch`, stripped
 * of its `refs/heads/` prefix), `pullRequestId`, `url`.
 *
 * @param {string} branch - branch name to check (e.g. current git branch)
 * @param {Array<object>} prs - already-fetched Azure DevOps PR objects
 * @returns {{hasOpenPr: boolean, state: string|null, url: string|null, number: number|null, baseBranch: string|null}}
 */
function checkPrStateAdo(branch, prs) {
  const list = Array.isArray(prs) ? prs : [];
  const targetRef = `refs/heads/${branch}`;

  const match = list.find(
    (pr) => pr && isAdoStatusActive(pr.status) && pr.sourceRefName === targetRef
  );

  if (!match) {
    return { hasOpenPr: false, state: null, url: null, number: null, baseBranch: null };
  }

  return {
    hasOpenPr: true,
    state: 'active',
    url: match.url || null,
    number: typeof match.pullRequestId === 'number' ? match.pullRequestId : null,
    baseBranch:
      typeof match.targetRefName === 'string'
        ? match.targetRefName.replace(/^refs\/heads\//, '')
        : null,
  };
}

module.exports = {
  checkPrState,
  checkPrStateAdo,
  detectRepoHost,
  NO_OPEN_PR_MESSAGE,
  // exported for unit testing of the helper
  isAdoStatusActive,
};
