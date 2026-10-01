import { isInconclusiveRun, translateEvent } from "../src/behavior/event-translator";

/**
 * br-x13x: autofix fired on deliberate mutation-test failures, twice live.
 *
 * The commands below are the real ones from this repository's session log,
 * not invented shapes.
 */

function toolCall(command: string, output: string) {
  return {
    type: "runtime.tool_call.completed",
    source: "test",
    payload: { command, output, isError: true, toolName: "bash", toolCallId: "1" },
  } as never;
}

const FAILING = "Tests:       2 failed, 4 passed, 6 total";

describe("deliberate mutation runs are not defect reports", () => {
  it("suppresses the mutate-test-restore chain observed live", () => {
    const command =
      "cd packages/agent-core && cp src/behavior/write-boundary-monitor.ts /tmp/mon.bak && " +
      "perl -0pi -e 's/const external = movedByExternalHistory\\(x\\);/const external = true;/' " +
      "src/behavior/write-boundary-monitor.ts && npx jest write-boundary && " +
      "cp /tmp/mon.bak src/behavior/write-boundary-monitor.ts";

    expect(isInconclusiveRun(command)).toBe(true);
    expect(translateEvent(toolCall(command, FAILING))).toBeUndefined();
  });

  it.each([
    ["sed -i", "sed -i 's/a/b/' src/x.ts && npx jest"],
    ["sed with flags", "sed -E -i 's/a/b/' src/x.ts && npx jest"],
    ["git checkout restore", "npx jest; git checkout -- src/x.ts"],
    ["git stash", "git stash && npm test"],
    ["file swap", "mv src/x.ts src/x.bak && npx vitest run"],
  ])("suppresses %s", (_label, command) => {
    expect(isInconclusiveRun(command)).toBe(true);
  });

  it("honours an explicit opt-out marker", () => {
    const command = "ENSEMBLE_NO_AUTOFIX=1 npx jest";
    expect(isInconclusiveRun(command)).toBe(true);
    expect(translateEvent(toolCall(command, FAILING))).toBeUndefined();
  });

  it("still fires on a genuine failing run", () => {
    const command = "npx jest";
    expect(isInconclusiveRun(command)).toBe(false);

    const event = translateEvent(toolCall(command, FAILING));
    expect(event?.type).toBe("test.failure.observed");
  });

  it.each([
    ["a directory change", "cd packages/agent-core && npx jest"],
    ["a build step", "npm run build && npx jest"],
    ["an env var", "CI=1 npx jest --ci"],
    ["a pipe", "npx jest 2>&1 | tail -20"],
    // Regression: a bare /^tee\b/ matched these and silently disabled
    // autofix for one of the most common ways to capture a run.
    ["tee to a log", "npx jest 2>&1 | tee out.log"],
    ["tee to a temp path", "npx jest | tee /tmp/x"],
    ["tee -a", "npm test 2>&1 | tee -a log"],
    // Same class as tee: fixture setup that names no code file.
    ["env fixture setup", "cp .env.test .env && npx jest"],
    ["copying a log aside", "npx jest 2>&1 | tail -5; cp out.log /tmp/"],
  ])("does not suppress %s", (_label, command) => {
    expect(isInconclusiveRun(command)).toBe(false);
    expect(translateEvent(toolCall(command, FAILING))?.type).toBe("test.failure.observed");
  });

  it("still catches tee writing into a source file", () => {
    expect(isInconclusiveRun("echo 'export const x = 1' | tee src/x.ts && npx jest")).toBe(true);
  });

  it("ignores mutation verbs that run no tests at all", () => {
    // Nothing to suppress: this was never a test run, so the existing
    // isTestCommand gate already rejects it and the answer must not flip
    // merely because `cp` appears.
    expect(isInconclusiveRun("cp a b && ls")).toBe(false);
  });

  it("is not fooled by a runner named only as an argument", () => {
    // `cp` present, but `jest` is a FILENAME here, so this was never a
    // test run and suppression is irrelevant either way.
    expect(isInconclusiveRun("cp jest.config.js /tmp/")).toBe(false);
  });
});
