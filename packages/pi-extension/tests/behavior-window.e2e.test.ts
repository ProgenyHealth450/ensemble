import { execFileSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentPort } from "@sunstone-partners/ensemble-agent-core";
import { createActivate, drainDispatches } from "../src/extension";

/**
 * The behavior execution window, on the CQRS runtime.
 *
 * The write boundary is split by REASON (br-vjm5, resolved on dev in
 * c6b93dd): guardrails, the constitution and conformance fixtures are
 * protected for the whole session; test files and build configuration only
 * while a behavior is executing. On this runtime "executing" is a governed
 * dispatch -- the same window that already scopes tool grants -- so these
 * tests open it by starting a real dispatch through production activate()
 * and holding its agent step open.
 *
 * Real git repositories and real files throughout; only the Pi host is
 * faked. Handlers run in registration order and dispatch is NOT drained
 * between events, so a test can act while a run is in flight.
 *
 * Deliberately NOT carried over from dev's version of this suite, because
 * the mechanism each one exercised no longer exists here: the propose-mode
 * hold of a continuation fix (br-xz6q; propose cannot mutate at all now),
 * the window closing at the fix turn's final answer (br-kluf; there is no
 * injected fix turn), and the rollback notice (br-o9j1; nothing is applied
 * to the live tree before verification, so nothing is rolled back).
 */

jest.setTimeout(30_000);

const dirs: string[] = [];
const originalCwd = process.cwd();
// Every held run is released after each test, so a failing assertion cannot
// leave a dispatch pending and hang the worker.
const gates: EventEmitter[] = [];
afterEach(async () => {
  gates.splice(0).forEach((g) => g.emit("release"));
  await drainDispatches();
});
afterAll(() => {
  process.chdir(originalCwd);
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

/** Runs at every session start -- a trigger the harness genuinely emits. */
const SESSION_BEHAVIOR = `api_version: ensemble.sunstone.dev/v1
kind: Behavior
metadata:
  name: session-check
  version: 1.0.0
trigger:
  event_type: runtime.session.started
policy:
  mode: propose
  timeout: 10m
capabilities:
  tools: [read]
  mutation_classes: []
  commands: []
execution:
  graph: session-check
  workflow:
    schema_version: "1.0.0"
    start: look
    steps:
      - id: look
        kind: agent
        prompt: prompts/look.md
        tools: [read]
        expect: json
        timeout: 2m
        on_failure: done
      - id: done
        kind: outcome
        outcome: investigation.inconclusive
        status: inconclusive
outcomes:
  - investigation.inconclusive
`;

const TEST_FILE = "tests/math.test.js";
const TEST_ORIGINAL = "// asserts add(1, 2) === 3\n";
const TEST_EDITED = "// asserts add(1, 2) === 3\n// edited\n";
const BUILD_CONFIG = "package.json";
const BUILD_ORIGINAL = JSON.stringify({ name: "sandbox", version: "1.0.0" }, null, 2);
const BUILD_EDITED = JSON.stringify({ name: "sandbox", version: "1.0.1" }, null, 2);
const GUARD = "docs/standards/constitution.md";

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "behavior-window-"));
  dirs.push(root);
  const files: Record<string, string> = {
    ".ensemble/config.yaml": "behaviors:\n  armed: true\n",
    ".ensemble/behaviors/session-check/behavior.yaml": SESSION_BEHAVIOR,
    ".ensemble/behaviors/session-check/prompts/look.md": "Look around.\n",
    [TEST_FILE]: TEST_ORIGINAL,
    [BUILD_CONFIG]: BUILD_ORIGINAL,
    [GUARD]: "# rules\n",
  };
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("add", "-A");
  git("commit", "-qm", "initial");
  return root;
}

type Reply = { isError: boolean; content: { text: string }[] } | undefined;

function start() {
  const root = sandbox();
  process.chdir(root);

  // The behavior's agent step blocks until released, so the window stays open.
  const gate = new EventEmitter();
  gates.push(gate);
  const agent: AgentPort = {
    async invoke() {
      await once(gate, "release");
      return { ok: true, reply: JSON.stringify({ note: "nothing to report" }) };
    },
  };

  const handlers = new Map<string, ((e: unknown) => unknown)[]>();
  const pi = {
    registerCommand: () => undefined,
    registerTool: () => undefined,
    registerFlag: () => undefined,
    getFlag: () => false,
    on: (name: string, h: (e: unknown) => unknown) => {
      handlers.set(name, [...(handlers.get(name) ?? []), h]);
      return () => undefined;
    },
  } as unknown as ExtensionAPI;

  const instance = createActivate({ agent });
  instance.activate(pi);

  /** Fires every handler in order; returns the first non-undefined reply. */
  const fire = async (name: string, event: unknown = {}): Promise<Reply> => {
    let reply: Reply;
    for (const h of handlers.get(name) ?? []) {
      const r = (await h(event)) as Reply;
      reply ??= r;
    }
    return reply;
  };

  const openWindow = async () => {
    await fire("session_start", { type: "session_start" });
    expect(instance.runRecords.some((r) => r.behavior === "session-check" && r.abandoned)).toBe(true);
  };
  const closeWindow = async () => {
    gate.emit("release");
    await drainDispatches();
  };

  return { root, fire, openWindow, closeWindow };
}

const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");
const edit = (root: string, path: string, contents: string) => writeFileSync(join(root, path), contents);

describe("the user's working material is protected only while a behavior runs (br-vjm5, br-afik)", () => {
  it("leaves the user's own test and build-config edits alone when no behavior is running", async () => {
    const { root, fire } = start();

    edit(root, TEST_FILE, TEST_EDITED);
    edit(root, BUILD_CONFIG, BUILD_EDITED);

    expect(await fire("tool_result")).toBeUndefined();
    expect(read(root, TEST_FILE)).toBe(TEST_EDITED);
    expect(read(root, BUILD_CONFIG)).toBe(BUILD_EDITED);
  });

  it("reverts a test-file or build-config write made while a behavior runs", async () => {
    const { root, fire, openWindow, closeWindow } = start();
    await openWindow();

    edit(root, TEST_FILE, TEST_EDITED);
    edit(root, BUILD_CONFIG, BUILD_EDITED);
    const reply = await fire("tool_result");

    expect(reply?.isError).toBe(true);
    expect(reply?.content[0].text).toMatch(/tests\/math\.test\.js \(test-file\) was reverted/);
    expect(reply?.content[0].text).toMatch(/package\.json \(build-config\) was reverted/);
    expect(read(root, TEST_FILE)).toBe(TEST_ORIGINAL);
    expect(read(root, BUILD_CONFIG)).toBe(BUILD_ORIGINAL);
    await closeWindow();
  });

  it("baselines at window open, so the user's changes from before it are kept", async () => {
    const { root, fire, openWindow, closeWindow } = start();

    edit(root, TEST_FILE, TEST_EDITED);
    expect(await fire("tool_result")).toBeUndefined();

    await openWindow();
    expect(await fire("tool_result")).toBeUndefined();
    expect(read(root, TEST_FILE)).toBe(TEST_EDITED);
    await closeWindow();
  });
});

describe("guardrails stay protected between behavior windows", () => {
  it("reverts a guardrail write when no behavior has ever run, and offers consent", async () => {
    const { root, fire } = start();

    edit(root, GUARD, "# rules\n- a rule the model added itself\n");
    const reply = await fire("tool_result");

    expect(read(root, GUARD)).toBe("# rules\n");
    expect(reply?.isError).toBe(true);
    expect(reply?.content[0].text).toMatch(/\/ensemble-approve \d+/);
  });

  it("does not adopt a tamper landing before a window opens (7663810)", async () => {
    const { root, fire, openWindow, closeWindow } = start();

    // No tool call follows this write, so nothing checks it before the next
    // session event opens a window. Rebuilding the monitor at that moment
    // would baseline the guardrail AS TAMPERED and bless it.
    edit(root, GUARD, "# rules\n- smuggled before the widen\n");
    await openWindow();

    const reply = await fire("tool_result");
    expect(read(root, GUARD)).toBe("# rules\n");
    expect(reply?.isError).toBe(true);
    await closeWindow();
  });

  it("still reverts a guardrail write AFTER a window has closed, while user files are theirs again", async () => {
    const { root, fire, openWindow, closeWindow } = start();
    await openWindow();
    await closeWindow();

    edit(root, TEST_FILE, TEST_EDITED);
    expect(await fire("tool_result")).toBeUndefined();
    expect(read(root, TEST_FILE)).toBe(TEST_EDITED);

    edit(root, GUARD, "# rules\n- added after the window closed\n");
    const reply = await fire("tool_result");
    expect(read(root, GUARD)).toBe("# rules\n");
    expect(reply?.isError).toBe(true);
  });
});
