import { VerifyInput, VerificationResult, findUnloadableSuites, verifyOutput } from "../src";

/**
 * REQ-SAFE-006, the fail-closed verifier.
 *
 * The thing worth protecting here is not "does the parser read numbers". It is
 * the direction the verifier errs in when the evidence is ambiguous. Every
 * clause in the source traces to a run that reported success while proving
 * nothing, so each of those runs is reproduced below as literal captured
 * output rather than as a synthetic `{ total, failed }` record. A parser test
 * written against hand-built counts would still pass if the adapters stopped
 * recognising real output entirely, which is precisely the failure mode that
 * makes an unrecognised run look like a clean one.
 *
 * Throughout, `passed` is treated as the only assertion that costs anything to
 * make. `inconclusive` and `failed` are both safe answers; confusing them with
 * each other is a reporting defect, but confusing either with `passed` is how
 * a broken fix ships.
 */

function run(overrides: Partial<VerifyInput>): VerificationResult {
  return verifyOutput({
    command: "npx jest",
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Captured runner output.
// ---------------------------------------------------------------------------

/**
 * br-gwww, verbatim in shape: one suite could not be required, so its tests
 * were never executed, yet jest's `Tests:` line counts only the tests it
 * actually ran and therefore reports a clean sweep.
 */
const JEST_LOAD_FAILURE_REPORTED_AS_PASS = [
  "FAIL tests/rounding.test.ts",
  "  ● Test suite failed to run",
  "",
  "    Cannot find module '../src/rounding' from 'tests/rounding.test.ts'",
  "",
  "      10 | import { roundHalfUp } from '../src/rounding';",
  "",
  "PASS tests/format.test.ts",
  "  ✓ formats a currency amount (3 ms)",
  "  ✓ formats a percentage (1 ms)",
  "",
  "Test Suites: 1 failed, 1 passed, 2 total",
  "Tests:       0 failed, 2 passed, 2 total",
  "Snapshots:   0 total",
  "Time:        1.284 s",
].join("\n");

/**
 * The counterweight to the case above. These tests ran, passed, and happen to
 * be *about* module-resolution diagnostics, so their names contain the same
 * English the scan looks for. If the scan fired here, every suite that tests
 * error reporting would become permanently unverifiable.
 */
const JEST_PASS_WHOSE_TEST_NAMES_MENTION_LOAD_FAILURES = [
  "PASS tests/diagnostics.test.ts",
  "  loader diagnostics",
  "    ✓ explains that a Test suite failed to run banner means the file never loaded (4 ms)",
  "    ✓ suggests a fix when jest reports Cannot find module for a relative path (1 ms)",
  "    ✓ maps ModuleNotFoundError onto the same operator hint (1 ms)",
  "",
  "Test Suites: 1 passed, 1 total",
  "Tests:       3 passed, 3 total",
  "Snapshots:   0 total",
].join("\n");

const JEST_ALL_PASSING = [
  "PASS tests/format.test.ts",
  "  ✓ formats a currency amount (3 ms)",
  "",
  "Test Suites: 1 passed, 1 total",
  "Tests:       6 passed, 6 total",
  "Snapshots:   0 total",
].join("\n");

const JEST_ONE_FAILING = [
  "FAIL tests/format.test.ts",
  "  ✕ formats a percentage (5 ms)",
  "",
  "Test Suites: 1 failed, 1 total",
  "Tests:       1 failed, 4 passed, 5 total",
  "Snapshots:   0 total",
].join("\n");

const JEST_ZERO_TESTS = [
  "Test Suites: 0 of 0 total",
  "Tests:       0 total",
  "Snapshots:   0 total",
  "Time:        0.31 s",
].join("\n");

/** `npx jest live-e2e` from a directory where that path matches nothing. */
const JEST_WRONG_DIRECTORY = [
  "No tests found, exiting with code 0",
  "Run with `--passWithNoTests` to exit with code 0",
  "In /Users/ci/repo/packages/agent-core",
  "  47 files checked.",
  "  testMatch: **/tests/**/*.test.ts - 47 matches",
  "  testPathIgnorePatterns: /node_modules/ - 47 matches",
  "  testRegex:  - 0 matches",
].join("\n");

/** `npx jest 2>&1 | tail -60`: the summary scrolled off, `tail` exited 0. */
const TAIL_TRUNCATED_OUTPUT = [
  "      at Object.<anonymous> (tests/live-e2e.test.ts:18:22)",
  "      at Promise.then.completed (node_modules/jest-circus/build/utils.js:298:28)",
  "      at _runTest (node_modules/jest-circus/build/run.js:252:3)",
  "      at processTicksAndRejections (node:internal/process/task_queues:95:5)",
].join("\n");

const PYTEST_ALL_PASSING = [
  "============================= test session starts ==============================",
  "platform darwin -- Python 3.11.6, pytest-8.0.0, pluggy-1.4.0",
  "rootdir: /repo",
  "collected 12 items",
  "",
  "tests/test_pricing.py ............                                        [100%]",
  "",
  "============================== 12 passed in 0.43s ==============================",
].join("\n");

const PYTEST_ONE_FAILING = [
  "============================= test session starts ==============================",
  "collected 12 items",
  "",
  "tests/test_pricing.py ...........F                                        [100%]",
  "",
  "___________________________ test_discount __________________________",
  "    def test_discount():",
  ">       assert discount(100, 10) == 91",
  "E       assert 90 == 91",
  "",
  "========================= 1 failed, 11 passed in 0.51s =========================",
].join("\n");

const PYTEST_NO_TESTS_RAN = [
  "============================= test session starts ==============================",
  "platform darwin -- Python 3.11.6, pytest-8.0.0, pluggy-1.4.0",
  "collected 0 items",
  "",
  "============================ no tests ran in 0.02s =============================",
].join("\n");

/** pytest's equivalent of the br-gwww defect: a module that would not import. */
const PYTEST_COLLECTION_ERROR = [
  "============================= test session starts ==============================",
  "collected 8 items / 1 error",
  "",
  "ImportError while importing test module '/repo/tests/test_round.py'.",
  "Hint: make sure your test modules/packages have valid Python names.",
  "Traceback:",
  "tests/test_round.py:3: in <module>",
  "    from app.rounding import round_half_up",
  "E   ModuleNotFoundError: No module named 'app.rounding'",
  "",
  "======================== 8 passed, 1 error in 0.33s =========================",
].join("\n");

const MIX_ALL_PASSING = [
  "Compiling 2 files (.ex)",
  "........",
  "Finished in 0.09 seconds (0.00s async, 0.09s sync)",
  "8 tests, 0 failures",
  "",
  "Randomized with seed 123456",
].join("\n");

const MIX_FAILING = [
  "..F.........",
  "",
  "  1) test rounds half up (Calc.RoundingTest)",
  "     test/calc/rounding_test.exs:14",
  "     Assertion failed",
  "",
  "Finished in 0.2 seconds",
  "12 tests, 2 failures",
].join("\n");

const GO_ALL_PASSING = [
  "=== RUN   TestAdd",
  "--- PASS: TestAdd (0.00s)",
  "=== RUN   TestSub",
  "--- PASS: TestSub (0.00s)",
  "PASS",
  "ok  \texample.com/calc\t0.112s",
].join("\n");

const GO_FAILING = [
  "=== RUN   TestAdd",
  "    calc_test.go:12: got 5, want 4",
  "--- FAIL: TestAdd (0.00s)",
  "=== RUN   TestSub",
  "--- PASS: TestSub (0.00s)",
  "FAIL",
  "FAIL\texample.com/calc\t0.115s",
].join("\n");

const GO_NO_TEST_FILES = [
  "?   \texample.com/empty\t[no test files]",
  "ok  \texample.com/calc\t0.001s",
].join("\n");

const CARGO_ALL_PASSING = [
  "   Compiling calc v0.1.0 (/repo)",
  "    Finished test profile in 1.21s",
  "     Running unittests src/lib.rs",
  "",
  "running 7 tests",
  "test rounding::tests::half_up ... ok",
  "",
  "test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out",
].join("\n");

const CARGO_FAILING = [
  "running 7 tests",
  "test rounding::tests::half_up ... FAILED",
  "",
  "failures:",
  "    rounding::tests::half_up",
  "",
  "test result: FAILED. 5 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out",
].join("\n");

const CARGO_COMPILE_ERROR = [
  "   Compiling calc v0.1.0 (/repo)",
  "error[E0433]: failed to resolve: use of undeclared crate or module `rounding`",
  " --> tests/rounding.rs:1:5",
  "",
  "error: could not compile `calc` (test \"rounding\") due to 1 previous error",
].join("\n");

// ---------------------------------------------------------------------------

describe("verifyOutput refuses to call an unexecuted suite a pass (br-gwww)", () => {
  /**
   * The run that motivated the whole verifier. The runner's own summary is
   * internally consistent and says nothing failed; the runner simply has no
   * row for the two tests inside the suite it could not load. Believing the
   * summary means believing a suite passed on the strength of never having
   * been compiled, and the constitution amendment written during that same run
   * described exactly this defect — the verifier was fooled by an instrument
   * the run had already judged untrustworthy.
   */
  it("treats a clean Tests: line as unproven when the output shows a suite that never loaded", () => {
    const result = run({ stdout: JEST_LOAD_FAILURE_REPORTED_AS_PASS, exitCode: 0 });

    expect(result.status).toBe("inconclusive");
    expect(result.framework).toBe("jest");
    expect(result.unloadableSuites).toContain("../src/rounding");
    expect(result.detail).toMatch(/never ran cannot have passed/);
  });

  /**
   * The counts are still reported even though they are not believed. An
   * operator reading the result needs to see the claim that was rejected,
   * otherwise the only way to understand the verdict is to re-run the suite.
   */
  it("still reports the counts it declined to trust", () => {
    const result = run({ stdout: JEST_LOAD_FAILURE_REPORTED_AS_PASS, exitCode: 0 });

    expect(result.total).toBe(2);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
  });

  /**
   * A load-failure scan broad enough to match prose would fire on any suite
   * that tests error reporting, and a signal that fires on healthy runs is a
   * signal operators learn to click through. The narrowness of the patterns is
   * therefore load-bearing, not an implementation detail: anchoring "Test suite
   * failed to run" to the start of a line and requiring the quoted specifier
   * after "Cannot find module" is what keeps the override credible.
   */
  it("does not fire on a passing run whose test names merely describe load failures", () => {
    expect(findUnloadableSuites(JEST_PASS_WHOSE_TEST_NAMES_MENTION_LOAD_FAILURES)).toEqual([]);

    const result = run({ stdout: JEST_PASS_WHOSE_TEST_NAMES_MENTION_LOAD_FAILURES, exitCode: 0 });
    expect(result.status).toBe("passed");
    expect(result.total).toBe(3);
  });

  /**
   * The scan reads the runner's own machine-formatted banners in any of the
   * dialects the adapters cover, so the override is not a jest-only privilege.
   */
  it("recognises the load-failure banners of the other supported runners", () => {
    expect(findUnloadableSuites(PYTEST_COLLECTION_ERROR)).toEqual(
      expect.arrayContaining(["/repo/tests/test_round.py", "app.rounding"]),
    );
    expect(findUnloadableSuites(CARGO_COMPILE_ERROR)).toEqual(
      expect.arrayContaining([expect.stringMatching(/could not compile/i)]),
    );
    expect(
      findUnloadableSuites(
        "** (UndefinedFunctionError) function Rounding.half_up/1 is undefined (module Rounding is not available)",
      ),
    ).toEqual(["Rounding"]);
  });
});

describe("verifyOutput treats an absence of tests as an absence of evidence", () => {
  /**
   * A suite that ran nothing has asserted nothing. The exit code is honest
   * here — zero tests really did fail — which is why a bare exit-code check
   * rubber-stamps this run, and why the count has to be consulted instead.
   */
  it("calls a zero-test run inconclusive rather than a pass", () => {
    const result = run({ stdout: JEST_ZERO_TESTS, exitCode: 0 });

    expect(result.status).toBe("inconclusive");
    expect(result.total).toBe(0);
    expect(result.detail).toMatch(/zero tests/);
  });

  it("applies the same reading to pytest collecting nothing", () => {
    const result = run({ stdout: PYTEST_NO_TESTS_RAN, exitCode: 0, command: "pytest -q" });

    expect(result.status).toBe("inconclusive");
    expect(result.framework).toBe("pytest");
    expect(result.total).toBe(0);
  });

  it("applies the same reading to a Go package with no test files", () => {
    const result = run({ stdout: GO_NO_TEST_FILES, exitCode: 0, command: "go test ./..." });

    expect(result.status).toBe("inconclusive");
    expect(result.framework).toBe("go-test");
    expect(result.total).toBe(0);
  });

  /**
   * Suites can also stop being collected between two runs of the *same*
   * command — a renamed directory, a glob that no longer matches, a config
   * change. Nothing in a single run's output distinguishes "6 tests, all
   * green" from "we lost half the suite and the survivors are green", so the
   * only available signal is the comparison with what the command produced
   * last time.
   */
  it("calls a drop in suite size inconclusive even though every surviving test passed", () => {
    const result = run({ stdout: JEST_ALL_PASSING, exitCode: 0, previousTotal: 12 });

    expect(result.status).toBe("inconclusive");
    expect(result.detail).toMatch(/down from 12/);
  });

  it("accepts a run that holds or grows the previous suite size", () => {
    expect(run({ stdout: JEST_ALL_PASSING, exitCode: 0, previousTotal: 6 }).status).toBe("passed");
    expect(run({ stdout: JEST_ALL_PASSING, exitCode: 0, previousTotal: 4 }).status).toBe("passed");
  });
});

describe("verifyOutput refuses to attribute output it does not recognise", () => {
  /**
   * `npx jest live-e2e` run from the wrong directory matched nothing and
   * exited 0. There is no framework summary to read, so the exit code is the
   * only signal left — and it is the one signal that cannot distinguish this
   * run from a real pass. Consulting it here is what made the original
   * incident possible, so it is deliberately not consulted.
   */
  it("does not let a zero exit stand in for a summary it could not parse", () => {
    const result = run({ stdout: JEST_WRONG_DIRECTORY, exitCode: 0, command: "npx jest live-e2e" });

    expect(result.status).toBe("inconclusive");
    expect(result.framework).toBe("unknown");
    expect(result.detail).toMatch(/cannot be attributed is not a pass/);
  });

  /**
   * The piped-through-`tail` variant of the same hole. A shell pipeline
   * reports the exit status of its last command, so `npx jest | tail -60`
   * exits 0 whenever `tail` succeeds — which is always — and the summary the
   * verdict depends on is exactly the part `tail` discarded.
   */
  it("does not let a pipeline's exit status stand in for the runner's", () => {
    const result = run({
      stdout: TAIL_TRUNCATED_OUTPUT,
      exitCode: 0,
      command: "npx jest 2>&1 | tail -60",
    });

    expect(result.status).toBe("inconclusive");
    expect(result.framework).toBe("unknown");
  });

  /**
   * A build that never produced a binary has the same shape: nothing to parse,
   * and a load-failure banner explaining why.
   */
  it("reports a compile failure as unattributable rather than as a test failure", () => {
    const result = run({
      stdout: CARGO_COMPILE_ERROR,
      exitCode: 101,
      command: "cargo test",
    });

    expect(result.status).toBe("inconclusive");
    expect(result.framework).toBe("unknown");
    expect(result.unloadableSuites.length).toBeGreaterThan(0);
  });
});

describe("verifyOutput believes reported failures regardless of the exit code", () => {
  /**
   * The mirror image of the pipeline hole. When the runner's own summary says
   * tests failed but the process exited 0 — piped output, a wrapper script
   * that swallows the status, `|| true` in a CI step — the assertions are the
   * more specific evidence and the verdict must be `failed`, not the softer
   * `inconclusive`. Downgrading a known failure to "unclear" would let a red
   * suite be re-run until the noise looked acceptable.
   */
  it("reports failure when the summary shows failures and the process exited 0", () => {
    const result = run({
      stdout: JEST_ONE_FAILING,
      exitCode: 0,
      command: "npx jest 2>&1 | tail -60",
    });

    expect(result.status).toBe("failed");
    expect(result.failed).toBe(1);
    expect(result.passed).toBe(4);
    expect(result.total).toBe(5);
  });

  /**
   * Counts that claim success while the process disagrees are the opposite
   * situation: something outside the assertions went wrong — a global teardown
   * threw, a coverage threshold was missed, the runner crashed after
   * summarising — and nothing in the output says what. Unattributed is not
   * the same as failed, but it is certainly not a pass.
   */
  it("withholds a pass when the counts and the exit code disagree", () => {
    const result = run({ stdout: JEST_ALL_PASSING, exitCode: 1 });

    expect(result.status).toBe("inconclusive");
    expect(result.detail).toMatch(/discrepancy is unattributed/);
  });

  it("treats a process killed without an exit code the same way", () => {
    expect(run({ stdout: JEST_ALL_PASSING, exitCode: null }).status).toBe("inconclusive");
  });
});

/**
 * `npm test` in a monorepo -- the command fix-failing-test declares -- runs
 * jest once per workspace and prints one summary per run. The first
 * workspace here is green; the failure is in the second.
 */
const NPM_WORKSPACES_ONE_FAILING = [
  "> @sunstone-partners/ensemble-agent-core@1.0.0 test",
  "> jest",
  "",
  "Test Suites: 3 passed, 3 total",
  "Tests:       40 passed, 40 total",
  "",
  "> @sunstone-partners/ensemble-pi-extension@1.0.0 test",
  "> jest",
  "",
  "FAIL tests/extension.test.ts",
  "  ✕ loads the extension (3 ms)",
  "",
  "Test Suites: 1 failed, 2 passed, 3 total",
  "Tests:       1 failed, 11 passed, 12 total",
].join("\n");

describe("verifyOutput reads a whole multi-workspace run (4f1b1f0, b64ad4b, 2896e8f)", () => {
  it("sums every jest summary, so a failure in a later workspace is a failed verdict", () => {
    const result = run({ command: "env -u CI npm test", stdout: NPM_WORKSPACES_ONE_FAILING, exitCode: 1 });

    expect(result.status).toBe("failed");
    expect({ total: result.total, passed: result.passed, failed: result.failed }).toEqual({
      total: 52,
      passed: 51,
      failed: 1,
    });
  });

  it("names the failing test files in a failed verdict", () => {
    expect(run({ stdout: JEST_ONE_FAILING, exitCode: 1 }).detail).toMatch(/; failing: tests\/format\.test\.ts$/);
  });

  it("names the failing npm workspace when the exit is non-zero and no test failed", () => {
    const result = run({
      command: "env -u CI npm test",
      stdout: JEST_ALL_PASSING,
      stderr: "npm error Lifecycle script `test` failed\nnpm error path /repo/packages/router\n",
      exitCode: 1,
    });

    expect(result.status).toBe("inconclusive");
    expect(result.detail).toMatch(/; stderr: npm error path \/repo\/packages\/router$/);
  });
});

describe("verifyOutput distinguishes no-evidence from counter-evidence", () => {
  /**
   * A timeout says the harness ran out of patience, not that the code is
   * wrong. Reporting it as `failed` would send someone to debug a product bug
   * that the run never demonstrated, and — worse in a self-repair loop — would
   * invite a "fix" for a defect that does not exist.
   */
  it("calls a timeout inconclusive even when the captured output looks green", () => {
    const result = run({ stdout: JEST_ALL_PASSING, timedOut: true, exitCode: null });

    expect(result.status).toBe("inconclusive");
    expect(result.detail).toMatch(/timed out/);
  });

  it("calls a timeout inconclusive rather than failed when the captured output looks red", () => {
    const result = run({ stdout: JEST_ONE_FAILING, timedOut: true, exitCode: null });

    expect(result.status).toBe("inconclusive");
    expect(result.status).not.toBe("failed");
  });

  /**
   * A command that never started measured nothing at all. The distinction
   * matters most in the red case: `pytest: command not found` says the
   * environment is wrong, and charging that to the code under test hides the
   * real problem behind a plausible-looking test failure.
   */
  it("calls a spawn failure inconclusive and never failed", () => {
    const missing = run({
      stderr: "/bin/sh: pytest: command not found",
      spawnFailed: true,
      exitCode: 127,
      command: "pytest -q",
    });

    expect(missing.status).toBe("inconclusive");
    expect(missing.detail).toMatch(/could not be started/);

    const withRedOutput = run({ stdout: JEST_ONE_FAILING, spawnFailed: true, exitCode: 127 });
    expect(withRedOutput.status).toBe("inconclusive");
  });

  /**
   * Neither branch has parsed anything, so claiming a framework would be an
   * attribution the run does not support.
   */
  it("attributes neither outcome to a framework", () => {
    expect(run({ stdout: JEST_ALL_PASSING, timedOut: true }).framework).toBe("unknown");
    expect(run({ stdout: JEST_ALL_PASSING, spawnFailed: true }).framework).toBe("unknown");
  });
});

describe("framework adapters read real runner output", () => {
  /**
   * These exist so that "unrecognised output is inconclusive" stays a safety
   * net rather than the normal outcome. If an adapter silently stopped
   * matching, every run of that ecosystem would degrade to `inconclusive` and
   * the verifier would become noise — so each adapter is pinned against output
   * in the shape its runner actually emits, including the summary lines that
   * sit next to other numbers the parser must not mistake for counts.
   */
  it.each<[string, string, { total: number; passed: number; failed: number }]>([
    ["jest", JEST_ALL_PASSING, { total: 6, passed: 6, failed: 0 }],
    ["pytest", PYTEST_ALL_PASSING, { total: 12, passed: 12, failed: 0 }],
    ["mix-test", MIX_ALL_PASSING, { total: 8, passed: 8, failed: 0 }],
    ["go-test", GO_ALL_PASSING, { total: 2, passed: 2, failed: 0 }],
    ["cargo-test", CARGO_ALL_PASSING, { total: 7, passed: 7, failed: 0 }],
  ])("reads a clean %s run as passed", (framework, stdout, counts) => {
    const result = run({ stdout, exitCode: 0 });

    expect(result.status).toBe("passed");
    expect(result.framework).toBe(framework);
    expect({ total: result.total, passed: result.passed, failed: result.failed }).toEqual(counts);
  });

  it.each<[string, string, { total: number; passed: number; failed: number }]>([
    ["jest", JEST_ONE_FAILING, { total: 5, passed: 4, failed: 1 }],
    ["pytest", PYTEST_ONE_FAILING, { total: 12, passed: 11, failed: 1 }],
    ["mix-test", MIX_FAILING, { total: 12, passed: 10, failed: 2 }],
    ["go-test", GO_FAILING, { total: 2, passed: 1, failed: 1 }],
    ["cargo-test", CARGO_FAILING, { total: 7, passed: 5, failed: 2 }],
  ])("reads a red %s run as failed", (framework, stdout, counts) => {
    const result = run({ stdout, exitCode: 1 });

    expect(result.status).toBe("failed");
    expect(result.framework).toBe(framework);
    expect({ total: result.total, passed: result.passed, failed: result.failed }).toEqual(counts);
  });

  /**
   * pytest reports collection errors separately from assertion failures, and a
   * run whose modules would not import is not a run whose tests passed. Rolling
   * errors into the failure count is what keeps the eight tests that did run
   * from being presented as the whole story.
   */
  it("counts pytest collection errors against the run", () => {
    const result = run({ stdout: PYTEST_COLLECTION_ERROR, exitCode: 2, command: "pytest -q" });

    expect(result.status).toBe("failed");
    expect(result.framework).toBe("pytest");
    expect(result.failed).toBe(1);
    expect(result.passed).toBe(8);
  });

  /**
   * The adapters are tried in order and the first match wins, so output that
   * only one runner could have produced must not be claimed by an earlier one.
   * Go's `FAIL` lines and pytest's banner rows are the pair most likely to
   * collide, since both appear at the start of a line.
   */
  it("attributes output to the runner that produced it", () => {
    expect(run({ stdout: GO_FAILING, exitCode: 1 }).framework).toBe("go-test");
    expect(run({ stdout: PYTEST_ONE_FAILING, exitCode: 1 }).framework).toBe("pytest");
    expect(run({ stdout: CARGO_FAILING, exitCode: 101 }).framework).toBe("cargo-test");
  });

  /**
   * stderr is part of the evidence. Runners split their output inconsistently
   * — mix and cargo write progress to stdout and diagnostics to stderr — and a
   * verifier that read only stdout would miss the load-failure banner that
   * makes a reported pass untrustworthy.
   */
  it("reads both streams", () => {
    const result = run({
      stdout: "Tests:       2 failed, 2 passed, 4 total",
      stderr: "  ● Test suite failed to run\n\n    Cannot find module '../src/rounding'",
    });

    expect(result.status).toBe("failed");
    expect(result.unloadableSuites).toContain("../src/rounding");
  });
});
