import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentPort } from "@sunstone-partners/ensemble-agent-core";
import { createActivate } from "../src/extension";
import { renderStatusReport, countStates } from "../src/runtime-status";
import {
  cleanupSandboxes,
  enterSandbox,
  fakePi,
  failingToolResult,
  sandbox,
  SandboxFile,
} from "./support/harness";

/**
 * Exit gates 2 and 4 (`br-behavior-runtime-cqrs-xl24.12`, `.20`), and Story
 * 4.1's status report.
 *
 * Gate 4 is acceptance criterion 1 and the clearest single measure of whether
 * this epic succeeded: a maintainer adds a WORKING behavior using package
 * files alone — no TypeScript, no rebuild. Everything in this file therefore
 * writes YAML and markdown into a temp directory and then runs the real
 * `activate()` over it. If any of it needed a code change, it could not be
 * written this way.
 */

jest.setTimeout(60_000);
afterAll(cleanupSandboxes);

/**
 * A behavior that did not exist when the runtime was compiled, with a trigger,
 * a prompt, a condition and a command the runtime has never heard the name of.
 */
const NOVEL_BEHAVIOR = `api_version: ensemble.sunstone.dev/v1
kind: Behavior
metadata:
  name: triage-flaky-suite
  version: 1.0.0
trigger:
  event_type: test.failure.observed
  predicate:
    command: { matches: "pytest" }
policy:
  mode: propose
  timeout: 15m
capabilities:
  tools: [read, grep]
  mutation_classes: []
  commands: [investigation.record]
execution:
  graph: triage-flaky-suite
  test_command: pytest
  workflow:
    schema_version: "1.0.0"
    start: triage
    steps:
      - id: triage
        kind: agent
        prompt: prompts/triage.md
        tools: [read, grep]
        expect: json
        timeout: 3m
        inputs:
          command: \${event.payload.command}
        on_failure: unclear
      - id: record
        kind: command
        command: investigation.record
        args:
          command: \${event.payload.command}
          diagnosis: \${steps.triage.diagnosis}
          confidence: \${steps.triage.confidence}
        on_failure: unclear
      - id: is-flaky
        kind: condition
        left: \${steps.triage.flaky}
        operator: equals
        right: true
        then: flaky
        otherwise: genuine
      - id: flaky
        kind: outcome
        outcome: triage.flaky
        status: succeeded
      - id: genuine
        kind: outcome
        outcome: triage.genuine
        status: succeeded
      - id: unclear
        kind: outcome
        outcome: triage.unclear
        status: inconclusive
outcomes:
  - triage.flaky
  - triage.genuine
  - triage.unclear
`;

const TRIAGE_PROMPT = "Triage {{command}} and report whether it is flaky.\n";

const FILES: readonly SandboxFile[] = [
  { path: ".ensemble/behaviors/triage-flaky-suite/behavior.yaml", contents: NOVEL_BEHAVIOR },
  { path: ".ensemble/behaviors/triage-flaky-suite/prompts/triage.md", contents: TRIAGE_PROMPT },
  { path: "src/app.py", contents: "def add(a, b):\n    return a - b\n" },
  { path: "package.json", contents: JSON.stringify({ name: "novel", version: "1.0.0" }) },
];

function agentEchoingPrompt(reply: string): AgentPort & { prompts: string[]; tools: string[][] } {
  const prompts: string[] = [];
  const tools: string[][] = [];
  return {
    prompts,
    tools,
    async invoke(request) {
      prompts.push(request.prompt);
      tools.push([...request.tools]);
      return { ok: true, reply };
    },
  };
}

const FLAKY = JSON.stringify({ diagnosis: "ordering dependence", confidence: "medium", flaky: true });
const GENUINE = JSON.stringify({ diagnosis: "real arithmetic bug", confidence: "high", flaky: false });

async function dispatch(root: string, agent: AgentPort) {
  enterSandbox(root);
  const instance = createActivate({ agent });
  const { pi, fire, commands } = fakePi();
  instance.activate(pi);
  await fire("tool_result", failingToolResult("pytest", "1 failed, 2 passed"));
  return { instance, commands };
}

describe("a behavior nobody compiled for runs from package data alone", () => {
  it("triggers, interprets every step kind, and reaches its declared outcome", async () => {
    const root = sandbox(FILES);
    const agent = agentEchoingPrompt(FLAKY);

    const { instance } = await dispatch(root, agent);

    const record = instance.runRecords[0];
    expect(record?.behavior).toBe("triage-flaky-suite");
    expect(record?.run?.terminal).toBe("succeeded");
    expect(record?.run?.outcome).toBe("triage.flaky");
    expect(record?.run?.steps.map((s) => s.stepId)).toEqual(["triage", "record", "is-flaky", "flaky"]);

    // The grant the STEP declared is what reached the port, not the
    // behavior's wider list and not a runtime default.
    expect(agent.tools[0]).toEqual(["read", "grep"]);
  });

  it("branches the other way on a different structured result", async () => {
    // Same package, same code, opposite branch — the condition reads a
    // validated field rather than the model's prose.
    const root = sandbox(FILES);
    const { instance } = await dispatch(root, agentEchoingPrompt(GENUINE));
    expect(instance.runRecords[0]?.run?.outcome).toBe("triage.genuine");
  });
});

describe("package assets are editable without a rebuild", () => {
  it("uses the prompt text currently on disk", async () => {
    const root = sandbox(FILES);
    const agent = agentEchoingPrompt(FLAKY);
    await dispatch(root, agent);
    expect(agent.prompts[0]).toContain("report whether it is flaky");

    // Edit the prompt. No compile, no reinstall, no restart of anything but
    // the session itself.
    writeFileSync(
      join(root, ".ensemble/behaviors/triage-flaky-suite/prompts/triage.md"),
      "COMPLETELY DIFFERENT GUIDANCE for {{command}}.\n",
    );

    const second = agentEchoingPrompt(FLAKY);
    await dispatch(root, second);
    expect(second.prompts[0]).toContain("COMPLETELY DIFFERENT GUIDANCE");
    expect(second.prompts[0]).not.toContain("report whether it is flaky");
  });

  it("changes the package digest when a prompt changes, so 'what ran' stays identifiable", async () => {
    const root = sandbox(FILES);
    const first = await dispatch(root, agentEchoingPrompt(FLAKY));
    const before = first.instance.lastActivation()?.compiled[0].manifest.metadata.packageDigest;

    writeFileSync(join(root, ".ensemble/behaviors/triage-flaky-suite/prompts/triage.md"), "different\n");

    const second = await dispatch(root, agentEchoingPrompt(FLAKY));
    const after = second.instance.lastActivation()?.compiled[0].manifest.metadata.packageDigest;

    // Editable text and an identifiable run are not in tension: the manifest
    // digest is unchanged, and the PACKAGE digest moved.
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect(second.instance.lastActivation()?.compiled[0].digest).toBe(
      first.instance.lastActivation()?.compiled[0].digest,
    );
  });

  it("rejects an invalid workflow edit with a diagnostic naming the step", async () => {
    const root = sandbox(FILES);
    writeFileSync(
      join(root, ".ensemble/behaviors/triage-flaky-suite/behavior.yaml"),
      NOVEL_BEHAVIOR.replace("command: investigation.record", "command: investigation.invented"),
    );

    const { instance } = await dispatch(root, agentEchoingPrompt(FLAKY));
    const skipped = instance.lastActivation()?.skipped ?? [];

    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toMatch(/step 'record'/);
    expect(skipped[0].reason).toMatch(/investigation\.invented/);
    // Fail closed: nothing ran.
    expect(instance.runRecords).toEqual([]);
  });

  it("one invalid package does not suppress a valid sibling", async () => {
    const root = sandbox(FILES);
    const broken = join(root, ".ensemble/behaviors/broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "behavior.yaml"), "api_version: v1\nkind: NotABehavior\n");

    const { instance } = await dispatch(root, agentEchoingPrompt(FLAKY));

    expect(instance.lastActivation()?.loaded).toEqual(["triage-flaky-suite"]);
    expect(instance.lastActivation()?.skipped.map((s) => s.behaviorId)).toEqual(["broken"]);
    expect(instance.runRecords[0]?.run?.terminal).toBe("succeeded");
  });

  it("a missing prompt fails activation visibly rather than at invocation", async () => {
    const root = sandbox(FILES.filter((f) => !f.path.endsWith("triage.md")));
    const { instance } = await dispatch(root, agentEchoingPrompt(FLAKY));

    const skipped = instance.lastActivation()?.skipped ?? [];
    expect(skipped[0]?.reason).toMatch(/prompts\/triage\.md' is missing/);
    // The alternative is what used to happen: the run proceeded and reported
    // "no candidate offered", presenting a package error as a model failure.
    expect(instance.runRecords).toEqual([]);
  });
});

describe("status tells the truth about what ran", () => {
  it("distinguishes every lifecycle state and names the ACTIVE package", async () => {
    const root = sandbox(FILES);
    const { instance, commands } = await dispatch(root, agentEchoingPrompt(FLAKY));

    const activation = instance.lastActivation();
    const input = {
      activation,
      eventsSeen: instance.sink.peek().length,
      records: instance.runRecords,
      dispatchesInFlight: 0,
      commandIds: ["fix.propose"],
      approvalChannel: "unavailable - approval-gated commands fail closed",
      agentContainment: "test port",
      logPath: undefined,
    };

    const counts = countStates(input);
    expect(counts).toMatchObject({ discovered: 1, validated: 1, matched: 1, invoked: 1, completed: 1, failed: 0 });

    const report = renderStatusReport(input);
    expect(report).toContain("triage-flaky-suite");
    // The ACTIVE path and the digest together are what make "which code ran"
    // answerable. An installed bundle once ran three commits behind its
    // checkout and several runs tested code that did not contain the fix.
    expect(report).toContain(join(root, ".ensemble", "behaviors", "triage-flaky-suite"));
    expect(report).toMatch(/package {6}: [0-9a-f]{64}/);
    expect(report).toContain("9 step(s)".replace("9", "6"));
    expect(report).toContain("triage.flaky");
    // Local acceptance is restated in full every time, so a reader cannot
    // infer durable guarantees that do not exist.
    expect(report).toMatch(/No durable delivery, scheduling, retry, replay, recovery/);

    // And the command is actually registered with the host.
    expect(commands.has("ensemble-status")).toBe(true);
  });

  it("reports a dispatch-time skip with the condition that actually fired", async () => {
    const root = sandbox(FILES);
    enterSandbox(root);
    const instance = createActivate({ agent: agentEchoingPrompt(FLAKY) });
    const { pi, fire } = fakePi();
    instance.activate(pi);

    const event = failingToolResult("pytest", "1 failed, 2 passed");
    await fire("tool_result", event);
    await fire("tool_result", { ...event, toolCallId: "tr-2" });

    const report = renderStatusReport({
      activation: instance.lastActivation(),
      eventsSeen: instance.sink.peek().length,
      records: instance.runRecords,
      dispatchesInFlight: 0,
      commandIds: [],
      approvalChannel: "none",
      agentContainment: "test port",
      logPath: undefined,
    });

    // The reason is passed through from the code that decided, not re-inferred
    // here from what the state looks like. A diagnostic that guesses is worse
    // than one that says nothing — "not a git work tree" for a clean clone
    // cost real time.
    expect(report).toContain("skipped at dispatch:");
    expect(report).toMatch(/budget exhausted/);
  });
});
