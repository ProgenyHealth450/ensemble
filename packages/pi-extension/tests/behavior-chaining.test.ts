import { createWorkflowDispatcher, DispatchRecord } from "../src/workflow-dispatch";
import {
  compile,
  BehaviorManifest,
  AgentPort,
  RuntimeStampedEvent,
  AcceptanceRecord,
} from "@sunstone-partners/ensemble-agent-core";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `br-j46q`: behavior outcomes are published, so behaviors can chain.
 *
 * Before this the interpreter computed `terminal` and `outcome`, every
 * manifest declared them under `outcomes:`, the compiler validated that list —
 * and nothing published them. The declaration was a promise the runtime did
 * not keep, invisibly: a behavior whose outcome went nowhere looks exactly
 * like one that worked.
 *
 * The risk in fixing it is recursion. A behavior that triggers on
 * `behavior.completed` and itself completes would feed its own trigger. That
 * must terminate by construction, not by the author being careful.
 */

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "chain-"));
  dirs.push(dir);
  mkdirSync(join(dir, "prompts"), { recursive: true });
  writeFileSync(join(dir, "prompts", "p.md"), "think");
  return dir;
}

function manifest(over: { name?: string; trigger?: string; status?: string } = {}): BehaviorManifest {
  return {
    api_version: "ensemble.sunstone.dev/v1",
    kind: "Behavior",
    metadata: { name: over.name ?? "first", version: "1.0.0" },
    trigger: { event_type: over.trigger ?? "test.failure.observed" },
    policy: { mode: "propose", timeout: "5m" },
    capabilities: { tools: [], mutation_classes: [], commands: [] },
    execution: {
      graph: "g",
      workflow: {
        schema_version: "1.0.0",
        start: "done",
        steps: [
          { id: "done", kind: "outcome", outcome: "behavior.completed", status: over.status ?? "succeeded" },
        ],
      },
    },
    outcomes: ["behavior.completed"],
  } as unknown as BehaviorManifest;
}

const AGENT = { invoke: async () => ({ ok: true, reply: "x" }) } as unknown as AgentPort;

function harness(m: BehaviorManifest) {
  const root = workspace();
  const published: RuntimeStampedEvent[] = [];
  const records: DispatchRecord[] = [];
  const compiled = compile({ behaviors: [m] }).compiled;
  const d = createWorkflowDispatcher({
    rootDir: root,
    sessionId: "s",
    executionId: "e",
    compiled: () => compiled,
    packageDirFor: () => root,
    agent: AGENT,
    records,
    publish: async (event: RuntimeStampedEvent, _acceptance: AcceptanceRecord) => {
      published.push(event);
    },
    now: () => "2026-01-01T00:00:00.000Z",
  });
  return { d, published, records, m };
}

function event(type = "test.failure.observed") {
  return { type, source: "test", payload: {} } as never;
}

describe("a behavior's outcome becomes an event", () => {
  it("publishes behavior.completed when a run succeeds", async () => {
    const h = harness(manifest());
    await h.d.invoke({ behavior: h.m, event: event() } as never);

    const outcome = h.published.find((e) => e.type.startsWith("behavior."));
    expect(outcome?.type).toBe("behavior.completed");
    expect(outcome?.payload).toMatchObject({ behavior: "first", terminal: "succeeded" });
  });

  it("publishes behavior.blocked when the run is blocked", async () => {
    const h = harness(manifest({ status: "blocked" }));
    await h.d.invoke({ behavior: h.m, event: event() } as never);

    expect(h.published.find((e) => e.type.startsWith("behavior."))?.type).toBe("behavior.blocked");
  });

  it("carries the declared outcome name, not just the terminal state", async () => {
    const h = harness(manifest());
    await h.d.invoke({ behavior: h.m, event: event() } as never);

    expect(h.published.find((e) => e.type.startsWith("behavior."))?.payload).toMatchObject({
      outcome: "behavior.completed",
    });
  });

  it("stamps the behavior identity, so a consumer can tell who finished", async () => {
    const h = harness(manifest());
    await h.d.invoke({ behavior: h.m, event: event() } as never);

    const outcome = h.published.find((e) => e.type.startsWith("behavior."));
    expect(outcome?.behaviorId).toBe("first");
    expect(outcome?.causationId).toBe("test.failure.observed");
  });
});

describe("an inconclusive run is never reported as a completed one", () => {
  /**
   * This shipped wrong once. `inconclusive` had no branch in the mapping and
   * fell through to `behavior.completed`, so "we could not tell" was
   * published as "it worked".
   *
   * That is the exact overclaim the vacuous-test-run behavior exists to
   * catch — it uses `status: inconclusive`, never `succeeded`, precisely so
   * a suite that executed nothing is not called a pass. Collapsing the two
   * in the event layer would have undone that everywhere downstream, which
   * is worse than never having made the distinction.
   */
  it("publishes behavior.outcome.recorded, not behavior.completed", async () => {
    const h = harness(manifest({ status: "inconclusive" }));
    await h.d.invoke({ behavior: h.m, event: event() } as never);

    const outcome = h.published.find((e) => e.type.startsWith("behavior."));
    expect(outcome?.type).toBe("behavior.outcome.recorded");
    expect(outcome?.type).not.toBe("behavior.completed");
  });

  it("carries the real terminal state, so the weaker claim is checkable", async () => {
    const h = harness(manifest({ status: "inconclusive" }));
    await h.d.invoke({ behavior: h.m, event: event() } as never);

    expect(h.published.find((e) => e.type.startsWith("behavior."))?.payload).toMatchObject({
      terminal: "inconclusive",
    });
  });

  it("keeps succeeded distinct, so the fix did not simply move the collapse", async () => {
    const h = harness(manifest({ status: "succeeded" }));
    await h.d.invoke({ behavior: h.m, event: event() } as never);

    expect(h.published.find((e) => e.type.startsWith("behavior."))?.type).toBe("behavior.completed");
  });
});


describe("chaining is bounded, so a self-triggering behavior cannot run away", () => {
  it("terminates a behavior that triggers on its own completion", async () => {
    // The behavior listens for behavior.completed and emits behavior.completed.
    // Left unbounded this is an infinite loop; InvocationBudget must stop it.
    const m = manifest({ name: "ouroboros", trigger: "behavior.completed" });
    const h = harness(m);

    let refusals = 0;
    for (let i = 0; i < 6; i++) {
      await h.d.invoke({ behavior: m, event: event("behavior.completed") } as never);
      refusals = h.records.filter((r) => r.skipped).length;
    }

    // It must have been refused before six runs — the exact number is the
    // budget's business, but "some refusal happened" is the invariant.
    expect(refusals).toBeGreaterThan(0);
    expect(h.records.filter((r) => r.run).length).toBeLessThan(6);
  });
});
