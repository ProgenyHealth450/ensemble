import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverBehaviorPackages } from "../src/behavior/package-discovery";
import { compile } from "../src/behavior/compiler";
import { readPackageAsset } from "../src/behavior/package-assets";
import { explainInertTrigger } from "../src/behavior/trigger-producers";
import { EVENT_DISPOSITIONS } from "../src/behavior/event-disposition";
import { createCommandCatalog, BUILTIN_COMMAND_CAPABILITIES } from "../src/cqrs/commands";
import { ProposalStore } from "../src/cqrs/proposal-store";
import { WorkflowDefinition, WorkflowStep } from "../src/workflow/schema";

/** br-gpha: the doc.verify command and the shipped doc-claim-check package. */

const REPO_ROOT = join(__dirname, "..", "..", "..");
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function pkg() {
  const found = discoverBehaviorPackages(REPO_ROOT, { searchRoots: ["packages", "."] });
  const match = found.find((p) => p.behaviorId === "doc-claim-check");
  if (!match) throw new Error("doc-claim-check behavior package was not discovered");
  return match;
}

const steps = (): readonly WorkflowStep[] =>
  (pkg().manifest!.execution.workflow as WorkflowDefinition).steps;
const step = (id: string) => steps().find((s) => s.id === id)!;

async function runDocVerify(claims: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), "docverify-"));
  dirs.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "real.ts"), "export function compile() {}\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { validate: "echo" } }));

  const catalog = createCommandCatalog({ workspaceRoot: root, store: new ProposalStore(root) });
  const descriptor = catalog.find((c) => c.id === "doc.verify")!;
  return descriptor.handler({ log: () => undefined, signal: new AbortController().signal } as never, {
    claims,
    sourceFiles: ["src/real.ts"],
  } as never);
}

describe("doc.verify adjudicates, and refuses what it cannot adjudicate", () => {
  it("reports unresolved claims", async () => {
    const outcome = await runDocVerify([{ kind: "path", value: "src/missing.ts", source: "g.md" }]);

    expect(outcome.status).toBe("completed");
    expect((outcome as { result: { ok: boolean } }).result.ok).toBe(false);
  });

  it("confirms claims that hold", async () => {
    const outcome = await runDocVerify([
      { kind: "path", value: "src/real.ts" },
      { kind: "npm-script", value: "validate" },
      { kind: "symbol", value: "compile" },
    ]);

    expect((outcome as { result: { ok: boolean; checked: number } }).result.ok).toBe(true);
    expect((outcome as { result: { checked: number } }).result.checked).toBe(3);
  });

  it("rejects an unknown claim kind rather than skipping it", async () => {
    // Silently dropping a claim would let a document report "all claims
    // verified" when some were never checked — a vacuous pass wearing the
    // costume of a thorough one.
    const outcome = await runDocVerify([{ kind: "vibes", value: "looks right" }]);

    expect(outcome.status).toBe("rejected");
  });

  it("records every verdict as evidence, not just the failures", async () => {
    const outcome = await runDocVerify([
      { kind: "path", value: "src/real.ts" },
      { kind: "path", value: "src/missing.ts" },
    ]);

    expect(outcome.status === "completed" && outcome.evidence).toHaveLength(2);
  });
});

describe("the behavior package is valid and reachable", () => {
  it("compiles with its prompt and against the real command catalog", () => {
    const dir = dirname(pkg().manifestPath);
    const result = compile(
      { behaviors: [pkg().manifest!] },
      {
        knownCommands: Object.keys(BUILTIN_COMMAND_CAPABILITIES),
        readPrompt: (_name, relative) => readPackageAsset(dir, relative),
      },
    );

    expect(result.errors).toEqual([]);
  });

  it("triggers on a type something now actually emits", () => {
    // Before br-gpha this was declared and produced by nothing, which would
    // have made the whole behavior inert.
    expect(EVENT_DISPOSITIONS["repository.changed"]).toBe("keep");
    expect(explainInertTrigger("repository.changed")).toBeUndefined();
  });

  it("does not trigger on branch creation, which changes no files", () => {
    expect(pkg().manifest!.trigger.event_type).toBe("repository.changed");
  });
});

describe("the model proposes; it never adjudicates", () => {
  it("extracts with an agent step and decides with a command step", () => {
    expect(step("extract").kind).toBe("agent");
    expect(step("check").kind).toBe("command");
    expect((step("check") as Extract<WorkflowStep, { kind: "command" }>).command).toBe("doc.verify");
  });

  it("requires JSON from the extraction step", () => {
    // Prose would let "I checked the docs and they look fine" pass as a
    // result — a confident claim with nothing behind it, which is the exact
    // shape of the problem this behavior exists to catch.
    expect((step("extract") as Extract<WorkflowStep, { kind: "agent" }>).expect).toBe("json");
  });

  it("gives the extraction step read-only tools", () => {
    expect((step("extract") as Extract<WorkflowStep, { kind: "agent" }>).tools).toEqual(["read"]);
    expect(pkg().manifest!.capabilities.mutation_classes).toEqual([]);
  });

  it("declares the extraction order, since flow is declaration order", () => {
    const order = steps().map((s) => s.id);

    expect(order.indexOf("check")).toBe(order.indexOf("extract") + 1);
    expect(order.indexOf("classify")).toBe(order.indexOf("check") + 1);
  });
});

describe("the prompt teaches restraint, which is what makes the check usable", () => {
  const prompt = () => readPackageAsset(dirname(pkg().manifestPath), "prompts/extract.md");

  it("tells the model to skip historical references", () => {
    // Measured: naive extraction over this repo's own docs reported 30 of 31
    // claims as broken, nearly all correct. A checker that cries wolf is
    // ignored, and then the one real finding is lost with the rest.
    expect(prompt()).toMatch(/[Hh]istorical/);
  });

  it("tells the model not to launder a hedge into an assertion", () => {
    expect(prompt()).toMatch(/hedge/i);
  });

  it("says an empty claim list is a real answer", () => {
    expect(prompt()).toMatch(/empty list is a real answer/i);
  });
});
