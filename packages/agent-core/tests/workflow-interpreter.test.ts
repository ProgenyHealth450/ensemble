import {
  AgentPort,
  ApprovalPort,
  BehaviorAuthority,
  BehaviorEvent,
  BehaviorManifest,
  CommandRegistry,
  CompiledBehaviorPackage,
  MAX_STEP_TRANSITIONS,
  WORKFLOW_SCHEMA_VERSION,
  WorkflowDefinition,
  WorkflowRunOptions,
  WorkflowRunResult,
  compile,
  createMutationGuard,
  runWorkflow,
  validateWorkflow,
} from "../src";

/**
 * REQ-BEH-002 / REQ-SAFE-007: one interpreter, bounded, and honest about what
 * happened.
 *
 * Two properties carry most of the weight here. The first is that an agent's
 * word is never evidence: a reply that says "I fixed it" in prose fails the
 * step's response contract, so nothing downstream can branch on it. The second
 * is that the terminal state describes the run rather than flattering it — a
 * denied command stays denied in the binding later steps read, a failure with
 * no declared branch stops instead of falling through to a step whose inputs
 * are now missing, and a cancelled run says `cancelled` rather than `failed`.
 *
 * The ports are fakes; the `CommandRegistry` is real, because the authorization
 * boundary a workflow step crosses must be the same one a tool call crosses.
 */

function manifest(overrides: Partial<BehaviorManifest> = {}): BehaviorManifest {
  return {
    api_version: "ensemble.sunstone.dev/v1",
    kind: "Behavior",
    metadata: { name: "investigate-test-failure", version: "1.0.0" },
    trigger: { event_type: "test.failure.observed" },
    policy: { mode: "propose", timeout: "10m" },
    capabilities: {
      tools: ["read", "grep"],
      mutation_classes: [],
      commands: ["investigation.record", "verification.run", "fix.apply"],
    },
    execution: { graph: "investigate-test-failure" },
    outcomes: ["test.failure.investigated"],
    ...overrides,
  } as BehaviorManifest;
}

interface Harness {
  readonly registry: CommandRegistry;
  readonly authority: BehaviorAuthority;
  /** Arguments each handler actually received, in order. */
  readonly handled: Array<{ command: string; args: Record<string, unknown> }>;
}

/**
 * A real registry with three small commands, and the behavior authority a
 * compiled manifest yields.
 *
 * `handled` is the load-bearing spy: a denied command must never reach its
 * handler, and an authorized one must receive resolved argument values rather
 * than the literal `${...}` text.
 */
function harness(m: BehaviorManifest = manifest()): Harness {
  const handled: Array<{ command: string; args: Record<string, unknown> }> = [];
  const registry = new CommandRegistry({
    workspaceRoot: "/tmp/workspace",
    sessionId: "session-1",
    executionId: "exec-1",
    now: () => "2026-01-01T00:00:00.000Z",
  });

  registry.register<{ diagnosis: string }, { recordId: string }>({
    id: "investigation.record",
    version: "1.0.0",
    description: "records an investigation finding",
    requiredCapability: "investigation.record",
    emits: [],
    input: { type: "object", fields: { diagnosis: { type: "string" } } },
    result: { type: "object", fields: { recordId: { type: "string" } } },
    async handler(_ctx, args) {
      handled.push({ command: "investigation.record", args: { ...args } });
      return {
        status: "completed",
        result: { recordId: `rec-${args.diagnosis}` },
        evidence: [{ kind: "file", ref: "notes/investigation.md" }],
      };
    },
  });

  registry.register<{ suite: string }, { passed: boolean; suite: string }>({
    id: "verification.run",
    version: "1.0.0",
    description: "runs a verification suite",
    requiredCapability: "verification.run",
    emits: [],
    input: { type: "object", fields: { suite: { type: "string" } } },
    result: { type: "object", fields: { passed: { type: "boolean" }, suite: { type: "string" } } },
    async handler(_ctx, args) {
      handled.push({ command: "verification.run", args: { ...args } });
      return { status: "completed", result: { passed: args.suite === "green", suite: args.suite } };
    },
  });

  registry.register<{ path: string }, { applied: boolean }>({
    id: "fix.apply",
    version: "1.0.0",
    description: "applies a candidate patch",
    requiredCapability: "fix.apply",
    emits: [],
    input: { type: "object", fields: { path: { type: "string" } } },
    result: { type: "object", fields: { applied: { type: "boolean" } } },
    async handler(_ctx, args) {
      handled.push({ command: "fix.apply", args: { ...args } });
      return { status: "failed", reason: "patch did not apply cleanly" };
    },
  });

  const result = compile({ behaviors: [m] });
  if (!result.ok) throw new Error(`test bug: manifest does not compile: ${result.errors.map((e) => e.message).join("; ")}`);
  const compiled: CompiledBehaviorPackage = result.compiled[0];

  return {
    registry,
    handled,
    authority: {
      name: compiled.manifest.metadata.name,
      digest: compiled.digest,
      commands: compiled.commands,
      guard: createMutationGuard(compiled),
    },
  };
}

type AgentReply = { ok: true; reply: string } | { ok: false; reason: string };

interface AgentCall {
  readonly prompt: string;
  readonly tools: readonly string[];
  readonly expect: "json" | "text";
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
  readonly stepId: string;
  readonly behavior: string;
}

interface FakeAgent extends AgentPort {
  readonly calls: AgentCall[];
}

/**
 * An agent that returns scripted replies, one per invocation.
 *
 * Running past the end of the script throws rather than repeating the last
 * reply: an unexpected extra invocation means the attempt budget did not hold,
 * and silently serving it would turn a bound violation into a passing test.
 */
function agentReplying(...replies: AgentReply[]): FakeAgent {
  const calls: AgentCall[] = [];
  return {
    calls,
    async invoke(request) {
      calls.push({
        prompt: request.prompt,
        tools: request.tools,
        expect: request.expect,
        maxOutputBytes: request.maxOutputBytes,
        timeoutMs: request.timeoutMs,
        stepId: request.stepId,
        behavior: request.behavior,
      });
      const reply = replies[calls.length - 1];
      if (!reply) {
        throw new Error(`test bug: agent invoked ${calls.length} time(s), only ${replies.length} reply/replies scripted`);
      }
      return reply;
    },
  };
}

interface ApprovalCall {
  readonly title: string;
  readonly message: string;
}

interface FakeApproval extends ApprovalPort {
  readonly calls: ApprovalCall[];
}

function approvalDeciding(decision: { approved: boolean; reason: string }): FakeApproval {
  const calls: ApprovalCall[] = [];
  return {
    calls,
    async request({ title, message }) {
      calls.push({ title, message });
      return decision;
    },
  };
}

function eventWith(payload: Record<string, unknown>): BehaviorEvent {
  return {
    id: "evt-1",
    type: "test.failure.observed",
    source: "local",
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload,
  };
}

/** Runs `workflow` against a throwaway harness unless one is supplied. */
function run(workflow: WorkflowDefinition, overrides: Partial<WorkflowRunOptions> = {}): Promise<WorkflowRunResult> {
  const fallback = harness();
  let tick = 0;
  return runWorkflow({
    behavior: "investigate-test-failure",
    behaviorDigest: "sha256:deadbeef",
    workflow,
    event: eventWith({ command: "npx jest", suite: "green" }),
    registry: fallback.registry,
    authority: fallback.authority,
    agent: agentReplying(),
    loadPrompt: () => "Investigate {{command}}.",
    workspaceRoot: "/tmp/workspace",
    // Injected so step timestamps are deterministic rather than wall-clock.
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
    ...overrides,
  });
}

const OUTCOME = "test.failure.investigated";

/** agent -> command -> outcome, with no step naming its successor. */
const sequential: WorkflowDefinition = {
  schema_version: WORKFLOW_SCHEMA_VERSION,
  start: "analyze",
  steps: [
    {
      id: "analyze",
      kind: "agent",
      prompt: "prompts/analyze.md",
      tools: ["read"],
      expect: "json",
      inputs: { command: "${event.payload.command}" },
    },
    { id: "record", kind: "command", command: "investigation.record", args: { diagnosis: "${steps.analyze.diagnosis}" } },
    {
      id: "investigated",
      kind: "outcome",
      outcome: OUTCOME,
      status: "succeeded",
      evidence: ["${steps.record.result.recordId}"],
    },
  ],
};

/** One agent step whose reply decides everything that follows. */
const contract: WorkflowDefinition = {
  schema_version: WORKFLOW_SCHEMA_VERSION,
  start: "analyze",
  steps: [
    { id: "analyze", kind: "agent", prompt: "prompts/analyze.md", tools: ["read"], expect: "json" },
    { id: "record", kind: "command", command: "investigation.record", args: { diagnosis: "${steps.analyze.diagnosis}" } },
    { id: "investigated", kind: "outcome", outcome: OUTCOME, status: "succeeded" },
  ],
};

describe("sequential fallthrough between non-branching steps", () => {
  it("runs declared steps in order and threads each result into the next", async () => {
    const h = harness();
    const agent = agentReplying({ ok: true, reply: '{"diagnosis":"off-by-one","confidence":"high"}' });

    const result = await run(sequential, { registry: h.registry, authority: h.authority, agent });

    expect(result.steps.map((s) => s.stepId)).toEqual(["analyze", "record", "investigated"]);
    expect(result.terminal).toBe("succeeded");
    expect(result.outcome).toBe(OUTCOME);

    // The binding is the point. `${steps.analyze.diagnosis}` must arrive at
    // the handler as the agent's parsed value, not as the literal text, or the
    // command would be recording the reference instead of the finding.
    expect(h.handled).toEqual([{ command: "investigation.record", args: { diagnosis: "off-by-one" } }]);

    // And what the model was actually given, which is the only version of the
    // prompt that matters when a run is later reviewed.
    expect(agent.calls[0].prompt).toBe("Investigate npx jest.");
    expect(agent.calls[0].stepId).toBe("analyze");
    expect(agent.calls[0].behavior).toBe("investigate-test-failure");
  });

  it("hands the step's tool grant to the port, not the behavior's wider one", async () => {
    const agent = agentReplying({ ok: true, reply: '{"diagnosis":"off-by-one"}' });
    await run(sequential, { agent });

    // The behavior declares [read, grep]; this step declared [read]. The
    // narrower grant is the one the invocation must carry.
    expect(agent.calls[0].tools).toEqual(["read"]);
  });

  it("stops with an explicit failure when a completed step has no successor", async () => {
    const danglingTail: WorkflowDefinition = {
      schema_version: WORKFLOW_SCHEMA_VERSION,
      start: "analyze",
      steps: [{ id: "analyze", kind: "agent", prompt: "p.md", tools: ["read"], expect: "json" }],
    };

    const result = await run(danglingTail, { agent: agentReplying({ ok: true, reply: "{}" }) });

    // Running off the end is not a success. Reporting one would invent a
    // terminal state the package never declared.
    expect(result.terminal).toBe("failed");
    expect(result.reason).toMatch(/completed but no step follows it and no outcome was reached/);
  });
});

describe("conditions branch on structured prior results", () => {
  it("takes the `then` branch when a validated command field matches", async () => {
    const h = harness();
    const result = await run(branching, {
      registry: h.registry,
      authority: h.authority,
      event: eventWith({ command: "npx jest", suite: "green" }),
    });

    expect(h.handled).toEqual([{ command: "verification.run", args: { suite: "green" } }]);
    expect(result.steps.map((s) => s.stepId)).toEqual(["verify", "passed", "repaired"]);
    expect(result.terminal).toBe("succeeded");
    expect(result.steps[1].output).toEqual({ holds: true });
  });

  it("takes the `otherwise` branch when it does not", async () => {
    const result = await run(branching, { event: eventWith({ command: "npx jest", suite: "red" }) });

    expect(result.steps.map((s) => s.stepId)).toEqual(["verify", "passed", "still-failing"]);
    expect(result.terminal).toBe("inconclusive");
    expect(result.steps[1].output).toEqual({ holds: false });
  });

  it("compares the referenced value with its type intact", async () => {
    // `${steps.verify.result.passed}` is a boolean and `right` is `true`. If a
    // whole-string reference were rendered through `String()`, `"false"` would
    // be compared against `false`, every run would take `otherwise`, and a
    // green suite would be reported as still failing.
    const green = await run(branching, { event: eventWith({ suite: "green" }) });
    const red = await run(branching, { event: eventWith({ suite: "red" }) });

    expect(green.steps[1].detail).toBe("${steps.verify.result.passed} equals true -> true");
    expect(red.steps[1].detail).toBe("${steps.verify.result.passed} equals true -> false");
  });

  it("fails the step when a compared reference cannot be resolved", async () => {
    const dangling: WorkflowDefinition = {
      schema_version: WORKFLOW_SCHEMA_VERSION,
      start: "check",
      steps: [
        {
          id: "check",
          kind: "condition",
          left: "${steps.never-ran.verdict}",
          operator: "equals",
          right: "ok",
          then: "yes",
          otherwise: "no",
        },
        { id: "yes", kind: "outcome", outcome: OUTCOME, status: "succeeded" },
        { id: "no", kind: "outcome", outcome: OUTCOME, status: "inconclusive" },
      ],
    };

    const result = await run(dangling);

    // Reporting an unresolvable reference as `false` would send the run down
    // the `otherwise` branch and hide the package bug behind a plausible
    // outcome, which is the expensive kind of wrong.
    expect(result.terminal).toBe("failed");
    expect(result.steps[0].status).toBe("failed");
    expect(result.steps[0].detail).toMatch(/condition left-hand side:/);
  });
});

const branching: WorkflowDefinition = {
  schema_version: WORKFLOW_SCHEMA_VERSION,
  start: "verify",
  steps: [
    { id: "verify", kind: "command", command: "verification.run", args: { suite: "${event.payload.suite}" } },
    {
      id: "passed",
      kind: "condition",
      left: "${steps.verify.result.passed}",
      operator: "equals",
      right: true,
      then: "repaired",
      otherwise: "still-failing",
    },
    { id: "repaired", kind: "outcome", outcome: OUTCOME, status: "succeeded" },
    { id: "still-failing", kind: "outcome", outcome: OUTCOME, status: "inconclusive" },
  ],
};

describe("prose is not a result (the JSON response contract)", () => {
  it("fails the step when the agent claims success in prose", async () => {
    const h = harness();
    const agent = agentReplying({
      ok: true,
      reply: "I investigated the failure and fixed it. All tests pass now.",
    });

    const result = await run(contract, { registry: h.registry, authority: h.authority, agent });

    // This is the whole anti-"the model said it worked" guarantee. The reply
    // is confident, fluent, and carries no checkable claim, so it buys the run
    // nothing.
    expect(result.steps[0].status).toBe("failed");
    expect(result.steps[0].detail).toMatch(/reply contained no JSON object satisfying the step's response contract/);
    expect(result.terminal).toBe("failed");

    // And nothing downstream got to act on it.
    expect(result.steps).toHaveLength(1);
    expect(h.handled).toEqual([]);
  });

  it("parses a fenced ```json block surrounded by prose", async () => {
    const agent = agentReplying({
      ok: true,
      reply: 'Here is what I found:\n\n```json\n{"diagnosis":"off-by-one","confidence":"high"}\n```\n\nHope that helps.',
    });

    const result = await run(contract, { agent });

    // Models narrate. Refusing a well-formed block because it arrived with
    // commentary would push packages toward parsing prose themselves.
    expect(result.steps[0].status).toBe("completed");
    expect(result.steps[0].output).toEqual({ diagnosis: "off-by-one", confidence: "high" });
    expect(result.terminal).toBe("succeeded");
  });

  it("parses a bare JSON object with no fence", async () => {
    const result = await run(contract, { agent: agentReplying({ ok: true, reply: '  {"diagnosis":"off-by-one"}  ' }) });
    expect(result.steps[0].output).toEqual({ diagnosis: "off-by-one" });
  });

  it.each([
    ["a JSON array", '["off-by-one"]'],
    ["a JSON scalar", "true"],
    ["a JSON string", '"all good"'],
    ["truncated JSON", '{"diagnosis":"off-by'],
  ])("rejects %s, which cannot be bound as a structured result", async (_label, reply) => {
    const result = await run(contract, { agent: agentReplying({ ok: true, reply }) });
    expect(result.steps[0].status).toBe("failed");
    expect(result.terminal).toBe("failed");
  });

  it("accepts prose only when the step declared expect: text", async () => {
    const textual: WorkflowDefinition = {
      schema_version: WORKFLOW_SCHEMA_VERSION,
      start: "summarize",
      steps: [
        { id: "summarize", kind: "agent", prompt: "p.md", tools: [], expect: "text" },
        { id: "investigated", kind: "outcome", outcome: OUTCOME, status: "succeeded" },
      ],
    };

    const result = await run(textual, { agent: agentReplying({ ok: true, reply: "It looks like an off-by-one." }) });

    // The contract belongs to the step, not to the runtime. A step that asked
    // for text gets text — and it arrives wrapped, so a later reference has to
    // name `.text` and cannot pretend prose is a structured field.
    expect(result.steps[0].status).toBe("completed");
    expect(result.steps[0].output).toEqual({ text: "It looks like an off-by-one." });
    expect(result.terminal).toBe("succeeded");
  });
});

describe("bounded agent invocation (REQ-SAFE-007)", () => {
  it("retries up to the declared attempt budget, then fails terminally", async () => {
    const agent = agentReplying(
      { ok: true, reply: "Working on it..." },
      { ok: false, reason: "provider timeout" },
    );
    const retried: WorkflowDefinition = {
      schema_version: WORKFLOW_SCHEMA_VERSION,
      start: "analyze",
      steps: [
        { id: "analyze", kind: "agent", prompt: "p.md", tools: ["read"], expect: "json", attempts: 2 },
        { id: "investigated", kind: "outcome", outcome: OUTCOME, status: "succeeded" },
      ],
    };

    const result = await run(retried, { agent });

    expect(agent.calls).toHaveLength(2);
    expect(result.steps[0].detail).toBe("agent step exhausted 2 attempt(s): provider timeout");
    expect(result.terminal).toBe("failed");
  });

  it("stops retrying as soon as an attempt satisfies the contract", async () => {
    const agent = agentReplying(
      { ok: true, reply: "Let me look." },
      { ok: false, reason: "provider timeout" },
      { ok: true, reply: '{"diagnosis":"off-by-one"}' },
    );
    const retried: WorkflowDefinition = {
      schema_version: WORKFLOW_SCHEMA_VERSION,
      start: "analyze",
      steps: [
        { id: "analyze", kind: "agent", prompt: "p.md", tools: ["read"], expect: "json", attempts: 3 },
        { id: "investigated", kind: "outcome", outcome: OUTCOME, status: "succeeded" },
      ],
    };

    const result = await run(retried, { agent });

    expect(agent.calls).toHaveLength(3);
    expect(result.steps[0].detail).toBe("attempt 3 returned a valid JSON reply");
    expect(result.steps[0].output).toEqual({ diagnosis: "off-by-one" });
    expect(result.terminal).toBe("succeeded");
  });

  it("invokes once when no attempt budget is declared", async () => {
    const agent = agentReplying({ ok: true, reply: "not json" });
    await run(contract, { agent });
    expect(agent.calls).toHaveLength(1);
  });

  it("fails a reply that exceeds max_output_bytes, however well-formed", async () => {
    const oversized = JSON.stringify({ diagnosis: "x".repeat(200) });
    expect(() => JSON.parse(oversized)).not.toThrow();

    const bounded: WorkflowDefinition = {
      schema_version: WORKFLOW_SCHEMA_VERSION,
      start: "analyze",
      steps: [
        { id: "analyze", kind: "agent", prompt: "p.md", tools: ["read"], expect: "json", max_output_bytes: 32 },
        { id: "investigated", kind: "outcome", outcome: OUTCOME, status: "succeeded" },
      ],
    };
    const agent = agentReplying({ ok: true, reply: oversized });

    const result = await run(bounded, { agent });

    // The reply parses perfectly. It is refused on size alone, because an
    // output bound that yields to well-formed content is not a bound.
    expect(result.steps[0].detail).toBe("agent step exhausted 1 attempt(s): reply exceeded max_output_bytes (32)");
    expect(result.terminal).toBe("failed");

    // The cap is also handed to the port, so a cooperative provider can stop
    // generating rather than be truncated after the fact.
    expect(agent.calls[0].maxOutputBytes).toBe(32);
  });

  it("fails the step when the package's prompt file cannot be read", async () => {
    const result = await run(contract, { loadPrompt: () => undefined });

    // REQ-BEH-003 at run time: prompts load per invocation so an edit takes
    // effect without a rebuild, which means a renamed file must fail loudly
    // instead of invoking the model with nothing.
    expect(result.steps[0].detail).toBe("prompt file 'prompts/analyze.md' is missing or unreadable");
    expect(result.terminal).toBe("failed");
  });
});

describe("failure handling is explicit, never a silent continue", () => {
  const withBranch: WorkflowDefinition = {
    schema_version: WORKFLOW_SCHEMA_VERSION,
    start: "analyze",
    steps: [
      { id: "analyze", kind: "agent", prompt: "p.md", tools: ["read"], expect: "json", on_failure: "gave-up" },
      { id: "record", kind: "command", command: "investigation.record", args: { diagnosis: "${steps.analyze.diagnosis}" } },
      { id: "investigated", kind: "outcome", outcome: OUTCOME, status: "succeeded" },
      { id: "gave-up", kind: "outcome", outcome: OUTCOME, status: "inconclusive" },
    ],
  };

  it("routes a failed step to its on_failure target", async () => {
    const h = harness();
    const result = await run(withBranch, {
      registry: h.registry,
      authority: h.authority,
      agent: agentReplying({ ok: true, reply: "I could not work it out." }),
    });

    expect(result.steps.map((s) => s.stepId)).toEqual(["analyze", "gave-up"]);
    expect(result.terminal).toBe("inconclusive");

    // `record` is the next *declared* step. Failure routes; it never falls
    // through, or the command would run with an unresolvable binding.
    expect(h.handled).toEqual([]);
  });

  it("terminates the run when a failed step declares no on_failure", async () => {
    const h = harness();
    const result = await run(contract, {
      registry: h.registry,
      authority: h.authority,
      agent: agentReplying({ ok: true, reply: "I could not work it out." }),
    });

    expect(result.steps.map((s) => s.stepId)).toEqual(["analyze"]);
    expect(result.terminal).toBe("failed");
    expect(result.reason).toMatch(/^step "analyze" failed and declares no on_failure:/);
    expect(h.handled).toEqual([]);
  });

  it("carries a handler failure into the declared branch", async () => {
    const h = harness();
    const patching: WorkflowDefinition = {
      schema_version: WORKFLOW_SCHEMA_VERSION,
      start: "apply",
      steps: [
        { id: "apply", kind: "command", command: "fix.apply", args: { path: "src/a.ts" }, on_failure: "gave-up" },
        { id: "investigated", kind: "outcome", outcome: OUTCOME, status: "succeeded" },
        { id: "gave-up", kind: "outcome", outcome: OUTCOME, status: "inconclusive" },
      ],
    };

    const result = await run(patching, { registry: h.registry, authority: h.authority });

    expect(h.handled).toEqual([{ command: "fix.apply", args: { path: "src/a.ts" } }]);
    expect(result.steps[0].status).toBe("failed");
    expect(result.steps[0].detail).toMatch(/command fix\.apply -> failed: patch did not apply cleanly/);
    expect(result.terminal).toBe("inconclusive");
  });
});

describe("a denied command stays denied in the record", () => {
  const unarmed = manifest({
    capabilities: { tools: ["read", "grep"], mutation_classes: [], commands: [] },
  });

  const inspecting: WorkflowDefinition = {
    schema_version: WORKFLOW_SCHEMA_VERSION,
    start: "record",
    steps: [
      {
        id: "record",
        kind: "command",
        command: "investigation.record",
        args: { diagnosis: "off-by-one" },
        on_failure: "why",
      },
      {
        id: "why",
        kind: "condition",
        left: "${steps.record.status}",
        operator: "equals",
        right: "unauthorized",
        then: "refused",
        otherwise: "broke",
      },
      { id: "refused", kind: "outcome", outcome: OUTCOME, status: "blocked" },
      { id: "broke", kind: "outcome", outcome: OUTCOME, status: "failed" },
    ],
  };

  it("surfaces the denial as a step failure whose output keeps the real status", async () => {
    const h = harness(unarmed);
    const result = await run(inspecting, { registry: h.registry, authority: h.authority });

    expect(result.steps[0].status).toBe("failed");

    // The step failed, but `unauthorized` is a different fact from `failed`,
    // and flattening the two would leave a later branch unable to tell a
    // refusal from a crash.
    const output = result.steps[0].output as { status: string; reason?: string };
    expect(output.status).toBe("unauthorized");
    expect(output.reason).toMatch(/capabilities\.commands/);

    // Which is exactly what the following condition reads.
    expect(result.steps.map((s) => s.stepId)).toEqual(["record", "why", "refused"]);
    expect(result.terminal).toBe("blocked");

    // The refusal happened at the boundary, before the handler existed on the
    // stack. `mode: propose` depends on that, not on handler good manners.
    expect(h.handled).toEqual([]);
  });

  it("names the denial in the terminal reason when no branch handles it", async () => {
    const h = harness(unarmed);
    const bare: WorkflowDefinition = {
      schema_version: WORKFLOW_SCHEMA_VERSION,
      start: "record",
      steps: [
        { id: "record", kind: "command", command: "investigation.record", args: { diagnosis: "off-by-one" } },
        { id: "investigated", kind: "outcome", outcome: OUTCOME, status: "succeeded" },
      ],
    };

    const result = await run(bare, { registry: h.registry, authority: h.authority });

    expect(result.terminal).toBe("failed");
    expect(result.reason).toMatch(/unauthorized/);
    expect(h.handled).toEqual([]);
  });
});

describe("cancellation is reported as cancellation", () => {
  it("runs nothing when the caller's signal is already aborted", async () => {
    const h = harness();
    const agent = agentReplying({ ok: true, reply: '{"diagnosis":"off-by-one"}' });
    const controller = new AbortController();
    controller.abort();

    const result = await run(sequential, {
      registry: h.registry,
      authority: h.authority,
      agent,
      signal: controller.signal,
    });

    // An already-aborted signal never fires `abort` again, so a run that only
    // subscribes will see a clear signal and proceed. Starting a behavior
    // inside a session the caller has already cancelled must do nothing at
    // all, not merely stop at its own deadline.
    expect(result.terminal).toBe("cancelled");
    expect(result.reason).toBe("cancelled by the caller");
    expect(result.steps).toEqual([]);
    expect(agent.calls).toEqual([]);
    expect(h.handled).toEqual([]);
  });

  it("reports cancellation rather than failure when a step is interrupted mid-flight", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const cancelled: AgentPort = {
      async invoke(request) {
        calls.push(request.stepId);
        // The operator cancels while the model is thinking.
        controller.abort();
        return request.signal.aborted
          ? { ok: false, reason: "cancelled before a reply arrived" }
          : { ok: true, reply: '{"diagnosis":"off-by-one"}' };
      },
    };

    const result = await run(contract, { agent: cancelled, signal: controller.signal });

    expect(calls).toEqual(["analyze"]);
    expect(result.terminal).toBe("cancelled");
    expect(result.reason).toBe("cancelled by the caller");

    // The ports are *required* to honour the signal, so a port that does so
    // must not be the reason the run is recorded as a behavior failure. The
    // verdict also must not depend on whether the step happened to declare an
    // `on_failure` branch.
    expect(result.reason).not.toMatch(/declares no on_failure/);
  });

  it("ends the run as cancelled when the whole-run budget expires", async () => {
    jest.useFakeTimers();
    try {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const thinking: AgentPort = {
        async invoke(request) {
          entered.resolve();
          await release.promise;
          return request.signal.aborted
            ? { ok: false, reason: "cancelled before a reply arrived" }
            : { ok: true, reply: '{"diagnosis":"off-by-one"}' };
        },
      };

      const running = run(contract, { agent: thinking, timeoutMs: 5_000 });
      await entered.promise;
      // Drive the deadline rather than waiting for it: the assertion is about
      // what the run reports, not about how long a machine takes to notice.
      jest.advanceTimersByTime(5_000);
      release.resolve();

      const result = await running;

      expect(result.terminal).toBe("cancelled");
      expect(result.reason).toBe("workflow exceeded its 5000ms budget");
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("a cyclic package terminates instead of hanging", () => {
  const cyclic: WorkflowDefinition = {
    schema_version: WORKFLOW_SCHEMA_VERSION,
    start: "ping",
    steps: [
      {
        id: "ping",
        kind: "condition",
        left: "${event.payload.loop}",
        operator: "equals",
        right: true,
        then: "pong",
        otherwise: "exhausted",
      },
      {
        id: "pong",
        kind: "condition",
        left: "${event.payload.loop}",
        operator: "equals",
        right: true,
        then: "ping",
        otherwise: "exhausted",
      },
      { id: "exhausted", kind: "outcome", outcome: OUTCOME, status: "inconclusive" },
    ],
  };

  it("is accepted by static validation, so the transition cap is the real guard", () => {
    // Both branches of both conditions name a declared step and the outcome is
    // reachable, so nothing static is wrong with this package. The cycle is
    // only visible at run time, which is why the bound cannot be advisory.
    const validated = validateWorkflow({
      behaviorName: "investigate-test-failure",
      workflow: cyclic,
      behaviorTools: [],
      behaviorCommands: [],
      declaredOutcomes: [OUTCOME],
      knownCommands: [],
    });
    expect(validated.valid).toBe(true);
  });

  it("stops at MAX_STEP_TRANSITIONS", async () => {
    const result = await run(cyclic, { event: eventWith({ loop: true }) });

    expect(result.terminal).toBe("failed");
    expect(result.reason).toBe(
      `workflow exceeded ${MAX_STEP_TRANSITIONS} step transitions; refusing to continue`,
    );
    expect(result.steps).toHaveLength(MAX_STEP_TRANSITIONS);
  });
});

describe("outcome steps yield the declared terminal state and its evidence", () => {
  it.each([
    ["succeeded", "succeeded"],
    ["inconclusive", "inconclusive"],
    ["blocked", "blocked"],
    ["failed", "failed"],
  ])("maps a declared status of %s to the run's terminal state", async (declared, expected) => {
    const terminating: WorkflowDefinition = {
      schema_version: WORKFLOW_SCHEMA_VERSION,
      start: "done",
      steps: [{ id: "done", kind: "outcome", outcome: OUTCOME, status: declared as "succeeded" }],
    };

    const result = await run(terminating);

    expect(result.terminal).toBe(expected);
    expect(result.outcome).toBe(OUTCOME);
    expect(result.reason).toBe(`reached outcome "${OUTCOME}" with status ${declared}`);
  });

  it("resolves evidence references and accumulates them with the commands' own", async () => {
    const h = harness();
    const agent = agentReplying({ ok: true, reply: '{"diagnosis":"off-by-one"}' });

    const result = await run(sequential, { registry: h.registry, authority: h.authority, agent });

    // `notes/investigation.md` came from the handler that examined it; the
    // record ID came from the outcome's declared reference. Evidence is the
    // part of a result a reviewer can independently re-read, so both belong.
    expect(result.evidence).toEqual(["file:notes/investigation.md", "rec-off-by-one"]);
    expect(result.correlationId).toBe("evt-1");
    expect(result.behaviorDigest).toBe("sha256:deadbeef");
  });

  it("marks an evidence reference that does not resolve instead of dropping it", async () => {
    const loose: WorkflowDefinition = {
      schema_version: WORKFLOW_SCHEMA_VERSION,
      start: "done",
      steps: [
        {
          id: "done",
          kind: "outcome",
          outcome: OUTCOME,
          status: "succeeded",
          evidence: ["${event.payload.command}", "${steps.never-ran.report}"],
        },
      ],
    };

    const result = await run(loose);

    // Dropping it would shorten the evidence list silently, and a reviewer
    // counting citations would never learn one was promised and not produced.
    expect(result.evidence[0]).toBe("npx jest");
    expect(result.evidence[1]).toMatch(/^\$\{steps\.never-ran\.report\} \(unresolved: /);
  });
});

describe("both approval branches are real branches (REQ-SAFE-007)", () => {
  const gated: WorkflowDefinition = {
    schema_version: WORKFLOW_SCHEMA_VERSION,
    start: "analyze",
    steps: [
      { id: "analyze", kind: "agent", prompt: "prompts/analyze.md", tools: ["read"], expect: "json" },
      {
        id: "confirm",
        kind: "approval",
        title: "Record this diagnosis?",
        message: "Diagnosis: ${steps.analyze.diagnosis}",
        on_approved: "record",
        on_declined: "declined",
      },
      { id: "record", kind: "command", command: "investigation.record", args: { diagnosis: "${steps.analyze.diagnosis}" } },
      { id: "investigated", kind: "outcome", outcome: OUTCOME, status: "succeeded" },
      { id: "declined", kind: "outcome", outcome: OUTCOME, status: "blocked" },
    ],
  };

  it("follows the approved branch when the operator grants approval", async () => {
    const h = harness();
    const approval = approvalDeciding({ approved: true, reason: "operator confirmed" });

    const result = await run(gated, {
      registry: h.registry,
      authority: h.authority,
      agent: agentReplying({ ok: true, reply: '{"diagnosis":"off-by-one"}' }),
      approval,
    });

    // A live run once recorded "declined by user" for an approval the operator
    // had granted, because the reply shape did not match what the host read.
    // The granted path is therefore asserted end to end rather than inferred
    // from the declined path working.
    expect(result.steps.map((s) => s.stepId)).toEqual(["analyze", "confirm", "record", "investigated"]);
    expect(result.steps[1].detail).toBe("approved: operator confirmed");
    expect(result.steps[1].output).toEqual({ approved: true, reason: "operator confirmed" });
    expect(result.terminal).toBe("succeeded");
    expect(result.outcome).toBe(OUTCOME);

    // The approval was not merely recorded; it let the guarded command run.
    expect(h.handled).toEqual([{ command: "investigation.record", args: { diagnosis: "off-by-one" } }]);
  });

  it("follows the declined branch when the operator refuses", async () => {
    const h = harness();
    const approval = approvalDeciding({ approved: false, reason: "not now" });

    const result = await run(gated, {
      registry: h.registry,
      authority: h.authority,
      agent: agentReplying({ ok: true, reply: '{"diagnosis":"off-by-one"}' }),
      approval,
    });

    expect(result.steps.map((s) => s.stepId)).toEqual(["analyze", "confirm", "declined"]);
    expect(result.steps[1].detail).toBe("declined: not now");
    expect(result.steps[1].output).toEqual({ approved: false, reason: "not now" });
    expect(result.terminal).toBe("blocked");
    expect(h.handled).toEqual([]);
  });

  it("shows the host the resolved title and message, not the raw references", async () => {
    const approval = approvalDeciding({ approved: true, reason: "ok" });

    await run(gated, {
      agent: agentReplying({ ok: true, reply: '{"diagnosis":"off-by-one"}' }),
      approval,
    });

    // What the operator is asked is what they are consenting to. An
    // unsubstituted `${...}` in the prompt would mean the decision was taken
    // against text nobody could evaluate.
    expect(approval.calls).toEqual([{ title: "Record this diagnosis?", message: "Diagnosis: off-by-one" }]);
  });

  it("treats a missing approval channel as declined, never as consent", async () => {
    const h = harness();

    const result = await run(gated, {
      registry: h.registry,
      authority: h.authority,
      agent: agentReplying({ ok: true, reply: '{"diagnosis":"off-by-one"}' }),
      approval: undefined,
    });

    // Failing closed: no configured host means nobody was asked, and nobody
    // asked is not the same as anybody agreeing.
    expect(result.steps[1].detail).toMatch(/no approval channel configured/);
    expect(result.steps[1].output).toEqual({ approved: false, reason: "no approval channel configured" });
    expect(result.terminal).toBe("blocked");
    expect(h.handled).toEqual([]);
  });
});
