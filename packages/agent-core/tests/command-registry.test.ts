import {
  BehaviorAuthority,
  CommandDescriptor,
  CommandRegistry,
  RuntimeStampedEvent,
  acceptLocally,
  createMutationGuard,
  CompiledBehaviorPackage,
  compile,
  BehaviorManifest,
} from "../src";

/**
 * Exit gate 1 (`br-behavior-runtime-cqrs-xl24.8`): a command proposes through
 * ONE registered handler and reports truthfully.
 *
 * The property under test is not "the registry works". It is that the two
 * invocation routes are the same code. A registry that denies a tool call and
 * permits the identical workflow step would satisfy every unit test written
 * about either route separately, and would be exactly the defect Phase 0
 * removed at the dispatch layer reappearing one layer down.
 */

function manifest(overrides: Partial<BehaviorManifest> = {}): BehaviorManifest {
  return {
    api_version: "ensemble.sunstone.dev/v1",
    kind: "Behavior",
    metadata: { name: "t", version: "1.0.0" },
    trigger: { event_type: "test.failure.observed" },
    policy: { mode: "propose", timeout: "10m" },
    capabilities: { tools: ["read"], mutation_classes: [], commands: ["thing.do"] },
    execution: { graph: "t" },
    outcomes: ["behavior.completed"],
    ...overrides,
  } as BehaviorManifest;
}

function compiled(m: BehaviorManifest): CompiledBehaviorPackage {
  const result = compile({ behaviors: [m] });
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join("; "));
  return result.compiled[0];
}

function authority(m: BehaviorManifest = manifest()): BehaviorAuthority {
  const c = compiled(m);
  return { name: c.manifest.metadata.name, digest: c.digest, commands: c.commands, guard: createMutationGuard(c) };
}

const NOOP: CommandDescriptor<{ value: string }, unknown> = {
  id: "thing.do",
  version: "1.0.0",
  description: "does a thing",
  requiredCapability: "thing.do",
  emits: [],
  input: { type: "object", fields: { value: { type: "string" } } },
  result: { type: "object", fields: { ok: { type: "boolean" } } },
  async handler() {
    return { status: "completed", result: { ok: true } };
  },
};

function registry(options: Partial<ConstructorParameters<typeof CommandRegistry>[0]> = {}): CommandRegistry {
  return new CommandRegistry({
    workspaceRoot: "/tmp/does-not-matter",
    sessionId: "s1",
    executionId: "e1",
    now: () => "2026-01-01T00:00:00.000Z",
    ...options,
  });
}

describe("one authorization path, regardless of how the command was invoked", () => {
  it("denies an unauthorized command identically via tool call and via workflow step", async () => {
    const r = registry();
    r.register(NOOP);
    // Declares no commands at all, so it holds no command capability.
    const unarmed = authority(manifest({ capabilities: { tools: ["read"], mutation_classes: [], commands: [] } }));

    const viaTool = await r.execute({
      request: { command: "thing.do", args: { value: "x" }, via: "tool-call" },
      authority: unarmed,
    });
    const viaStep = await r.execute({
      request: { command: "thing.do", args: { value: "x" }, via: "workflow-step" },
      authority: unarmed,
    });

    expect(viaTool.status).toBe("unauthorized");
    expect(viaStep.status).toBe("unauthorized");
    // Same verdict AND same explanation: a difference in wording would mean a
    // difference in the code that decided.
    expect((viaStep as { reason: string }).reason).toBe((viaTool as { reason: string }).reason);
  });

  it("permits the same command on both routes when the capability is declared", async () => {
    const r = registry();
    r.register(NOOP);
    const armed = authority();

    for (const via of ["tool-call", "workflow-step"] as const) {
      const result = await r.execute({
        request: { command: "thing.do", args: { value: "x" }, via },
        authority: armed,
      });
      expect(result.status).toBe("completed");
    }
  });

  it("a tool grant does not confer command authority", async () => {
    // REQ-SAFE-003 as a test rather than a docstring: every tool in the
    // world, no command capability, still denied.
    const r = registry();
    r.register(NOOP);
    const toolRich = authority(
      manifest({
        capabilities: { tools: ["read", "write", "edit", "bash"], mutation_classes: ["artifact.write"], commands: [] },
      }),
    );

    const result = await r.execute({
      request: { command: "thing.do", args: { value: "x" }, via: "tool-call" },
      authority: toolRich,
    });

    expect(result.status).toBe("unauthorized");
    expect((result as { reason: string }).reason).toMatch(/capabilities\.commands/);
  });
});

describe("results describe what actually happened", () => {
  it("rejects an unknown command as malformed rather than failing silently", async () => {
    const result = await registry().execute({
      request: { command: "nope.nothing", args: {}, via: "direct" },
      authority: authority(),
    });
    expect(result.status).toBe("malformed");
    expect((result as { reason: string }).reason).toMatch(/unknown command/);
  });

  it("rejects arguments that do not satisfy the input schema", async () => {
    const r = registry();
    r.register(NOOP);
    const result = await r.execute({
      request: { command: "thing.do", args: { valu: "typo" }, via: "tool-call" },
      authority: authority(),
    });
    // A misspelled argument is malformed, not a call that ran with a default.
    expect(result.status).toBe("malformed");
    expect((result as { reason: string }).reason).toMatch(/unknown field/);
  });

  it("reports a thrown handler as failed, not as a policy rejection", async () => {
    const r = registry();
    r.register({
      ...NOOP,
      async handler() {
        throw new Error("disk on fire");
      },
    });
    const result = await r.execute({
      request: { command: "thing.do", args: { value: "x" }, via: "direct" },
      authority: authority(),
    });
    expect(result.status).toBe("failed");
    expect((result as { reason: string }).reason).toMatch(/disk on fire/);
  });

  it("never reports an accepted proposal as completed", async () => {
    const r = registry();
    r.register({
      ...NOOP,
      async handler() {
        return { status: "accepted", result: { ok: true }, proposalRef: "fix-abc123def456" };
      },
    });
    const result = await r.execute({
      request: { command: "thing.do", args: { value: "x" }, via: "direct" },
      authority: authority(),
    });
    expect(result.status).toBe("accepted");
    expect(result.status).not.toBe("completed");
    expect((result as { proposalRef?: string }).proposalRef).toBe("fix-abc123def456");
  });
});

describe("events are emitted only by handlers that earned them", () => {
  const published: { event: RuntimeStampedEvent; scope: string }[] = [];
  const publisher = {
    async publish(event: RuntimeStampedEvent, acceptance: { scope: string }) {
      published.push({ event, scope: acceptance.scope });
    },
  };
  beforeEach(() => {
    published.length = 0;
  });

  const applying: CommandDescriptor<{ value: string }, unknown> = {
    ...NOOP,
    emits: ["fix.applied"],
    result: { type: "object", fields: { events: { type: "record", values: { type: "unknown" } } } },
  };

  it("emits an 'applied' event when the handler completed", async () => {
    const r = registry({ publish: publisher });
    r.register({
      ...applying,
      async handler() {
        return {
          status: "completed",
          result: { events: { "fix.applied": { proposalRef: "fix-aaaaaaaaaaaa", paths: ["a.ts"] } } },
        };
      },
    });

    const result = await r.execute({
      request: { command: "thing.do", args: { value: "x" }, via: "direct" },
      authority: authority(),
    });

    expect(result.status).toBe("completed");
    expect(result.emitted).toEqual(["fix.applied"]);
    expect(published.map((p) => p.event.type)).toEqual(["fix.applied"]);
  });

  it("does NOT emit an 'applied' event when the handler only accepted", async () => {
    // REQ-CQRS-004. The handler is claiming a transition it did not make. The
    // registry withholds the event rather than trusting the claim, which is
    // the machine-checkable form of "an agent saying done is not evidence".
    const r = registry({ publish: publisher });
    r.register({
      ...applying,
      async handler() {
        return {
          status: "accepted",
          result: { events: { "fix.applied": { proposalRef: "fix-aaaaaaaaaaaa", paths: ["a.ts"] } } },
        };
      },
    });

    const result = await r.execute({
      request: { command: "thing.do", args: { value: "x" }, via: "direct" },
      authority: authority(),
    });

    expect(result.status).toBe("accepted");
    expect(result.emitted).toEqual([]);
    expect(published).toEqual([]);
  });

  it("refuses to register a command that can emit an uncatalogued event", () => {
    expect(() =>
      registry().register({ ...NOOP, emits: ["fix.definitely_not_a_real_event"] }),
    ).toThrow(/not in the closed catalog/);
  });

  it("fails the command when its result does not satisfy the declared schema", async () => {
    const r = registry({ publish: publisher });
    r.register({
      ...applying,
      async handler() {
        // Claims success, cannot produce the declared shape.
        return { status: "completed", result: { unexpected: true } as never };
      },
    });

    const result = await r.execute({
      request: { command: "thing.do", args: { value: "x" }, via: "direct" },
      authority: authority(),
    });

    expect(result.status).toBe("failed");
    expect(published.map((p) => p.event.type)).toEqual(["command.rejected"]);
  });

  it("stamps stable causation and correlation across request and result", async () => {
    const r = registry({ publish: publisher });
    r.register({
      ...applying,
      async handler() {
        return {
          status: "completed",
          result: { events: { "fix.applied": { proposalRef: "fix-aaaaaaaaaaaa", paths: [] } } },
        };
      },
    });

    const result = await r.execute({
      request: { command: "thing.do", args: { value: "x" }, via: "direct", correlationId: "corr-1" },
      authority: authority(),
    });

    expect(result.correlationId).toBe("corr-1");
    expect(published[0].event.correlationId).toBe("corr-1");
    expect(published[0].event.causationId).toBe(result.causationId);
  });

  it("stamps runtime-owned identity even when a handler tries to supply it", async () => {
    const r = registry({ publish: publisher });
    r.register({
      ...applying,
      async handler() {
        return {
          status: "completed",
          result: {
            events: {
              "fix.applied": {
                proposalRef: "fix-aaaaaaaaaaaa",
                paths: [],
                // Spoof attempts. Stripped, not reported: the goal is that the
                // field is trustworthy, not that spoofing is detectable.
                sessionId: "attacker-session",
                behaviorId: "some-other-behavior",
              },
            },
          },
        };
      },
    });

    await r.execute({
      request: { command: "thing.do", args: { value: "x" }, via: "direct" },
      authority: authority(),
    });

    expect(published[0].event.sessionId).toBe("s1");
    expect(published[0].event.behaviorId).toBe("t");
    expect(published[0].event.payload.sessionId).toBeUndefined();
  });
});

describe("local acceptance is never dressed up as Foreman acceptance", () => {
  it("labels every published event with a local-only scope and its limits", async () => {
    const seen: { scope: string; guarantees: string }[] = [];
    const r = registry({
      publish: {
        async publish(_e, acceptance) {
          seen.push({ scope: acceptance.scope, guarantees: acceptance.guarantees });
        },
      },
    });
    r.register({
      ...NOOP,
      emits: ["fix.proposed"],
      result: { type: "object", fields: { events: { type: "record", values: { type: "unknown" } } } },
      async handler() {
        return {
          status: "accepted",
          result: {
            events: { "fix.proposed": { proposalRef: "fix-aaaaaaaaaaaa", issue: "i", paths: [] } },
          },
        };
      },
    });

    await r.execute({
      request: { command: "thing.do", args: { value: "x" }, via: "direct" },
      authority: authority(),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].scope).toBe("local-outbox");
    expect(seen[0].guarantees).toMatch(/not a durable event store/);
    expect(seen[0].guarantees).toMatch(/no Foreman acceptance is implied/);
    // The type system is the real guard: there is no acceptance scope that
    // names Foreman, so the claim is not expressible rather than merely
    // discouraged.
    expect(Object.keys({ ...acceptLocally("local-session") })).not.toContain("foreman");
  });
});

describe("idempotency", () => {
  it("returns the first result for a repeated key rather than re-running the handler", async () => {
    let calls = 0;
    const r = registry();
    r.register({
      ...NOOP,
      async handler() {
        calls += 1;
        return { status: "completed", result: { ok: true } };
      },
    });

    const request = {
      command: "thing.do",
      args: { value: "x" },
      via: "direct" as const,
      idempotencyKey: "k1",
    };
    await r.execute({ request, authority: authority() });
    await r.execute({ request, authority: authority() });

    expect(calls).toBe(1);
  });
});
