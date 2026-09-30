import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ProposalStore,
  createCommandCatalog,
  discoverBehaviorPackages,
  compile,
  readPackageAsset,
  BUILTIN_COMMAND_CAPABILITIES,
  translateEvent,
  normalizeEvent,
  ACTIVATION_SEARCH_ROOTS,
} from "@sunstone-partners/ensemble-agent-core";
import { AgentPort } from "@sunstone-partners/ensemble-agent-core";
import { createActivate } from "../src/extension";
import { fromToolResult } from "../src/pi-events";
import {
  cleanupSandboxes,
  enterSandbox,
  fakePi,
  failingToolResult,
  sandbox,
  SandboxFile,
} from "./support/harness";

/**
 * REQ-008 / REQ-BEH-005 portability: the whole pipeline on a repository that
 * looks nothing like this one — no `packages/` directory, a non-npm test
 * command, and an Elixir-shaped test runner.
 *
 * Assembled from the real exported units with no per-test shims. A fake at any
 * link would hide exactly the coupling this requirement exists to disprove.
 */

jest.setTimeout(60_000);
afterAll(cleanupSandboxes);

const ELIXIR_BEHAVIOR = `api_version: ensemble.sunstone.dev/v1
kind: Behavior
metadata:
  name: elixir-investigate
  version: 1.0.0
trigger:
  event_type: test.failure.observed
  predicate:
    isError: { equals: true }
policy:
  mode: propose
  timeout: 30m
capabilities:
  tools: [read, grep]
  mutation_classes: []
  commands: [investigation.record, fix.propose]
execution:
  graph: elixir-investigate
  test_command: mix test
  workflow:
    schema_version: "1.0.0"
    start: investigate
    steps:
      - id: investigate
        kind: agent
        prompt: prompts/diagnose.md
        tools: [read, grep]
        expect: json
        timeout: 5m
        inputs:
          command: \${event.payload.command}
        on_failure: inconclusive
      - id: record
        kind: command
        command: investigation.record
        args:
          command: \${event.payload.command}
          diagnosis: \${steps.investigate.diagnosis}
          confidence: \${steps.investigate.confidence}
        on_failure: inconclusive
      - id: propose
        kind: command
        command: fix.propose
        args:
          issue: \${event.payload.command}
          rationale: \${steps.investigate.diagnosis}
          writes: \${steps.investigate.writes}
        on_failure: inconclusive
      - id: proposed
        kind: outcome
        outcome: fix.proposed
        status: succeeded
      - id: inconclusive
        kind: outcome
        outcome: investigation.inconclusive
        status: inconclusive
outcomes:
  - fix.proposed
  - investigation.inconclusive
`;

const LIB = "defmodule Calc do\n  def add(a, b), do: a - b\nend\n";
const MIX_FAILURE = "  1) test adds (CalcTest)\n     Assertion failed\n\n8 tests, 1 failure\n";

/** No `packages/` directory anywhere: behaviors live at `.ensemble/behaviors`. */
const FILES: readonly SandboxFile[] = [
  { path: ".ensemble/behaviors/elixir-investigate/behavior.yaml", contents: ELIXIR_BEHAVIOR },
  { path: ".ensemble/behaviors/elixir-investigate/prompts/diagnose.md", contents: "Diagnose {{command}}.\n" },
  { path: "lib/calc.ex", contents: LIB },
  { path: "test/calc_test.exs", contents: "defmodule CalcTest do\nend\n" },
  { path: "mix.exs", contents: "defmodule Calc.MixProject do\nend\n" },
];

const REPLY = JSON.stringify({
  diagnosis: "add/2 subtracts",
  confidence: "high",
  writes: [{ path: "lib/calc.ex", contents: "defmodule Calc do\n  def add(a, b), do: a + b\nend\n" }],
});

const agent: AgentPort = {
  async invoke() {
    return { ok: true, reply: REPLY };
  },
};

describe("a repository with no packages/ directory and a non-npm runner", () => {
  it("discovers and compiles the behavior from .ensemble/behaviors", () => {
    const root = sandbox(FILES);
    const catalog = createCommandCatalog({ workspaceRoot: root, store: new ProposalStore(root) });

    const discovered = discoverBehaviorPackages(root, { searchRoots: [...ACTIVATION_SEARCH_ROOTS] });
    expect(discovered.map((d) => d.behaviorId)).toEqual(["elixir-investigate"]);

    const pkg = discovered[0];
    const dir = join(root, ".ensemble", "behaviors", "elixir-investigate");
    const result = compile(
      { behaviors: [pkg.manifest!] },
      {
        knownCommands: catalog.map((c) => c.id),
        commandCapability: (id) => BUILTIN_COMMAND_CAPABILITIES[id],
        readPrompt: (_n, rel) => readPackageAsset(dir, rel),
      },
    );

    expect(result.errors).toEqual([]);
    expect(result.compiled[0].workflow?.steps).toHaveLength(5);
    // Nothing about the runtime assumes npm: the declared command survives.
    expect(result.compiled[0].manifest.execution.test_command).toBe("mix test");
  });

  it("recognises a mix failure through the shared translator", () => {
    // `8 tests, 1 failure` is the mix summary. The translator must derive the
    // semantic event from it without any Elixir-specific branch, or a non-npm
    // repository silently never triggers a behavior however correct its
    // manifest is.
    const raw = fromToolResult({
      type: "tool_result",
      toolCallId: "t1",
      toolName: "bash",
      input: { command: "mix test" },
      content: [{ type: "text", text: MIX_FAILURE }],
      isError: true,
    } as never);

    const derived = translateEvent(raw, { testCommand: "mix test" });
    expect(derived?.type).toBe("test.failure.observed");
    expect(derived?.payload.command).toBe("mix test");
  });

  it("runs the flow end to end and proposes without touching the tree", async () => {
    const root = sandbox(FILES);
    enterSandbox(root);

    const instance = createActivate({ agent });
    const { pi, fire } = fakePi();
    instance.activate(pi);

    await fire("tool_result", failingToolResult("mix test", MIX_FAILURE));

    const record = instance.runRecords[0];
    expect(record?.behavior).toBe("elixir-investigate");
    expect(record?.run?.outcome).toBe("fix.proposed");

    const store = new ProposalStore(root);
    const stored = store.list();
    expect(stored).toHaveLength(1);
    expect(stored[0].writes[0].path).toBe("lib/calc.ex");
    expect(stored[0].appliedAt).toBeUndefined();

    // The Elixir source is untouched.
    expect(readFileSync(join(root, "lib", "calc.ex"), "utf8")).toBe(LIB);
  });

  it("normalizes the same event identically whichever adapter produced it", () => {
    // REQ-BEH-005 asks that equivalent fixtures produce equivalent normalized
    // matches across adapters. Two adapters describing the same observation
    // must not disagree about whether a behavior should fire.
    const viaAdapter = fromToolResult({
      type: "tool_result",
      toolCallId: "t2",
      toolName: "bash",
      input: { command: "mix test" },
      content: [{ type: "text", text: MIX_FAILURE }],
      isError: true,
    } as never);

    const viaNormalize = normalizeEvent({
      type: "runtime.tool_call.completed",
      source: "pi",
      payload: {
        toolCallId: "t2",
        toolName: "bash",
        custom: false,
        isError: true,
        command: "mix test",
        cwd: undefined,
        output: MIX_FAILURE,
      },
    });

    const a = translateEvent(viaAdapter, { testCommand: "mix test" });
    const b = translateEvent(viaNormalize, { testCommand: "mix test" });
    expect(a?.payload).toEqual(b?.payload);
  });
});
