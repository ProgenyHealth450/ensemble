import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifySuite, parseTotals } from "../src/verify-suite";
import { parseSuiteOutput } from "../src/behavior-runner";

/**
 * The verifier is the only thing standing between "the model says it fixed
 * it" and acceptance, so it MUST be able to fail.
 *
 * These grade a real test runner rather than a stubbed command: a verifier
 * proven only against a fake runner proves nothing about the runner it
 * actually grades. The fixture is built here rather than borrowed from /tmp
 * so the test is self-contained and cannot pass because of leftover state.
 */
function fixture(body: string): string {
  const root = mkdtempSync(join(tmpdir(), "verify-suite-"));
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, "src.js"), body);
  writeFileSync(
    join(root, "tests/sum.test.js"),
    'const { add } = require("../src.js");\ntest("adds", () => { expect(add(1,1)).toBe(2); });\n',
  );
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "vs-fixture", version: "1.0.0" }));
  return root;
}

const PASSING = "exports.add = (a, b) => a + b;\n";
const BROKEN = "exports.add = (a, b) => a - b;\n";
// Resolved from the workspace root (hoisted there, not per-package) so the
// fixture needs no install of its own. Verified rather than assumed: an
// unresolvable binary makes every verdict "inconclusive", which would let
// the inconclusive test pass while proving nothing.
const JEST = join(__dirname, "..", "..", "..", "node_modules", ".bin", "jest");
if (!existsSync(JEST)) throw new Error(`jest not found at ${JEST}`);
const CMD = `${JEST} --rootDir . sum`;

describe("verifySuite grades the suite, not the claim", () => {
  it("reports passed when the suite genuinely passes", () => {
    const root = fixture(PASSING);
    const v = verifySuite(CMD, root, root);
    expect(v.status).toBe("passed");
    expect(v.detail).toMatch(/1 passed/);
  });

  // The direction that matters. A verifier that only ever says "passed" is
  // worthless. A model cannot be relied on to produce a wrong fix on demand
  // -- asked to write `a * b`, it refused and fixed the bug correctly -- so
  // the bad fix is injected directly.
  it("reports failed when the fix does not work", () => {
    const root = fixture(BROKEN);
    const v = verifySuite(CMD, root, root);
    expect(v.status).toBe("failed");
    expect(v.detail).toMatch(/1 failed/);
  });

  // Exit code 0 with ZERO tests was the original false-pass trap: running at
  // the wrong directory matched nothing and "succeeded".
  it("reports inconclusive, NOT passed, when the re-run executes no tests", () => {
    const root = fixture(PASSING);
    const v = verifySuite(`${JEST} --rootDir . no-such-test-name`, root, root);
    expect(v.status).toBe("inconclusive");
    expect(v.status).not.toBe("passed");
  });

  it("uses the recorded cwd, not the fallback", () => {
    const root = fixture(PASSING);
    const elsewhere = mkdtempSync(join(tmpdir(), "verify-elsewhere-"));
    // Correct cwd supplied: the suite is found and passes even though the
    // fallback points somewhere with no tests at all.
    expect(verifySuite(CMD, root, elsewhere).status).toBe("passed");
    // No cwd: falls back, finds nothing, and must NOT claim success.
    expect(verifySuite(CMD, undefined, elsewhere).status).toBe("inconclusive");
  });
});

describe("a pipeline must not launder a failure into a pass", () => {
  const JEST2 = join(__dirname, "..", "..", "..", "node_modules", ".bin", "jest");

  // Observed live: the model piped test output through `tail`, so $? was
  // tail's exit status (0) and a failing suite was graded "passed". The
  // reported failure count is authoritative over the exit code.
  it("reports failed when the suite failed but the pipeline exited 0", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-pipe-"));
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "src.js"), "exports.add = (a, b) => a - b;\n");
    writeFileSync(
      join(root, "tests/sum.test.js"),
      'const { add } = require("../src.js");\ntest("adds", () => { expect(add(1,1)).toBe(2); });\n',
    );
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "p", version: "1.0.0" }));

    const piped = `${JEST2} --rootDir . sum 2>&1 | tail -60`;
    expect(spawnSync("bash", ["-lc", `cd ${root} && ${piped}`]).status).toBe(0); // pipeline hides it
    expect(verifySuite(piped, root, root).status).toBe("failed");
  });
});

// br-srbd. Observed live: `npx jest` at a root with no jest config could
// not load 66 TypeScript suites; every test that loaded passed; exit 1. The
// old parse read only the first `Tests:` line, saw "2693 passed" and no
// failure count, and produced a "failed" verdict whose detail showed nothing
// failing -- while the governed path's parser graded the same output a PASS.
describe("a suite that cannot load is a failure, and says so", () => {
  it("reports failed with the unloadable suite count, using a real jest run", () => {
    const root = fixture(PASSING);
    // A second suite that cannot even be parsed.
    writeFileSync(join(root, "tests/broken.test.js"), "import type { X } from 'y';\n");
    const v = verifySuite(`${JEST} --rootDir .`, root, root);
    expect(v.status).toBe("failed");
    expect(v.detail).toMatch(/1 test suite\(s\) failed or could not load/);
    expect(v.detail).toMatch(/1 passed/);
  });

  it("the governed path's parser counts it as a failure too", () => {
    const out = "Test Suites: 66 failed, 109 passed, 175 total\nTests:       5 skipped, 2693 passed, 2698 total\n";
    expect(parseSuiteOutput(out, 1)).toMatchObject({ failures: 66, targetPasses: false });
  });
});

// `npm test` at the repo root runs one jest per workspace and prints one
// summary each. The first summary must not speak for the rest.
describe("every summary counts", () => {
  const TWO_RUNS =
    "Test Suites: 3 passed, 3 total\nTests:       10 passed, 10 total\n" +
    "Test Suites: 1 failed, 2 passed, 3 total\nTests:       1 failed, 7 passed, 8 total\n";

  it("sums all runs", () => {
    expect(parseTotals(TWO_RUNS)).toEqual({ runs: 2, failed: 1, passed: 17, skipped: 0, total: 18, failedSuites: 1 });
  });

  it("verifySuite fails on a failure in a later run, even when the command exits 0", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-runs-"));
    writeFileSync(join(root, "out.txt"), TWO_RUNS);
    const v = verifySuite("cat out.txt", root, root);
    expect(v.status).toBe("failed");
    expect(v.detail).toMatch(/1 failed, 17 passed, 18 total across 2 jest runs/);
  });

  it("the governed path's parser fails on it too", () => {
    expect(parseSuiteOutput(TWO_RUNS, 0)).toMatchObject({ failures: 2, targetPasses: false });
  });

  it("ignores a test NAME that merely contains 'Tests:'", () => {
    expect(parseTotals("  ✓ Tests: 5 failed is a string (1 ms)\nTests:       1 passed, 1 total\n").failed).toBe(0);
  });
});

describe("a non-zero exit with no failing test reported is still a failure", () => {
  it("verifySuite fails and says why, rather than showing only passing counts", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-exit-"));
    writeFileSync(join(root, "out.txt"), "Tests:       4 passed, 4 total\n");
    const v = verifySuite("cat out.txt; exit 3", root, root);
    expect(v.status).toBe("failed");
    expect(v.detail).toMatch(/command exited 3 with no failing test reported; 4 passed, 4 total/);
  });

  it("the governed path's parser no longer lets a summary override the exit code", () => {
    expect(parseSuiteOutput("Tests:       4 passed, 4 total\n", 1)).toMatchObject({ failures: 1, targetPasses: false });
    expect(parseSuiteOutput("Tests:       4 passed, 4 total\n", 0)).toMatchObject({ failures: 0, targetPasses: true });
  });
});
