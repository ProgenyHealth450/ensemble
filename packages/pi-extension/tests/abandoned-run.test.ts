import { createWorkflowDispatcher, DispatchRecord } from "../src/workflow-dispatch";
import { countStates, renderStatusReport } from "../src/runtime-status";
import { compile, BehaviorManifest, AgentPort } from "@sunstone-partners/ensemble-agent-core";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `br-mr22`: a run that begins and never resolves must leave evidence.
 *
 * Foreman owns the session and collects afterwards. Before this, dispatch
 * records were written only once a run RESOLVED, so a run still executing
 * when the session ended produced no record at all — and Foreman saw a clean
 * termination with an empty outbox, which is byte-identical to "the behavior
 * matched nothing and correctly did nothing".
 *
 * That is a false negative in the direction that looks like success: anything
 * concluded from such a session (success rate, whether a behavior is worth
 * dispatching) is drawn from MISSING data read as negative data.
 */

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "abandoned-"));
  dirs.push(dir);
  mkdirSync(join(dir, "prompts"), { recursive: true });
  writeFileSync(join(dir, "prompts", "p.md"), "do the thing");
  return dir;
}

function manifest(): BehaviorManifest {
  return {
    api_version: "ensemble.sunstone.dev/v1",
    kind: "Behavior",
    metadata: { name: "slow-behavior", version: "1.0.0" },
    trigger: { event_type: "test.failure.observed" },
    policy: { mode: "propose", timeout: "10m" },
    capabilities: { tools: ["read"], mutation_classes: [], commands: [] },
    execution: {
      graph: "g",
      workflow: {
        schema_version: "1.0.0",
        start: "think",
        steps: [
          { id: "think", kind: "agent", prompt: "prompts/p.md", tools: ["read"], expect: "text", on_failure: "done" },
          { id: "done", kind: "outcome", outcome: "behavior.completed", status: "succeeded" },
        ],
      },
    },
    outcomes: ["behavior.completed"],
  } as unknown as BehaviorManifest;
}

/** An agent port that never returns, standing in for a run outliving its session. */
function hangingAgent(): AgentPort {
  return { invoke: () => new Promise(() => {}) } as unknown as AgentPort;
}

function dispatcher(root: string, agent: AgentPort, records: DispatchRecord[]) {
  const compiled = compile({ behaviors: [manifest()] }).compiled;
  return createWorkflowDispatcher({
    rootDir: root,
    sessionId: "s",
    executionId: "e",
    compiled: () => compiled,
    packageDirFor: () => root,
    agent,
    records,
    now: () => "2026-01-01T00:00:00.000Z",
  });
}

const EVENT = {
  type: "test.failure.observed",
  source: "test",
  payload: { command: "npx jest" },
} as never;

describe("a run that never resolves is visible as abandoned", () => {
  it("records the invocation before entering the interpreter", async () => {
    const root = workspace();
    const records: DispatchRecord[] = [];
    const d = dispatcher(root, hangingAgent(), records);

    // Deliberately NOT awaited: this stands in for the session ending while
    // the run is still in flight.
    void d.invoke({ behavior: manifest(), event: EVENT } as never);
    await new Promise((r) => setTimeout(r, 20));

    expect(records).toHaveLength(1);
    expect(records[0].startedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(records[0].abandoned).toMatch(/did not resolve/);
    expect(records[0].run).toBeUndefined();
  });

  it("counts abandonment separately from failure", async () => {
    const root = workspace();
    const records: DispatchRecord[] = [];
    void dispatcher(root, hangingAgent(), records).invoke({ behavior: manifest(), event: EVENT } as never);
    await new Promise((r) => setTimeout(r, 20));

    const counts = countStates({
      activation: null,
      eventsSeen: 1,
      records,
      dispatchesInFlight: 1,
      commandIds: [],
      approvalChannel: "none",
      agentContainment: "none",
    });

    // A failure is a RESULT. Abandonment is the absence of one. Collapsing
    // them would let a cut-short session read as a behavior that ran and
    // did not succeed.
    expect(counts.abandoned).toBe(1);
    expect(counts.failed).toBe(0);
    expect(counts.invoked).toBe(0);
  });

  it("warns in the status report that results are missing, not negative", async () => {
    const root = workspace();
    const records: DispatchRecord[] = [];
    void dispatcher(root, hangingAgent(), records).invoke({ behavior: manifest(), event: EVENT } as never);
    await new Promise((r) => setTimeout(r, 20));

    const report = renderStatusReport({
      activation: null,
      eventsSeen: 1,
      records,
      dispatchesInFlight: 1,
      commandIds: [],
      approvalChannel: "none",
      agentContainment: "none",
    });

    expect(report).toMatch(/abandoned=1/);
    expect(report).toMatch(/missing, not negative/);
    expect(report).toContain("slow-behavior");
  });

  it("clears the abandoned marker when the run does resolve", async () => {
    const root = workspace();
    const records: DispatchRecord[] = [];
    const agent = { invoke: async () => ({ ok: true, reply: "done" }) } as unknown as AgentPort;

    await dispatcher(root, agent, records).invoke({ behavior: manifest(), event: EVENT } as never);

    expect(records).toHaveLength(1);
    expect(records[0].abandoned).toBeUndefined();
    expect(records[0].run).toBeDefined();
    // Retained even on success, so duration is recoverable after the fact.
    expect(records[0].startedAt).toBeDefined();
  });
});
