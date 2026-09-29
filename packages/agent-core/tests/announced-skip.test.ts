import { findAnnouncedSkips, verifyOutput } from "../src/cqrs/verification";

/**
 * `br-91nr`: a run that announces it skipped part of the suite has not
 * verified that part, whatever it exits with.
 *
 * The concrete case: `packages/router` prints "Skipping Python tests" and
 * exits 0 when pytest is absent and CI is unset. The JS half of the same run
 * reports perfectly good counts, an adapter matches them, and the verdict is
 * `passed` — over a suite half of which never executed.
 *
 * The opposite error is just as bad. Calling a healthy run inconclusive
 * because the word "skip" appeared somewhere in its output would train people
 * to ignore the verdict, so detection requires an explicit announcement on
 * its own line.
 */

const OK_JS = "Test Suites: 3 passed, 3 total\nTests:       12 passed, 12 total\n";

function verify(stdout: string, exitCode = 0) {
  return verifyOutput({ command: "env -u CI npm test", stdout, stderr: "", exitCode, timedOut: false });
}

describe("finding announced skips", () => {
  it("finds the router's Python skip", () => {
    expect(findAnnouncedSkips("Skipping Python tests (pytest not found)")).toEqual([
      "Skipping Python tests (pytest not found)",
    ]);
  });

  it("finds past-tense and 'no X tests to run' phrasings", () => {
    expect(findAnnouncedSkips("Skipped Ruby tests")).toHaveLength(1);
    expect(findAnnouncedSkips("No Python tests to run")).toHaveLength(1);
  });

  it("does not fire on the word appearing mid-line", () => {
    // A test NAMED "skipping empty input" must not make the run inconclusive.
    expect(findAnnouncedSkips("  ✓ handles skipping empty input (2 ms)")).toEqual([]);
  });

  it("does not fire on ordinary per-test skips", () => {
    // "3 skipped" is routine and says nothing about suite coverage.
    expect(findAnnouncedSkips("Tests: 9 passed, 3 skipped, 12 total")).toEqual([]);
  });

  it("reports each distinct announcement once", () => {
    const text = "Skipping Python tests\nSkipping Python tests\nSkipped Ruby tests";
    expect(findAnnouncedSkips(text)).toHaveLength(2);
  });
});

describe("verifying a run that skipped half its suite", () => {
  it("refuses to call it passed", () => {
    const result = verify(`${OK_JS}Skipping Python tests (pytest not found)\n`);
    expect(result.status).toBe("inconclusive");
  });

  it("says what was skipped, not merely that something was", () => {
    const result = verify(`${OK_JS}Skipping Python tests (pytest not found)\n`);
    expect(result.detail).toContain("Skipping Python tests");
    expect(result.detail).toContain("covers only what actually ran");
  });

  it("is not fooled by the exit code, which is the whole point", () => {
    // Exit 0 is exactly what the wrapper produces; the verdict must not
    // depend on it.
    expect(verify(`${OK_JS}Skipping Python tests\n`, 0).status).toBe("inconclusive");
  });

  it("still passes a run that skipped nothing", () => {
    expect(verify(OK_JS).status).toBe("passed");
  });

  it("still fails a run with real failures, rather than masking them", () => {
    const failing = "Tests:       1 failed, 11 passed, 12 total\n";
    expect(verify(failing, 1).status).toBe("failed");
  });
});
