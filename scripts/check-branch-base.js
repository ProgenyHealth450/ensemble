#!/usr/bin/env node
/**
 * Refuses work published from a branch that is behind its upstream.
 *
 * ONE implementation, two callers: `.githooks/pre-push` for two-second
 * feedback at the keyboard, and CI for the check nobody can skip. They must
 * not be separate implementations — two copies of a rule are two rules, and
 * the day they disagree is the day people stop trusting both.
 *
 * Why this exists: during the behavior-runtime work an agent reported "done,
 * 20 commits, tree clean" across several turns while the branch was 17
 * commits behind origin. Every check run was true locally and untested
 * against what was actually on the branch. It surfaced only by accident. A
 * PR opened at that moment would have been reviewed against a stale base.
 *
 * Exit 0 = proceed. Exit 1 = refuse. Exit 2 = could not determine.
 *
 * "Could not determine" is deliberately NOT exit 0. An unverifiable state
 * resolving to "therefore allow" is the exact defect br-dowt recorded, and
 * it is worth being annoying about.
 */

const { execFileSync } = require("node:child_process");

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

function fail(message, code = 1) {
  process.stderr.write(`\n  ${message}\n\n`);
  process.exit(code);
}

function resolveBase(branch) {
  // An explicit base is REQUIRED in CI and optional locally.
  //
  // Locally, `@{u}` is the right question: "am I behind what I last pushed
  // plus whatever others have added to my branch?"
  //
  // In CI it is the WRONG question, and silently so. A PR checkout's
  // upstream is `origin/<the same branch>`, so `@{u}...HEAD` is 0/0 and the
  // check passes without comparing anything — a green tick that verified
  // nothing. Verified by running this script in a `--depth 1` clone: exit 0,
  // counts `0 0`. CI must name the branch it intends to merge INTO.
  const flag = process.argv.indexOf("--base");
  if (flag !== -1) {
    const base = process.argv[flag + 1];
    if (!base) fail("--base was given without a value.", 2);
    const resolved = git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`], { allowFailure: true });
    if (!resolved) {
      fail(
        `base ref "${base}" is not present in this checkout.\n\n` +
          `  A shallow clone will not have it. In GitHub Actions use:\n` +
          `    - uses: actions/checkout@v4\n` +
          `      with: { fetch-depth: 0 }\n` +
          `  or fetch it explicitly:  git fetch --no-tags origin ${base.replace(/^origin\//, "")}`,
        2,
      );
    }
    return base;
  }

  const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { allowFailure: true });
  if (!upstream) {
    // A brand-new branch that has never been pushed has no upstream. That is
    // normal and not a staleness problem.
    process.exit(0);
  }
  return upstream;
}

function main() {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true });
  if (!branch) fail("not a git repository, or no commits yet — cannot check the branch base.", 2);
  if (branch === "HEAD" && process.argv.indexOf("--base") === -1) {
    // Detached HEAD has no upstream to be behind. Nothing to check, and
    // refusing would block legitimate detached workflows like a bisect.
    // With an explicit --base there IS a meaningful question, so continue.
    process.exit(0);
  }

  const upstream = resolveBase(branch);

  const counts = git(["rev-list", "--left-right", "--count", `${upstream}...HEAD`], { allowFailure: true });
  if (!counts) fail(`could not compare ${branch} against ${upstream}. Try: git fetch`, 2);

  const [behindRaw, aheadRaw] = counts.split(/\s+/);
  const behind = Number(behindRaw);
  const ahead = Number(aheadRaw);
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) {
    fail(`could not parse the ahead/behind counts for ${branch} (${counts}).`, 2);
  }

  if (behind === 0) {
    process.exit(0);
  }

  const commits = git(["log", "--oneline", `HEAD..${upstream}`], { allowFailure: true }) || "";
  const preview = commits.split("\n").filter(Boolean).slice(0, 5);
  const more = behind > preview.length ? `\n  ... and ${behind - preview.length} more` : "";

  fail(
    `${branch} is ${behind} commit(s) behind ${upstream}` +
      (ahead ? ` (and ${ahead} ahead)` : "") +
      `.\n\n  Work reviewed from a stale base has been verified against something` +
      `\n  other than what is on the branch.\n\n  Missing:\n  ${preview.join("\n  ")}${more}` +
      `\n\n  Fix:   git pull --rebase` +
      `\n  Skip:  git push --no-verify   (local hook only; CI still checks)`,
  );
}

main();
