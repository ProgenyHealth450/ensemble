/**
 * Fail-closed verification (REQ-SAFE-006).
 *
 * The requirement is unusually specific about what must NOT be accepted, and
 * each clause traces to something that actually happened:
 *
 *   zero tests        `npx jest live-e2e` run from the wrong directory matched
 *                     zero tests and exited 0. A bare exit-code check reads
 *                     that as a pass and rubber-stamps any fix.
 *   unknown output    the model ran `npx jest 2>&1 | tail -60`; the pipeline's
 *                     exit status is `tail`'s, not the runner's.
 *   a defective runner
 *                     a suite that could not load — `require('../src/rounding')`,
 *                     absent — was counted in `2 passed, 2 total`, exit 0. The
 *                     same run's constitution amendment described that exact
 *                     defect. The verifier was fooled by an instrument the run
 *                     had just judged untrustworthy (br-gwww).
 *
 * So: structured adapters per framework, never one generic regex as the
 * authority; and a load-failure scan that can override a reported pass. The
 * scan is deliberately allowed to contradict the runner, because a runner that
 * reports a suite it never executed as passing is not a source of truth about
 * that suite.
 */

export type VerificationStatus = "passed" | "failed" | "inconclusive";

export interface VerificationResult {
  readonly status: VerificationStatus;
  readonly detail: string;
  /** Framework the output was attributed to, or `unknown`. */
  readonly framework: string;
  readonly total?: number;
  readonly failed?: number;
  readonly passed?: number;
  /** Suites the output shows as unloadable, even if the runner called them passed. */
  readonly unloadableSuites: readonly string[];
}

export interface RunnerOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** True when the command could not be started at all. */
  readonly spawnFailed?: boolean;
}

interface Counts {
  readonly total: number;
  readonly failed: number;
  readonly passed: number;
}

interface FrameworkAdapter {
  readonly name: string;
  /** Returns counts when this adapter recognises the output, else undefined. */
  parse(text: string): Counts | undefined;
}

const JEST: FrameworkAdapter = {
  name: "jest",
  parse(text) {
    // Jest prints a `Tests:` summary PER RUN, and `npm test` across workspaces
    // runs it once per workspace, so every summary is summed. Reading only the
    // first graded a monorepo by whichever workspace printed first: a failure
    // in a later one surfaced as an unattributed non-zero exit rather than as
    // the failed test it was (4f1b1f0). Matching the labelled line, anchored
    // to a line start, avoids attributing another tool's output -- or a test
    // NAMED "Tests: ..." -- to jest.
    let counts: Counts | undefined;
    for (const [, line] of text.matchAll(/^[ \t]*Tests:[ \t]+(.+)$/gm)) {
      const total = /(\d+)\s+total/.exec(line);
      if (!total) continue;
      const failed = /(\d+)\s+failed/.exec(line);
      const passed = /(\d+)\s+passed/.exec(line);
      counts = {
        total: (counts?.total ?? 0) + Number(total[1]),
        failed: (counts?.failed ?? 0) + (failed ? Number(failed[1]) : 0),
        passed: (counts?.passed ?? 0) + (passed ? Number(passed[1]) : 0),
      };
    }
    return counts;
  },
};

const PYTEST: FrameworkAdapter = {
  name: "pytest",
  parse(text) {
    const summary = /=+\s*(.*?(?:passed|failed|error|no tests ran).*?)\s*=+/gi;
    let last: string | undefined;
    for (const match of text.matchAll(summary)) last = match[1];
    if (!last) return undefined;
    if (/no tests ran/i.test(last)) return { total: 0, failed: 0, passed: 0 };
    const failed = /(\d+)\s+failed/.exec(last);
    const errors = /(\d+)\s+error/.exec(last);
    const passed = /(\d+)\s+passed/.exec(last);
    const failures = (failed ? Number(failed[1]) : 0) + (errors ? Number(errors[1]) : 0);
    const passes = passed ? Number(passed[1]) : 0;
    return { total: failures + passes, failed: failures, passed: passes };
  },
};

const MIX: FrameworkAdapter = {
  name: "mix-test",
  parse(text) {
    const line = /(\d+)\s+tests?,\s+(\d+)\s+failures?/.exec(text);
    if (!line) return undefined;
    const total = Number(line[1]);
    const failed = Number(line[2]);
    return { total, failed, passed: total - failed };
  },
};

const GO: FrameworkAdapter = {
  name: "go-test",
  parse(text) {
    if (!/^(ok|FAIL|---\s+(PASS|FAIL))/m.test(text)) return undefined;
    const failures = [...text.matchAll(/^---\s+FAIL/gm)].length;
    const passes = [...text.matchAll(/^---\s+PASS/gm)].length;
    if (failures + passes === 0) {
      // `ok  pkg  0.1s` with no test lines means the package ran and had
      // tests; `no test files` means it had none.
      if (/no test files/i.test(text)) return { total: 0, failed: 0, passed: 0 };
      return undefined;
    }
    return { total: failures + passes, failed: failures, passed: passes };
  },
};

const CARGO: FrameworkAdapter = {
  name: "cargo-test",
  parse(text) {
    const line = /test result:\s+\w+\.\s+(\d+)\s+passed;\s+(\d+)\s+failed/.exec(text);
    if (!line) return undefined;
    const passed = Number(line[1]);
    const failed = Number(line[2]);
    return { total: passed + failed, failed, passed };
  },
};

export const FRAMEWORK_ADAPTERS: readonly FrameworkAdapter[] = [JEST, PYTEST, MIX, GO, CARGO];

/**
 * Phrases that mean a suite was counted without being executed.
 *
 * Kept narrow on purpose. A broad pattern would fire on any test whose own
 * assertion message mentions a missing module, turning every legitimate pass
 * into `inconclusive` and training operators to ignore the signal.
 */
const UNLOADABLE_PATTERNS: readonly RegExp[] = [
  /^\s*(?:●\s+)?(?:Test suite failed to run|suite did not load)/gim,
  /Cannot find module ['"]([^'"]+)['"]/g,
  /ModuleNotFoundError: No module named ['"]([^'"]+)['"]/g,
  /ImportError while importing test module ['"]?([^'"\n]+)['"]?/g,
  /error: could not compile/gi,
  // Elixir prints the whole phrase inside the parens -- `(module Rounding is
  // not available)` -- so requiring `)` before "is not available" never
  // matched real output, leaving the mix adapter with no load-failure signal.
  /\(module\s+(\S+)\s+is not available\)/g,
];

/**
 * Phrases by which a runner or wrapper announces it did not run part of the
 * suite.
 *
 * Deliberately requires an explicit statement rather than inferring from
 * counts. A suite that legitimately contains zero tests in one project is
 * normal; a run that SAYS it skipped something has told us its coverage is
 * partial, and that is a different and much stronger signal.
 *
 * Anchored to whole lines so a test named "skipping empty input" in someone's
 * output cannot trip it.
 */
const ANNOUNCED_SKIP_PATTERNS: readonly RegExp[] = [
  // packages/router when pytest is absent and CI is unset (br-91nr).
  /^\s*Skipping\s+\w+\s+tests?\b.*$/gim,
  /^\s*Skipped\s+\w+\s+tests?\b.*$/gim,
  /^\s*No\s+\w+\s+tests?\s+to\s+run\b.*$/gim,
];

/** Lines in which the run declared it skipped part of the suite. */
export function findAnnouncedSkips(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of ANNOUNCED_SKIP_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const line = match[0].trim();
      if (line) found.add(line);
    }
  }
  return [...found];
}

export function findUnloadableSuites(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of UNLOADABLE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      found.add((match[1] ?? match[0]).trim());
    }
  }
  return [...found].sort();
}

/**
 * Names the failing test files (b64ad4b). A count says the candidate broke
 * something; the file says what, which is what the reviewer of a proposal
 * needs to tell a real regression from an unrelated flake.
 */
function failingFiles(text: string, max = 5): string {
  const files = [...new Set([...text.matchAll(/^[ \t]*FAIL[ \t]+(\S+)/gm)].map((m) => m[1]))];
  if (files.length === 0) return "";
  const more = files.length > max ? ` (+${files.length - max} more)` : "";
  return `; failing: ${files.slice(0, max).join(", ")}${more}`;
}

/**
 * Names what failed when no test did (2896e8f). `npm test` across workspaces
 * reports the failing workspace as `npm error workspace ...` / `npm error
 * path ...`; anything else falls back to the last stderr line. Without it the
 * detail shows only passing counts -- observed on dev, a missing pytest under
 * CI=true read as "the fix broke something".
 */
function failureHint(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const npm = lines.filter((l) => /^npm error (workspace|path) /.test(l));
  const hint = (npm.length > 0 ? npm : lines.slice(-1)).join("; ").slice(0, 300);
  return hint ? `; stderr: ${hint}` : "";
}

export interface VerifyInput extends RunnerOutput {
  /** The command that produced this output, for the detail line. */
  readonly command: string;
  /**
   * Suite count from a previous run of the same command, when known. A drop
   * means suites stopped being collected, which a pass count alone hides.
   */
  readonly previousTotal?: number;
}

export function verifyOutput(input: VerifyInput): VerificationResult {
  const text = `${input.stdout}\n${input.stderr}`;
  const unloadableSuites = findUnloadableSuites(text);

  if (input.spawnFailed) {
    return {
      status: "inconclusive",
      detail: `the verification command could not be started: ${input.command}`,
      framework: "unknown",
      unloadableSuites,
    };
  }

  if (input.timedOut) {
    // A timeout is not a failure of the code under test and must not be
    // reported as one; it is an absence of evidence.
    return {
      status: "inconclusive",
      detail: `verification timed out before the suite reported: ${input.command}`,
      framework: "unknown",
      unloadableSuites,
    };
  }

  // A wrapper that ANNOUNCES it skipped part of the suite has not verified
  // that part, whatever it exits with (br-91nr).
  //
  // Concretely: `packages/router` prints "Skipping Python tests" and exits 0
  // when pytest is absent and CI is unset. Nothing downstream could tell that
  // from a real pass, because the JS half of the same run reports perfectly
  // good counts and an adapter matches them happily. The skip is upstream of
  // the framework adapters, so it must be checked before them.
  const announcedSkips = findAnnouncedSkips(text);
  if (announcedSkips.length > 0) {
    return {
      status: "inconclusive",
      detail:
        `the run announced it skipped part of the suite (${announcedSkips.join("; ")}), ` +
        `so a pass covers only what actually ran: ${input.command}`,
      framework: "unknown",
      unloadableSuites,
    };
  }

  let counts: Counts | undefined;
  let framework = "unknown";
  for (const adapter of FRAMEWORK_ADAPTERS) {
    const parsed = adapter.parse(text);
    if (parsed) {
      counts = parsed;
      framework = adapter.name;
      break;
    }
  }

  if (!counts) {
    // No adapter recognised the output, so nothing can be attributed. The exit
    // code is explicitly not consulted here: a zero exit from an unrecognised
    // command is the "wrong directory / piped through tail" case.
    return {
      status: "inconclusive",
      detail:
        `no supported test framework recognised the output of \`${input.command}\` ` +
        `(exit ${String(input.exitCode)}); a result that cannot be attributed is not a pass`,
      framework,
      unloadableSuites,
    };
  }

  if (counts.total === 0) {
    return {
      status: "inconclusive",
      detail: `\`${input.command}\` ran zero tests (${framework}); a zero-test run is not a pass`,
      framework,
      total: 0,
      failed: 0,
      passed: 0,
      unloadableSuites,
    };
  }

  if (counts.failed > 0) {
    return {
      status: "failed",
      detail: `${framework}: ${counts.passed} passed, ${counts.failed} failed, ${counts.total} total${failingFiles(text)}`,
      framework,
      ...counts,
      unloadableSuites,
    };
  }

  if (unloadableSuites.length > 0) {
    // br-gwww. The runner says every test passed; the output says a suite
    // never loaded. Both cannot be true, and the one that would let a broken
    // fix through is the one to disbelieve.
    return {
      status: "inconclusive",
      detail:
        `${framework} reported ${counts.passed}/${counts.total} passing, but the output shows ` +
        `suite(s) that could not be loaded: ${unloadableSuites.join(", ")}. ` +
        `A suite that never ran cannot have passed, so this run is not evidence.`,
      framework,
      ...counts,
      unloadableSuites,
    };
  }

  if (input.previousTotal !== undefined && counts.total < input.previousTotal) {
    // Suites stopped being collected between runs. The pass count went up
    // relative to the failures precisely because tests disappeared.
    return {
      status: "inconclusive",
      detail:
        `${framework} reported ${counts.total} test(s), down from ${input.previousTotal} on the ` +
        `previous run of the same command; tests stopped being collected, so a pass is not evidence`,
      framework,
      ...counts,
      unloadableSuites,
    };
  }

  if (input.exitCode !== 0) {
    // Counts say pass, the process disagreed. Something outside the assertions
    // failed and it has not been attributed.
    return {
      status: "inconclusive",
      detail:
        `${framework} reported ${counts.passed}/${counts.total} passing but the command exited ` +
        `${String(input.exitCode)}; the discrepancy is unattributed${failureHint(input.stderr)}`,
      framework,
      ...counts,
      unloadableSuites,
    };
  }

  return {
    status: "passed",
    detail: `${framework}: ${counts.passed} passed, ${counts.failed} failed, ${counts.total} total`,
    framework,
    ...counts,
    unloadableSuites,
  };
}
