import { createWorkflowDispatcher } from "../src/workflow-dispatch";
import { compile, BehaviorManifest, AgentPort } from "@sunstone-partners/ensemble-agent-core";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `br-vrzv`: a dispatch must be cancellable, or its child outlives the session.
 *
 * Observed in headless runs: the host exited and the `omp -p` child the
 * governed dispatch had spawned kept running, reparented to PID 1, its result
 * never consumed. Read-only tools, so nothing was written — but unowned model
 * spend, and an unowned process is a bad default whatever its grants.
 *
 * Draining could never fix it. Joining a run waits for a child that has no
 * reason to stop, and the host's handler timeout expires long before it does.
 * The child has to be TOLD to stop. `execFile` already honours an
 * `AbortSignal`; the signal simply never reached it.
 *
 * This pins the plumbing that was missing: dispatcher -> agent invocation.
 */

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "cancel-"));
  dirs.push(dir);
  mkdirSync(join(dir, "prompts"), { recursive: true });
  writeFileSync(join(dir, "prompts", "p.md"), "think");
  return dir;
}

const MANIFEST = {
  api_version: "ensemble.sunstone.dev/v1",
  kind: "Behavior",
  metadata: { name: "slow", version: "1.0.0" },
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

const EVENT = { type: "test.failure.observed", source: "test", payload: { command: "npx jest" } } as never;

describe("a shutdown signal reaches the agent invocation", () => {
  it("hands the agent the dispatcher's signal, rather than none at all", async () => {
    const root = workspace();
    const controller = new AbortController();
    let seen: AbortSignal | undefined;

    const agent: AgentPort = {
      invoke: async (request: { signal?: AbortSignal }) => {
        seen = request.signal;
        return { ok: true as const, reply: "done" };
      },
    } as unknown as AgentPort;

    const d = createWorkflowDispatcher({
      rootDir: root,
      sessionId: "s",
      executionId: "e",
      compiled: () => compile({ behaviors: [MANIFEST] }).compiled,
      packageDirFor: () => root,
      agent,
      signal: controller.signal,
    });

    await d.invoke({ behavior: MANIFEST, event: EVENT } as never);

    // The gap that caused br-vrzv was precisely this being undefined: the
    // dispatcher accepted a signal and nothing ever passed one.
    expect(seen).toBeDefined();
  });

  it("the signal it hands over reflects an abort, so the child is told to stop", async () => {
    const root = workspace();
    const controller = new AbortController();
    let seen: AbortSignal | undefined;

    const agent: AgentPort = {
      invoke: async (request: { signal?: AbortSignal }) => {
        seen = request.signal;
        return { ok: true as const, reply: "done" };
      },
    } as unknown as AgentPort;

    const d = createWorkflowDispatcher({
      rootDir: root,
      sessionId: "s",
      executionId: "e",
      compiled: () => compile({ behaviors: [MANIFEST] }).compiled,
      packageDirFor: () => root,
      agent,
      signal: controller.signal,
    });

    controller.abort();
    await d.invoke({ behavior: MANIFEST, event: EVENT } as never);

    // Either the run refused to start under an aborted signal, or it started
    // and the agent saw an aborted signal. Both are correct; silently running
    // to completion as if nothing happened is not.
    expect(seen === undefined || seen.aborted).toBe(true);
  });

  it("aborts before draining at shutdown, not after", () => {
    // Order is the whole fix. Draining first waits on children with no reason
    // to stop, the handler times out, and they are orphaned exactly as
    // before. Asserted against the source because the ordering is the
    // behaviour, and a runtime test would have to race the host's timeout.
    const source = require("node:fs").readFileSync(
      join(__dirname, "..", "src", "extension.ts"),
      "utf8",
    ) as string;
    const handler = source.slice(source.indexOf("shutdown.abort()"));
    expect(handler).toMatch(/shutdown\.abort\(\)[\s\S]{0,120}drainDispatches\(\)/);
  });
});
