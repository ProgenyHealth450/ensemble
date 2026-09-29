import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/behavior/compiler";
import { createMutationGuard } from "../src/behavior/mutation-guard";
import type { BehaviorManifest } from "../src/behavior/schema";
import { createCommandCatalog } from "../src/cqrs/commands";
import { CommandRegistry } from "../src/cqrs/command-registry";
import { ProposalStore } from "../src/cqrs/proposal-store";

/**
 * br-42nn, through the REAL command rather than the helpers it calls.
 *
 * The claim that matters is "proposing writes nothing to the agent brief".
 * Testing the formatter proves the string is right; only running the command
 * proves nothing reached the file, and that is the property the whole
 * propose/apply split exists to provide.
 */

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function workspaceWithBrief(contents = "# Agent brief\n") {
  const root = mkdtempSync(join(tmpdir(), "decision-cmd-"));
  roots.push(root);
  writeFileSync(join(root, "AGENTS.md"), contents);
  return root;
}

function manifest(): BehaviorManifest {
  return {
    api_version: "ensemble.sunstone.dev/v1",
    kind: "Behavior",
    metadata: { name: "recorder", version: "1.0.0" },
    trigger: { event_type: "test.failure.observed" },
    policy: { mode: "propose", timeout: "10m" },
    capabilities: { tools: ["read"], mutation_classes: [], commands: ["decision.propose"] },
    execution: { graph: "g", test_command: "npm test" },
    outcomes: ["fix.proposed"],
  } as BehaviorManifest;
}

function harness(root: string) {
  const store = new ProposalStore(root);
  const registry = new CommandRegistry({ workspaceRoot: root, sessionId: "s-1", executionId: "e-1" });
  for (const descriptor of createCommandCatalog({
    workspaceRoot: root,
    store,
    // Points at the sandbox's brief. Without this the resolver walks for a git
    // root and finds this repository, which would make the test write to the
    // real AGENTS.md -- the precise accident the command is built to prevent.
    resolveDecisionsPath: () => ({ path: join(root, "AGENTS.md") }),
  })) {
    registry.register(descriptor);
  }
  const compiled = compile({ behaviors: [manifest()] }).compiled[0];
  const authority = {
    name: compiled.manifest.metadata.name,
    digest: compiled.digest,
    commands: compiled.commands,
    guard: createMutationGuard(compiled),
  };
  return {
    store,
    // No `as never`. A cast here would hide the invocation shape, which is
    // precisely how the first draft of this test failed: it compiled, then
    // died inside the registry on a field the cast had hidden.
    run: (args: Record<string, unknown>) =>
      registry.execute({ request: { command: "decision.propose", args, via: "workflow-step" }, authority }),
  };
}

const VALID = {
  decision: "Foreman launches the session Ensemble runs inside",
  rationale: "They are not peers; treating them as peers produced a transport layer for messages nobody sends.",
  provenance: "user correction in conversation, 2026-09-29",
  evidence: ["AGENTS.md:12"],
};

describe("decision.propose", () => {
  it("writes nothing to the agent brief", async () => {
    const root = workspaceWithBrief();
    const before = readFileSync(join(root, "AGENTS.md"), "utf8");

    await harness(root).run(VALID);

    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(before);
  });

  it("records the proposal so it can be applied later", async () => {
    const root = workspaceWithBrief();
    const h = harness(root);

    const result = (await h.run(VALID)) as { status: string; proposalRef?: string };

    expect(result.status).toBe("accepted");
    expect(h.store.read(result.proposalRef as string)?.kind).toBe("decision");
  });

  it("refuses an entry with no evidence, at the schema rather than in the handler", async () => {
    // `malformed`, not `rejected`, and the distinction is the point: the
    // argument never reaches the handler, so an unevidenced entry is
    // INEXPRESSIBLE rather than refused by logic someone could later soften.
    // Confident text with no source is the entire risk this command manages.
    const root = workspaceWithBrief();

    const result = (await harness(root).run({ ...VALID, evidence: [] })) as { status: string };

    expect(result.status).toBe("malformed");
  });

  it("refuses an entry with no rationale", async () => {
    // A decision with no reasoning cannot be re-evaluated later; it can only
    // be obeyed, which is how a brief turns into folklore.
    const root = workspaceWithBrief();

    const result = (await harness(root).run({ ...VALID, rationale: "" })) as { status: string };

    expect(result.status).toBe("malformed");
  });

  it("stamps the proposal with the date it was recorded", async () => {
    const root = workspaceWithBrief();

    const result = (await harness(root).run(VALID)) as {
      result: { events: Record<string, { recordedAt: string }> };
    };

    expect(result.result.events["decision.proposed"].recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("carries the provenance on the event, not only in the file text", async () => {
    // A consumer deciding whether to trust an entry needs its origin without
    // having to parse rendered markdown back out again.
    const root = workspaceWithBrief();

    const result = (await harness(root).run(VALID)) as {
      result: { events: Record<string, { provenance: string }> };
    };

    expect(result.result.events["decision.proposed"].provenance).toBe(VALID.provenance);
  });
});
