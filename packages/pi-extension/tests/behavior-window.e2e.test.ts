import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createActivate, drainDispatches } from "../src/extension";
import { activeBehaviorScope } from "../src/tool-grant-enforcement";

/**
 * The behavior execution window: tool grants AND the write boundary apply
 * only from the moment a fix turn is injected until the model finishes
 * answering it.
 *
 * Observed before this change (dev e2e, 2026-09-27):
 *  - br-vjm5: with NO behavior running, a user's plain request to edit a
 *    test file was reverted, and a legitimate `git pull` was undone,
 *    because the write boundary was armed for the whole session against an
 *    activation-time baseline.
 *  - br-kluf: the window closed only at agent_end. In an interactive
 *    session the fix turn and everything after it were one agent run, so
 *    the behavior's grants covered the user's own work for several
 *    replies, and the late verification rolled their tree back.
 *
 * Real git, real child-process test commands; only the Pi event surface
 * and the model's own edits are simulated.
 */

const BEHAVIOR = `api_version: ensemble.sunstone.dev/v1
kind: Behavior
metadata:
  name: fix-failing-test
  version: 1.0.0
trigger:
  event_type: test.failure.observed
  predicate:
    isError: { equals: true }
policy:
  mode: propose
  timeout: 30m
capabilities:
  tools: [read, edit]
  mutation_classes: [artifact.write]
execution:
  graph: fix-failing-test
  test_command: node run-all.js
outcomes:
  - test.failure.investigated
`;

const RUN = `const { add } = require("./src/math.js");
if (add(1, 2) === 3) {
  console.log("Tests:       1 passed, 1 total");
  process.exit(0);
}
console.log("Tests:       1 failed, 0 passed, 1 total");
process.exit(1);
`;

const BROKEN = "exports.add = (a, b) => a - b;\n";
const GOOD_FIX = "exports.add = (a, b) => a + b;\n";
const TEST_FILE = "tests/math.test.js";
const TEST_ORIGINAL = "// asserts add(1, 2) === 3\n";
const TEST_EDITED = "// asserts add(1, 2) === 3\n// edited\n";

const dirs: string[] = [];
const originalCwd = process.cwd();
afterAll(() => {
  process.chdir(originalCwd);
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "behavior-window-"));
  dirs.push(root);
  const bdir = join(root, ".ensemble", "behaviors", "fix-failing-test");
  mkdirSync(bdir, { recursive: true });
  writeFileSync(join(bdir, "behavior.yaml"), BEHAVIOR);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, "src", "math.js"), BROKEN);
  writeFileSync(join(root, TEST_FILE), TEST_ORIGINAL);
  writeFileSync(join(root, "run-target.js"), RUN);
  writeFileSync(join(root, "run-all.js"), RUN);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "sandbox", version: "1.0.0", scripts: { test: "node run-target.js" } }, null, 2),
  );
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "test"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: root });
  return root;
}

type ToolResultReply = { isError?: boolean; content?: { text: string }[] } | undefined;

function fakePi() {
  const handlers = new Map<string, ((e: unknown) => unknown)[]>();
  const sent: string[] = [];
  const notices: { message: { customType: string; content: string; display?: boolean }; options?: unknown }[] = [];
  const pi = {
    registerCommand: () => undefined,
    registerTool: () => undefined,
    registerFlag: () => undefined,
    getFlag: () => false,
    sendUserMessage: (m: string) => {
      sent.push(m);
    },
    sendMessage: (message: (typeof notices)[number]["message"], options?: unknown) => {
      notices.push({ message, options });
    },
    on: (name: string, h: (e: unknown) => unknown) => {
      handlers.set(name, [...(handlers.get(name) ?? []), h]);
      return () => undefined;
    },
  } as unknown as ExtensionAPI;

  /** Fires an event; returns the first non-undefined handler reply. */
  const fire = async (n: string, e?: unknown): Promise<ToolResultReply> => {
    let reply: ToolResultReply;
    for (const h of handlers.get(n) ?? []) {
      const r = (await h(e)) as ToolResultReply;
      reply ??= r;
    }
    await drainDispatches();
    return reply;
  };
  return { pi, fire, sent, notices };
}

/** A tool call the model (or user) made; the monitor checks after each. */
const toolDone = { type: "tool_result", toolCallId: "t", toolName: "edit", input: {}, content: [], isError: false };
/** A turn that ran tools: the model is not done yet. */
const turnWithTools = { type: "turn_end", toolResults: [{}] };
/** A turn that ran no tools: the model's final answer. */
const finalTurn = { type: "turn_end", toolResults: [] };

async function start() {
  const root = sandbox();
  const instance = createActivate({ proposeFix: () => undefined });
  process.chdir(root);
  const harness = fakePi();
  instance.activate(harness.pi);
  expect(instance.lastActivation()!.loaded).toEqual(["fix-failing-test"]);
  return { root, pi: harness.pi, fire: harness.fire, sent: harness.sent, notices: harness.notices };
}

/** The real failing command fails, then the turn it ran in ends: the fix turn is injected. */
async function openFixTurn(fire: (n: string, e?: unknown) => Promise<ToolResultReply>) {
  await fire("tool_result", {
    type: "tool_result",
    toolCallId: "run-1",
    toolName: "bash",
    input: { command: "npm test" },
    content: [{ type: "text", text: "1 failed" }],
    isError: true,
  });
  await fire("turn_end", turnWithTools);
}

const read = (root: string, p: string) => readFileSync(join(root, p), "utf8");

describe("write boundary is armed only inside a behavior window (br-vjm5)", () => {
  it("leaves the user's own test edit alone when no behavior is running", async () => {
    const { root, fire } = await start();

    writeFileSync(join(root, TEST_FILE), TEST_EDITED);
    const reply = await fire("tool_result", toolDone);

    expect(reply).toBeUndefined();
    expect(read(root, TEST_FILE)).toBe(TEST_EDITED);
  });

  it("reverts a protected write made during the fix turn", async () => {
    const { root, fire, pi } = await start();
    await openFixTurn(fire);
    expect(activeBehaviorScope(pi)).toEqual(["fix-failing-test"]);

    writeFileSync(join(root, TEST_FILE), TEST_EDITED);
    const reply = await fire("tool_result", toolDone);

    expect(reply?.isError).toBe(true);
    expect(reply?.content?.[0].text).toMatch(/tests\/math\.test\.js \(test-file\) was reverted/);
    expect(read(root, TEST_FILE)).toBe(TEST_ORIGINAL);
  });

  it("baselines at window open, so changes made before it (a pull, the user's edit) are kept", async () => {
    const { root, fire } = await start();

    // Before any behavior runs: the user edits a test (or a pull moves it).
    writeFileSync(join(root, TEST_FILE), TEST_EDITED);
    await fire("tool_result", toolDone);

    await openFixTurn(fire);
    // Any tool call inside the window runs the check.
    const reply = await fire("tool_result", toolDone);

    expect(reply).toBeUndefined();
    expect(read(root, TEST_FILE)).toBe(TEST_EDITED);
  });
});

describe("the behavior window ends with the fix turn, not the agent run (br-kluf)", () => {
  it("stays open across turns that ran tools", async () => {
    const { fire, pi } = await start();
    await openFixTurn(fire);

    await fire("turn_end", turnWithTools);
    await fire("turn_end", turnWithTools);

    expect(activeBehaviorScope(pi)).toEqual(["fix-failing-test"]);
  });

  it("closes and verifies at the model's final answer, before agent_end", async () => {
    const { root, fire, pi, sent } = await start();
    await openFixTurn(fire);
    expect(sent).toHaveLength(1);

    writeFileSync(join(root, "src", "math.js"), GOOD_FIX);
    await fire("turn_end", finalTurn);

    expect(activeBehaviorScope(pi)).toBeUndefined();
    const log = read(root, ".ensemble/runtime-log.jsonl");
    expect(log).toMatch(/"kind":"verification".*"status":"passed"/);
    expect(read(root, "src/math.js")).toBe(GOOD_FIX);

    // After the window: the user's own work is untouched by the boundary...
    writeFileSync(join(root, TEST_FILE), TEST_EDITED);
    expect(await fire("tool_result", toolDone)).toBeUndefined();
    expect(read(root, TEST_FILE)).toBe(TEST_EDITED);

    // ...and agent_end, arriving later, does not verify or roll back again.
    await fire("agent_end", { type: "agent_end", messages: [] });
    const verifications = read(root, ".ensemble/runtime-log.jsonl").match(/"kind":"verification"/g) ?? [];
    expect(verifications).toHaveLength(1);
    expect(read(root, TEST_FILE)).toBe(TEST_EDITED);
  });

  it("rolls back a fix that fails verification at the final answer, and says so", async () => {
    const { root, fire, notices } = await start();
    await openFixTurn(fire);

    // The model writes a wrong fix and answers.
    writeFileSync(join(root, "src", "math.js"), "exports.add = () => 0;\n");
    await fire("turn_end", finalTurn);

    expect(read(root, ".ensemble/runtime-log.jsonl")).toMatch(/"kind":"verification".*"status":"failed"/);
    expect(read(root, "src/math.js")).toBe(BROKEN);
    // br-o9j1: not silent. The model is told, ahead of anything queued.
    expect(notices).toHaveLength(1);
    expect(notices[0].message.customType).toBe("ensemble-autofix-rollback");
    expect(notices[0].message.display).toBe(true);
    expect(notices[0].message.content).toMatch(/FAILED verification/);
    expect(notices[0].message.content).toMatch(/ROLLED BACK/);
    expect(notices[0].options).toEqual({ triggerTurn: true, deliverAs: "steer" });
  });

  it("sends no notice when the fix passes", async () => {
    const { root, fire, notices } = await start();
    await openFixTurn(fire);
    writeFileSync(join(root, "src", "math.js"), GOOD_FIX);

    await fire("turn_end", finalTurn);

    expect(notices).toHaveLength(0);
  });

  it("agent_end still closes the window and verifies when no final turn was seen", async () => {
    const { root, fire, pi } = await start();
    await openFixTurn(fire);
    writeFileSync(join(root, "src", "math.js"), GOOD_FIX);

    await fire("agent_end", { type: "agent_end", messages: [] });

    expect(activeBehaviorScope(pi)).toBeUndefined();
    expect(read(root, ".ensemble/runtime-log.jsonl")).toMatch(/"kind":"verification".*"status":"passed"/);
    writeFileSync(join(root, TEST_FILE), TEST_EDITED);
    expect(await fire("tool_result", toolDone)).toBeUndefined();
  });

  it("session_shutdown closes an open window", async () => {
    const { fire, pi } = await start();
    await openFixTurn(fire);

    await fire("session_shutdown", { type: "session_shutdown" });

    expect(activeBehaviorScope(pi)).toBeUndefined();
  });
});

describe("a turn with no tool calls mid-fix hands control back", () => {
  // A clarifying question, or a text-only reply, with the fix unfinished.
  // If the run continues (the user answers, a queued message arrives),
  // what follows answers NEW input. It runs under the user's grants, and
  // the unfinished fix has already been graded -- so the model must be
  // told its edits were rolled back before it edits again.
  it("closes the window, grades the unfinished fix, and tells the model before it continues", async () => {
    const { root, fire, pi, notices } = await start();
    await openFixTurn(fire);

    // Half a fix, then a question for the user.
    writeFileSync(join(root, "src", "math.js"), "exports.add = (a, b) => a;\n");
    await fire("turn_end", turnWithTools);
    await fire("turn_end", finalTurn);

    expect(activeBehaviorScope(pi)).toBeUndefined();
    expect(read(root, "src/math.js")).toBe(BROKEN);
    expect(notices).toHaveLength(1);
    expect(notices[0].message.content).toMatch(/no longer on disk/);

    // The user answers; the model carries on in the same run. The test
    // edit is the user's call now, so the boundary does not revert it.
    writeFileSync(join(root, TEST_FILE), TEST_EDITED);
    expect(await fire("tool_result", toolDone)).toBeUndefined();
    await fire("turn_end", turnWithTools);
    expect(read(root, TEST_FILE)).toBe(TEST_EDITED);

    // The run's end does not grade or roll back a second time.
    await fire("agent_end", { type: "agent_end", messages: [] });
    expect(read(root, ".ensemble/runtime-log.jsonl").match(/"kind":"verification"/g)).toHaveLength(1);
    expect(notices).toHaveLength(1);
  });

  it.each(["error", "aborted"])("an %s turn closes the window and grades the fix", async (stopReason) => {
    const { root, fire, pi } = await start();
    await openFixTurn(fire);
    writeFileSync(join(root, "src", "math.js"), GOOD_FIX);

    await fire("turn_end", { type: "turn_end", toolResults: [], message: { role: "assistant", stopReason } });

    expect(activeBehaviorScope(pi)).toBeUndefined();
    expect(read(root, ".ensemble/runtime-log.jsonl")).toMatch(/"kind":"verification".*"status":"passed"/);
    expect(read(root, "src/math.js")).toBe(GOOD_FIX);
  });
});
