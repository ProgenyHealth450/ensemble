import { readTestVolume, translateEvent } from "../src/behavior/event-translator";

/**
 * `br-cwrh`: a test run that passed because it ran nothing is not a pass.
 *
 * This is the most common failure shape in this repository's own runtime log
 * — 29 of 51 classifiable failures — and before this it produced no event at
 * all. It matches no failure pattern and the shell reports success, so the
 * runtime simply never saw it.
 *
 * The risk in fixing it is over-correction: reporting an unfamiliar runner's
 * healthy output as vacuous would train people to ignore the signal, which is
 * worse than not having it. Hence `silent` is a distinct case and is never
 * emitted.
 */

function toolCall(command: string, output: string, isError = false) {
  return {
    type: "runtime.tool_call.completed",
    source: "test",
    payload: { command, output, isError, toolName: "bash", toolCallId: "t1" },
  } as never;
}

describe("reading how much a test run actually ran", () => {
  it("reads a jest total", () => {
    expect(readTestVolume("Tests:       12 passed, 12 total")).toMatchObject({
      testsReported: 12,
      nothingRan: false,
    });
  });

  it("treats an explicit zero total as nothing having run", () => {
    expect(readTestVolume("Tests:       0 total")).toMatchObject({ nothingRan: true });
  });

  it("recognises pytest saying so in words", () => {
    expect(readTestVolume("no tests ran in 0.01s")).toMatchObject({ nothingRan: true });
  });

  it("recognises go reporting no test files", () => {
    expect(readTestVolume("?   example/pkg   [no test files]")).toMatchObject({ nothingRan: true });
  });

  it("separates 'reported nothing' from 'reported zero'", () => {
    // An unknown runner that printed neither a count nor a disclaimer. This
    // must NOT be called vacuous — absence of a count is not evidence of
    // absence of tests.
    const volume = readTestVolume("Done in 1.2s");
    expect(volume.silent).toBe(true);
    expect(volume.nothingRan).toBe(false);
  });
});

describe("translating a run that passed without running anything", () => {
  it("emits test.passed carrying the vacuity, where nothing was emitted before", () => {
    const event = translateEvent(toolCall("npx jest", "Tests:       0 total\n"), {});
    expect(event?.type).toBe("test.passed");
    expect(event?.payload).toMatchObject({ nothingRan: true, testsReported: 0 });
  });

  it("carries the cwd, because re-running at the repo root is how this hides", () => {
    const raw = toolCall("npx pytest", "no tests ran in 0.01s\n");
    (raw as unknown as { payload: Record<string, unknown> }).payload.cwd = "/repo/packages/x";
    expect(translateEvent(raw, {})?.payload).toMatchObject({ cwd: "/repo/packages/x" });
  });

  it("stays silent for a genuinely healthy run", () => {
    // The original contract: a passing suite produces no event, so behaviors
    // cannot chase healthy code. Preserved exactly.
    expect(translateEvent(toolCall("npx jest", "Tests:       12 passed, 12 total\n"), {})).toBeUndefined();
  });

  it("stays silent for an unrecognised runner's output", () => {
    expect(translateEvent(toolCall("npx jest", "Done in 1.2s\n"), {})).toBeUndefined();
  });

  it("still reports a real failure as a failure, not a vacuous pass", () => {
    const event = translateEvent(toolCall("npx jest", "Tests: 1 failed, 1 total\n"), {});
    expect(event?.type).toBe("test.failure.observed");
  });

  it("ignores commands that are not test runs at all", () => {
    expect(translateEvent(toolCall("ls -la", "Tests:       0 total\n"), {})).toBeUndefined();
  });
});
