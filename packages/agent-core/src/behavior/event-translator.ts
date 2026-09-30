import { normalizeEvent } from "../normalize";
import type { BehaviorEvent } from "../events";

/**
 * Derives semantic events from raw runtime events (TRD-012 / REQ-002).
 *
 * A behavior triggers on `test.failure.observed`, but nothing in the
 * runtime ever emitted that type: Pi emits `runtime.tool_call.completed`
 * and no component turned one into the other, so a behavior with that
 * trigger could never fire in production no matter how correct its
 * manifest was. This module is that missing link.
 */

/** Commands treated as test runs when they fail. */
// Anchored with ^: these are matched against a command-position token
// sequence, never against the whole command line. See isTestCommand.
const TEST_COMMAND_PATTERNS: readonly RegExp[] = [
  /^npm\s+(run\s+)?test\b/,
  /^(\S*\/)?jest\b/,
  /^(\S*\/)?vitest\b/,
  /^(\S*\/)?pytest\b/,
  /^python\s+-m\s+pytest\b/,
  /^go\s+test\b/,
  /^cargo\s+test\b/,
  /^mix\s+test\b/,
  /^bun\s+test\b/,
  /^pnpm\s+(run\s+)?test\b/,
  /^yarn\s+test\b/,
];

/**
 * Evidence that a run reported a count of tests actually executed.
 *
 * Deliberately separate from the failure patterns. A run reporting
 * `Tests: 0 total` with exit code 0 matches no failure pattern and is not
 * `isError`, so before this it produced NO event at all — the single most
 * common local failure shape in this repo's own log (29 of 51 classifiable
 * failures) was invisible to the runtime.
 */
const TEST_COUNT_PATTERNS: readonly { readonly pattern: RegExp; readonly group: number }[] = [
  // jest / vitest: "Tests:       12 passed, 12 total"
  { pattern: /^\s*Tests:.*?\b(\d+)\s+total\b/m, group: 1 },
  // jest / vitest suites: "Test Suites: 3 passed, 3 total"
  { pattern: /^\s*Test Suites:.*?\b(\d+)\s+total\b/m, group: 1 },
  // pytest: "12 passed in 0.4s" / "no tests ran in 0.1s"
  { pattern: /\b(\d+)\s+passed\b/, group: 1 },
  // mix / ExUnit: "5 tests, 0 failures"
  { pattern: /\b(\d+)\s+tests?,\s+\d+\s+failures?\b/, group: 1 },
  // NOTE: go test has no count-based entry. `go test` prints "ok pkg 0.2s"
  // with no number, so there is nothing to read. Its empty case is caught
  // by NOTHING_RAN_PATTERNS ("no test files") instead. Do not add a count
  // pattern here for go without a real sample -- an invented one would
  // read some other number as a test count.
];

/** Phrases that state outright that nothing ran. */
const NOTHING_RAN_PATTERNS: readonly RegExp[] = [
  /\bno tests ran\b/i,
  /\bno tests found\b/i,
  /\[no test files\]/i,
  /\bno test files\b/i,
  /^\s*Tests:\s*0\s+total\b/m,
  /^\s*Test Suites:\s*0\s+total\b/m,
];

export interface TestVolume {
  /** Tests the run claims to have executed, when it said so at all. */
  readonly testsReported?: number;
  /** True when the output states outright that nothing ran. */
  readonly nothingRan: boolean;
  /** True when the run reported no count AND no explicit "nothing ran". */
  readonly silent: boolean;
}

/**
 * What a test run claims about its own volume.
 *
 * `silent` is its own case on purpose. "Reported zero" and "reported
 * nothing" are different facts, and collapsing them would let an unknown
 * runner's healthy output be read as a vacuous pass — which is the same
 * class of error in the opposite direction.
 */
export function readTestVolume(output: string): TestVolume {
  const nothingRan = NOTHING_RAN_PATTERNS.some((p) => p.test(output));
  for (const { pattern, group } of TEST_COUNT_PATTERNS) {
    const match = pattern.exec(output);
    if (match) {
      const count = Number(match[group]);
      if (Number.isFinite(count)) {
        return { testsReported: count, nothingRan: nothingRan || count === 0, silent: false };
      }
    }
  }
  return { nothingRan, silent: !nothingRan };
}

/** Shell operators that begin a new command. */
const SEGMENT_SPLIT = /(?:\|\||&&|;|\||\n)/;
/** Wrappers that delegate to the runner named after them. */
const WRAPPERS = new Set(["npx", "bunx", "sudo", "time", "env", "exec", "command"]);

/**
 * True when the command actually INVOKES a test runner.
 *
 * Substring matching was wrong and fired in production. Observed live: the
 * model ran
 *   `git status --short; ls tests src; cat src/live-math.ts; cat jest.config.* package.json`
 * and `/\bjest\b/` matched the FILENAME `jest.config.*`. That misclassified an
 * investigation command as a failing test run, queued a continuation for it,
 * and burned a retry from the budget on a command that runs no tests.
 *
 * So the runner must appear in COMMAND POSITION: the first token of some
 * shell segment, after stripping wrappers (npx, bunx, env VAR=1, ...) and
 * leading environment assignments. Mentioning a runner as an ARGUMENT --
 * `cat jest.config.js`, `grep jest package.json` -- is not an invocation.
 */
export function isTestCommand(command: string): boolean {
  return command
    .split(SEGMENT_SPLIT)
    .some((segment) => segmentInvokesRunner(segment));
}

/**
 * True when the command's exit status is the test runner's own.
 *
 * A shell reports the status of the LAST command it ran. When that is not
 * the runner, a non-zero status says nothing about the tests. Observed live,
 * twice: `npm test ... ; ls ../agent-core/*.tsbuildinfo` exited 2 from `ls`
 * with every suite passing, and `npm test > log; ...; grep failed log`
 * exited 1 because grep matched nothing -- both dispatched autofix against a
 * green suite. Output detection still covers those commands; this only stops
 * a stranger's exit status from being read as a test failure.
 */
export function exitStatusIsRunners(command: string): boolean {
  // Quoted text cannot end a command: `npx jest -t "a|b"` is one segment.
  const unquoted = command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "''");
  const segments = unquoted.split(SEGMENT_SPLIT).filter((s) => s.trim().length > 0);
  const last = segments[segments.length - 1];
  return last !== undefined && segmentInvokesRunner(last);
}

function segmentInvokesRunner(segment: string): boolean {
  let tokens = segment.trim().split(/\s+/).filter(Boolean);
  // Strip leading `VAR=value` assignments and known wrappers so that
  // `CI=1 npx jest` is recognised while `cat jest.config.js` is not.
  while (tokens.length > 0) {
    const head = tokens[0] as string;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head) || WRAPPERS.has(head)) {
      tokens = tokens.slice(1);
      continue;
    }
    break;
  }
  if (tokens.length === 0) return false;
  // Re-join so multi-word invocations (`go test`, `npm run test`) still match,
  // but anchor every pattern to the START of the command.
  const invocation = tokens.join(" ");
  return TEST_COMMAND_PATTERNS.some((pattern) => pattern.test(invocation));
}

/**
 * Output signatures that mean "a test run reported failures".
 *
 * Exit status alone is not a reliable failure signal. Observed live: the
 * model ran `npx jest live-e2e 2>&1 | tail -5`, and because a pipeline
 * reports the status of its LAST command, the tool result carried
 * isError=false for a suite that genuinely failed. No failure event fired
 * and autofix never started, while an otherwise identical run without the
 * pipe worked. Piping test output through tail/head/grep is ordinary model
 * behaviour, so detection cannot depend on the model avoiding it.
 *
 * Every pattern requires a NON-ZERO failure count. Matching a bare word
 * like "failed" would fire on the routine "Tests: 3 passed, 0 failed" and
 * on prose mentioning failure, which would be worse than missing the
 * failure: autofix would chase healthy suites.
 */
const FAILURE_OUTPUT_PATTERNS: readonly RegExp[] = [
  // jest / vitest summary: "Tests: 1 failed, 2 passed, 3 total"
  /^\s*Tests:.*?\b[1-9]\d*\s+failed\b/m,
  // jest / vitest suite summary: "Test Suites: 1 failed"
  /^\s*Test Suites:.*?\b[1-9]\d*\s+failed\b/m,
  // jest per-suite marker at line start: "FAIL tests/foo.test.ts"
  /^\s*FAIL\s+\S/m,
  // pytest: "1 failed, 2 passed" / "=== 3 failed ==="
  /\b[1-9]\d*\s+failed\b/,
  // pytest collection errors: "1 error in 0.1s"
  /^\s*=+\s.*\b[1-9]\d*\s+error(s)?\b.*=+\s*$/m,
  // go test: a line that is exactly FAIL, or "FAIL\tpkg"
  /^FAIL\b/m,
  // cargo: "test result: FAILED. 1 passed; 1 failed"
  /test result:\s*FAILED\b/,
  // mix test: "5 tests, 1 failure"
  /\b\d+\s+tests?,\s+[1-9]\d*\s+failures?\b/,
];

/**
 * True when output shows a test run that reported failures.
 *
 * Used ONLY for commands already identified as test runs, so a build log
 * or unrelated command mentioning "1 failed" cannot trigger a fix.
 */
export function outputReportsFailure(output: string): boolean {
  return FAILURE_OUTPUT_PATTERNS.some((pattern) => pattern.test(output));
}

/**
 * Commands that rewrite working-tree files, in command position.
 *
 * Not an attempt to catch every way a shell can write a file -- that is
 * impossible, and write-boundary-monitor.ts exists precisely because it is.
 * These are the shapes a mutation test actually takes.
 */
const MUTATION_INDICATORS: readonly RegExp[] = [
  /^sed\s+(-\S*\s+)*-\S*i/, // sed -i / sed -E -i
  /^perl\s+(-\S+\s*)*-\S*i/, // perl -pi -e, perl -0pi -e
  // `cp` and `mv` only when a CODE file is involved, for the same reason as
  // `tee` below: `cp .env.test .env && npx jest` is a legitimate fixture
  // setup step, and suppressing it would disable autofix for a whole class
  // of honest runs. The mutation-test shape always names a source file --
  // `cp src/x.ts /tmp/bak` -- on one side or the other.
  /^(cp|mv)\b.*\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|ex|exs|c|h|cpp|cs)\b/,
  // `tee` ONLY when it writes a source file. A bare /^tee\b/ was wrong and
  // was caught in review: `npx jest 2>&1 | tee out.log` is an everyday way
  // to capture a run, and matching it suppressed autofix for one of the most
  // common command shapes there is -- a silent hole in the product's whole
  // purpose. Capturing a log is not mutating the code under test.
  /^tee\s+(-\S+\s+)*\S+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|ex|exs|c|h|cpp|cs)\b/,
  /^patch\b/,
  /^git\s+(checkout|restore|stash|apply|revert|reset)\b/,
];

/** Explicit "this red is intentional" marker, honoured anywhere in the command. */
const OPT_OUT = /\bENSEMBLE_NO_AUTOFIX=1\b/;

/**
 * True when a failing run proves nothing actionable about the source.
 *
 * OBSERVED LIVE, twice in one session (br-x13x). A guard was deliberately
 * broken to prove the test covering it actually fails, and restored in the
 * same command:
 *
 *   cp src/x.ts /tmp/bak && perl -0pi -e 's/.../' src/x.ts && npx jest ...
 *     -> "Tests: 2 failed" -> autofix continuation injected
 *
 * There was nothing to fix: the mutants were already reverted before the
 * instruction arrived. The danger is not the wasted turn. Mutation testing
 * is how this project proves a test is load-bearing, the red is the POINT,
 * and the plausible "fix" for a deliberate mutant is to loosen the assertion
 * that caught it -- producing a green suite that proves nothing. A loop that
 * treats every red as a defect is hostile to the practice keeping the suite
 * honest.
 *
 * The asymmetry drives the design: NOT firing costs a turn the user can
 * retry by hand, while firing wrongly can silently destroy a test's value.
 * So this errs toward suppression, and a chain that both edits files and
 * runs tests is treated as inconclusive even though some such chains carry
 * real failures.
 *
 * RESIDUAL GAP, deliberately unaddressed here: a mutation applied in one
 * tool call and tested in the NEXT arrives as a bare `npx jest` and is
 * indistinguishable from a genuine failure. It no longer destroys anything:
 * the governed path verifies by running the behavior's declared test command
 * in a throwaway worktree (fix.verify), never by replaying the captured
 * chain (br-c3s4), and it only ever proposes.
 */
export function isInconclusiveRun(command: string): boolean {
  if (OPT_OUT.test(command)) return true;
  if (!isTestCommand(command)) return false;
  return command.split(SEGMENT_SPLIT).some((segment) => {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return false;
    const invocation = tokens.join(" ");
    return MUTATION_INDICATORS.some((pattern) => pattern.test(invocation));
  });
}

export interface TranslationOptions {
  /**
   * The behavior-declared test command, when one is known. An exact
   * match against it is authoritative and bypasses pattern matching, so
   * a repo whose suite runs via an unrecognised command still works
   * (REQ-012 feeding REQ-002).
   */
  testCommand?: string;
}

/**
 * Returns the semantic event implied by `event`, or undefined.
 *
 * Deliberately total and side-effect free so it can be unit tested
 * without a Pi session, and so the same translation is available to any
 * other harness (TRD-014 / portability).
 */
export function translateEvent(
  event: BehaviorEvent,
  options: TranslationOptions = {},
): BehaviorEvent | undefined {
  if (event.type !== "runtime.tool_call.completed") return undefined;

  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const command = typeof payload.command === "string" ? payload.command : undefined;
  if (!command) return undefined;

  // Identify the command as a test run FIRST, so output sniffing is only
  // ever applied to test output. Otherwise an unrelated command whose log
  // happens to contain "1 failed" would trigger a fix.
  const declared = options.testCommand?.trim();
  const exactDeclared = Boolean(declared && command.trim() === declared);
  if (!exactDeclared && !isTestCommand(command)) return undefined;

  // A deliberate mutation test is not a defect report (br-x13x).
  if (isInconclusiveRun(command)) return undefined;

  const output = typeof payload.output === "string" ? payload.output : "";
  // Either signal is sufficient. Exit status counts only when it is the
  // runner's own -- the whole command IS the declared test command, or the
  // runner is its last segment -- because a compound command reports
  // whatever ran last. Output covers the rest, including the pipe case:
  // `npx jest x | tail -5` arrives with isError=false for a failing suite
  // (observed live, it silently disabled autofix for that run).
  const failedByStatus =
    payload.isError === true && (exactDeclared || exitStatusIsRunners(command));
  const failedByOutput = outputReportsFailure(output);
  if (!failedByStatus && !failedByOutput) {
    // A recognised test command that did NOT report failure.
    //
    // A HEALTHY run still translates to nothing, deliberately. The original
    // contract — "no event for a passing suite" — exists so behaviors cannot
    // chase healthy suites, and emitting on every green run would also make
    // this the highest-volume event in the system for no benefit.
    //
    // The exception is a run that passed because it ran NOTHING. That is not
    // a pass; it is the absence of evidence being reported as evidence, and
    // it was invisible here: it matches no failure pattern and is not
    // `isError`, so it produced no event at all. In this repo's own log it
    // is the single most common failure shape (29 of 51 classifiable).
    //
    // `silent` — no count and no explicit "nothing ran" — is NOT emitted.
    // An unrecognised runner's healthy output would otherwise be reported as
    // vacuous, which is the same error in the opposite direction.
    const volume = readTestVolume(output);
    if (!volume.nothingRan) return undefined;

    return normalizeEvent({
      type: "test.passed",
      source: event.source,
      payload: {
        command,
        cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
        testsReported: volume.testsReported,
        nothingRan: true,
        // The verdict is still the behavior's to draw. This module reports
        // what the run said about itself and nothing more.
        toolName: payload.toolName,
        toolCallId: payload.toolCallId,
        output: payload.output,
      },
    });
  }

  return normalizeEvent({
    type: "test.failure.observed",
    source: event.source,
    payload: {
      command,
      // Needed to re-run the suite where it actually failed. Verifying at
      // the repo root silently matches zero tests and "passes".
      cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
      isError: true,
      // How the failure was detected, so a run that only output-matched is
      // distinguishable from one the shell actually reported as failing.
      detectedBy: failedByStatus ? "exit-status" : "output",
      toolName: payload.toolName,
      toolCallId: payload.toolCallId,
      output: payload.output,
    },
  });
}

/**
 * Wraps a publish function so that every raw event is forwarded and any
 * implied semantic event is published immediately after it.
 *
 * MUST name every translator. When `translateRepositoryChange` was added this
 * function still called only `translateEvent`, so its doc comment — "any
 * implied semantic event" — had quietly become false, and any caller using
 * this wrapper instead of calling the translators directly would have missed
 * repository events with no diagnostic anywhere. A new translator has to be
 * added here as well as at the call site.
 */
export function withTranslation(
  publish: (event: BehaviorEvent) => void | Promise<void>,
  options: TranslationOptions = {},
): (event: BehaviorEvent) => Promise<void> {
  return async (event: BehaviorEvent) => {
    await publish(event);
    const derived = translateEvent(event, options);
    if (derived) await publish(derived);
    const repository = translateRepositoryChange(event);
    if (repository) await publish(repository);
  };
}

/**
 * Commands that change the repository's committed state.
 *
 * Anchored to command position, never matched against the whole line, for the
 * same reason `isTestCommand` is: a message containing the words "git commit"
 * must not be read as one.
 */
const REPOSITORY_CHANGING = [
  /^git\s+commit\b/,
  /^git\s+merge\b/,
  /^git\s+rebase\b/,
  /^git\s+revert\b/,
  /^git\s+cherry-pick\b/,
  /^git\s+apply\b/,
  /^git\s+am\b/,
];

/** `git checkout -b` / `git switch -c`, which create a branch. */
const BRANCH_CREATING = [/^git\s+checkout\s+(?:.*\s)?-b\b/, /^git\s+switch\s+(?:.*\s)?-c\b/];

/**
 * Derives `repository.changed` / `repository.branch.created` from a tool call
 * (br-gpha, closing two of br-d7lm's EMIT list).
 *
 * Kept SEPARATE from `translateEvent` rather than folded into it, because that
 * function returns at most one event and is written around test runs — every
 * early return in it means "not a test command", not "nothing happened".
 *
 * NOT emitted for a command that failed: a rejected commit changed nothing,
 * and a behavior that re-checked the tree on every failed attempt would be
 * noise. The exit status is trusted here only because these commands are the
 * whole command line, not a segment of a pipeline.
 */
export function translateRepositoryChange(event: BehaviorEvent): BehaviorEvent | undefined {
  if (event.type !== "runtime.tool_call.completed") return undefined;

  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const command = typeof payload.command === "string" ? payload.command.trim() : undefined;
  if (!command || payload.isError === true) return undefined;

  const branch = BRANCH_CREATING.some((pattern) => pattern.test(command));
  if (!branch && !REPOSITORY_CHANGING.some((pattern) => pattern.test(command))) return undefined;

  return normalizeEvent({
    type: branch ? "repository.branch.created" : "repository.changed",
    source: event.source,
    payload: { command, cwd: typeof payload.cwd === "string" ? payload.cwd : undefined },
  });
}
