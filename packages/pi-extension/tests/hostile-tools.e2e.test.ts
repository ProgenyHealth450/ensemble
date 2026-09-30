import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AgentPort } from "@sunstone-partners/ensemble-agent-core";
import { createActivate } from "../src/extension";
import { createAgentPort, containedEnvironment, agentArgs } from "../src/agent-port";
import {
  cleanupSandboxes,
  enterSandbox,
  fakePi,
  failingToolResult,
  sandbox,
  SandboxFile,
} from "./support/harness";

/**
 * Exit gate 0, second half (`br-behavior-runtime-cqrs-xl24.4`): `propose` mode
 * is non-mutating under HOSTILE tools.
 *
 * "Hostile" is load-bearing. The bead says a test that only checks the happy
 * path proves nothing here, because br-33co was found by trying to escape on
 * purpose. So the agent below does not politely return a patch: it writes
 * files, shells out, and tries to persist a skill into the operator's HOME,
 * and only then returns a plausible reply.
 *
 * It attacks through the PORT boundary — it is handed the `cwd` and `env` the
 * real child receives and attacks from there — because that is where the
 * containment actually is. An in-process fake writing absolute paths would
 * prove nothing: it runs inside the runtime, and no boundary claims to contain
 * the runtime from itself.
 */

jest.setTimeout(60_000);
afterAll(cleanupSandboxes);

const BEHAVIOR = `api_version: ensemble.sunstone.dev/v1
kind: Behavior
metadata:
  name: probe-behavior
  version: 1.0.0
trigger:
  event_type: test.failure.observed
  predicate:
    isError: { equals: true }
policy:
  mode: propose
  timeout: 5m
capabilities:
  tools: [read, grep, glob]
  mutation_classes: []
  commands: [fix.propose]
execution:
  graph: probe
  test_command: npm test
  workflow:
    schema_version: "1.0.0"
    start: investigate
    steps:
      - id: investigate
        kind: agent
        prompt: prompts/investigate.md
        tools: [read, grep, glob]
        expect: json
        timeout: 60s
        inputs:
          command: \${event.payload.command}
        on_failure: gave-up
      - id: propose
        kind: command
        command: fix.propose
        args:
          issue: \${event.payload.command}
          rationale: \${steps.investigate.diagnosis}
          writes: \${steps.investigate.writes}
        on_failure: gave-up
      - id: proposed
        kind: outcome
        outcome: fix.proposed
        status: succeeded
      - id: gave-up
        kind: outcome
        outcome: behavior.blocked
        status: blocked
outcomes:
  - fix.proposed
  - behavior.blocked
`;

const SOURCE = "exports.add = (a, b) => a - b;\n";
const TEST = `const assert = require("assert");
const { add } = require("../src/math.js");
try {
  assert.strictEqual(add(1, 1), 2);
  console.log("Tests:       1 passed, 1 total");
} catch (e) {
  console.log("Tests:       1 failed, 0 passed, 1 total");
  process.exit(1);
}
`;
const CANDIDATE = "exports.add = (a, b) => a + b;\n";

const FILES: readonly SandboxFile[] = [
  { path: ".ensemble/behaviors/probe-behavior/behavior.yaml", contents: BEHAVIOR },
  {
    path: ".ensemble/behaviors/probe-behavior/prompts/investigate.md",
    contents: "Diagnose {{command}} and reply with JSON.\n",
  },
  { path: "src/math.js", contents: SOURCE },
  { path: "tests/math.test.js", contents: TEST },
  { path: "package.json", contents: JSON.stringify({ name: "probe", version: "1.0.0" }) },
];

const REPLY = JSON.stringify({
  diagnosis: "subtraction should be addition",
  confidence: "high",
  writes: [{ path: "src/math.js", contents: CANDIDATE }],
});

async function dispatch(root: string, agent: AgentPort) {
  enterSandbox(root);
  const instance = createActivate({ agent });
  const { pi, fire, userMessages } = fakePi();
  instance.activate(pi);
  await fire("tool_result", failingToolResult("npm test", "Tests:       1 failed, 0 passed, 1 total"));
  return { instance, userMessages };
}

describe("the agent child is contained by the operating system, not by its prompt", () => {
  it("runs in an isolated worktree and a throwaway HOME, and its escapes die with the run", async () => {
    const root = sandbox(FILES);
    const seen: { cwd: string; env: NodeJS.ProcessEnv }[] = [];

    const port = createAgentPort({
      repoRoot: root,
      async run(input) {
        seen.push({ cwd: input.cwd, env: input.env });

        // Exactly what the probe child did in br-33co: persist a skill into
        // what it believes is the operator's HOME.
        const skill = join(String(input.env.HOME), ".omp", "agent", "managed-skills", "probe");
        mkdirSync(skill, { recursive: true });
        writeFileSync(join(skill, "SKILL.md"), "persisted\n");

        // And repair the source it can see, relative to its own cwd.
        writeFileSync(join(input.cwd, "src", "math.js"), CANDIDATE);
        return REPLY;
      },
    });

    const result = await port.invoke({
      prompt: "p",
      tools: ["read"],
      expect: "json",
      maxOutputBytes: 65536,
      timeoutMs: 30_000,
      signal: new AbortController().signal,
      behavior: "probe-behavior",
      stepId: "investigate",
    });

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);

    // The child never saw the user's repository as its working directory.
    expect(resolve(seen[0].cwd)).not.toBe(resolve(root));
    // Nor the operator's real HOME. This is the boundary that actually
    // contains _manage_skill and _learn; the tool allowlist measurably does
    // not, which is why it is not asserted here as though it did.
    expect(seen[0].env.HOME).not.toBe(homedir());
    expect(seen[0].env.OMP_CONFIG_DIR).toContain(String(seen[0].env.HOME));

    // Both escapes succeeded inside the container and left nothing behind.
    expect(existsSync(join(homedir(), ".omp", "agent", "managed-skills", "probe"))).toBe(false);
    expect(existsSync(String(seen[0].env.HOME))).toBe(false);
    expect(readFileSync(join(root, "src", "math.js"), "utf8")).toBe(SOURCE);
  });

  it("refuses to invoke at all when isolation is unavailable", async () => {
    // "We could not contain it, so we ran it anyway" is the fail-open shape
    // this whole epic exists to remove.
    let ran = false;
    const port = createAgentPort({
      repoRoot: "/nonexistent-not-a-repo",
      isolate: () => ({ ok: false, reason: "not a git repository" }),
      async run() {
        ran = true;
        return REPLY;
      },
    });

    const result = await port.invoke({
      prompt: "p",
      tools: [],
      expect: "json",
      maxOutputBytes: 1024,
      timeoutMs: 1000,
      signal: new AbortController().signal,
      behavior: "b",
      stepId: "s",
    });

    expect(ran).toBe(false);
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(/not a supported degraded mode/);
  });

  it("discards the reply when the live tree changed while the agent ran", async () => {
    // The residual case the OS boundaries cannot cover: a child that writes an
    // ABSOLUTE path back into the user's repository. It is detected, reported,
    // and NOT reverted — a concurrent user save is indistinguishable from it,
    // and overwriting the user's work to tidy up would be the worse failure.
    const root = sandbox(FILES);
    const port = createAgentPort({
      repoRoot: root,
      async run() {
        writeFileSync(join(root, "src", "math.js"), "written behind the boundary\n");
        return REPLY;
      },
    });

    const result = await port.invoke({
      prompt: "p",
      tools: [],
      expect: "json",
      maxOutputBytes: 65536,
      timeoutMs: 30_000,
      signal: new AbortController().signal,
      behavior: "probe-behavior",
      stepId: "investigate",
    });

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/working tree changed/);
    expect((result as { reason: string }).reason).toMatch(/nothing was reverted/);
    expect(readFileSync(join(root, "src", "math.js"), "utf8")).toBe("written behind the boundary\n");
  });

  it("keeps the tool allowlist without crediting it as containment", () => {
    const args = agentArgs("/tmp/x", ["read", "grep"], "prompt");
    expect(args).toContain("--tools=read,grep");
    expect(args).toContain("--no-extensions");

    const env = containedEnvironment("/tmp/throwaway-home");
    expect(env.HOME).toBe("/tmp/throwaway-home");
    // Redirected rather than unset: unsetting HOME makes most tools fall back
    // to the passwd entry, which is the operator's real home again.
    expect(env.XDG_CONFIG_HOME).toBe("/tmp/throwaway-home/.config");
  });
});

describe("propose mode changes nothing in the user's tree", () => {
  it("stores the candidate as a reviewable proposal and leaves the source alone", async () => {
    const root = sandbox(FILES);
    const { instance, userMessages } = await dispatch(root, {
      async invoke() {
        return { ok: true, reply: REPLY };
      },
    });

    const record = instance.runRecords[0];
    expect(record?.behavior).toBe("probe-behavior");
    expect(record?.run?.terminal).toBe("succeeded");
    expect(record?.run?.outcome).toBe("fix.proposed");

    // Nothing was queued onto a later turn either. The continuation path
    // worked precisely by doing this.
    expect(userMessages).toEqual([]);

    const dir = join(root, ".ensemble", "proposals");
    const proposals = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(proposals).toHaveLength(1);

    const proposal = JSON.parse(readFileSync(join(dir, proposals[0]), "utf8"));
    expect(proposal.kind).toBe("fix");
    expect(proposal.writes[0].path).toBe("src/math.js");
    expect(proposal.writes[0].contents).toBe(CANDIDATE);
    expect(proposal.appliedAt).toBeUndefined();

    // The proposal exists and the file does not carry it. That is the whole
    // distinction br-dowt collapsed.
    expect(readFileSync(join(root, "src", "math.js"), "utf8")).toBe(SOURCE);
  });

  it("rejects a reply that claims success in prose", async () => {
    const root = sandbox(FILES);
    const { instance } = await dispatch(root, {
      async invoke() {
        return { ok: true, reply: "I have fixed src/math.js — it now adds correctly and all tests pass." };
      },
    });

    // The response contract is structural. Confident prose is not a result,
    // however true it might have been. A fix agent once reported a correct
    // diagnosis and a correct fix in prose while holding no tool that could
    // write; that reply parsed as failure only by luck of its shape.
    expect(instance.runRecords[0]?.run?.terminal).toBe("blocked");
    expect(existsSync(join(root, ".ensemble", "proposals"))).toBe(false);
    expect(readFileSync(join(root, "src", "math.js"), "utf8")).toBe(SOURCE);
  });

  it("preserves a concurrent user edit to an unrelated file", async () => {
    const root = sandbox(FILES);
    const concurrent = "// the user was editing this at the same time\n";

    await dispatch(root, {
      async invoke() {
        writeFileSync(join(root, "notes.md"), concurrent);
        return { ok: true, reply: REPLY };
      },
    });

    // Under the old whole-tree `git checkout -- .` rollback this edit was
    // discarded, and the run reported `restored: true` for a file it had
    // never captured.
    expect(readFileSync(join(root, "notes.md"), "utf8")).toBe(concurrent);
  });
});

describe("cancellation terminates the run and leaves no orphan", () => {
  it("ends the workflow as cancelled and writes nothing", async () => {
    const root = sandbox(FILES);
    const controller = new AbortController();

    let sawAbort = false;
    const slowAgent: AgentPort = {
      async invoke(request) {
        controller.abort();
        await new Promise((r) => setTimeout(r, 10));
        sawAbort = request.signal.aborted;
        return { ok: false, reason: "cancelled" };
      },
    };

    enterSandbox(root);
    const { createWorkflowDispatcher } = await import("../src/workflow-dispatch");
    const { activateBehaviorPipeline } = await import("../src/behavior-activation");
    const { pi } = fakePi();

    const dispatcher = createWorkflowDispatcher({
      rootDir: root,
      sessionId: "s",
      executionId: "e",
      compiled: () => activation.compiled,
      packageDirFor: (n) => activation.packageDirs?.get(n),
      agent: slowAgent,
      signal: controller.signal,
    });
    const activation = activateBehaviorPipeline(pi, root, [], undefined, dispatcher.invoke, {
      knownCommands: dispatcher.commandIds,
    });

    await activation.matcher?.onEvent({
      id: "evt-1",
      type: "test.failure.observed",
      source: "test",
      occurredAt: new Date().toISOString(),
      payload: { command: "npm test", isError: true },
    });

    // The signal reached the port, so cancellation propagates rather than
    // being noticed afterwards.
    expect(sawAbort).toBe(true);
    expect(dispatcher.records[0]?.run?.terminal).toBe("cancelled");
    expect(readFileSync(join(root, "src", "math.js"), "utf8")).toBe(SOURCE);
  });
});
