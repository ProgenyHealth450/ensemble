import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allowedStepFields, validateWorkflow } from "../src/workflow/validator";
import { SUPPORTED_STEP_KINDS } from "../src/workflow/schema";

/**
 * br-n3gj: a workflow manifest that declares a field the schema ignores looks
 * explicitly wired and is not. These tests pin the diagnostic, and — more
 * importantly — pin the allow-list against the interface declarations it
 * duplicates, because a table that silently falls behind the schema would
 * reject valid manifests, which is a worse failure than the one being fixed.
 */

function workflowWith(step: Record<string, unknown>) {
  return validateWorkflow({
    behaviorName: "t",
    workflow: {
      schema_version: "1.0.0",
      start: "s",
      steps: [step, { id: "done", kind: "outcome", outcome: "ok", status: "succeeded" }],
    },
    declaredOutcomes: ["ok"],
    behaviorTools: ["bash"],
    behaviorCommands: ["verification.run"],
    knownCommands: ["verification.run"],
  });
}

const messages = (r: ReturnType<typeof validateWorkflow>) => r.diagnostics.map((d) => d.message).join("\n");

describe("unknown fields on a workflow step are rejected", () => {
  it("rejects the exact key that shipped twice: 'next'", () => {
    const result = workflowWith({ id: "s", kind: "command", command: "verification.run", args: {}, next: "done" });

    expect(result.valid).toBe(false);
    expect(messages(result)).toContain('unknown field "next"');
  });

  it("names the allowed fields, so the author can see what was meant", () => {
    // A bare "unknown field" message tells an author they are wrong without
    // telling them what is right, which sends them to the source.
    const result = workflowWith({ id: "s", kind: "command", command: "verification.run", args: {}, next: "done" });

    expect(messages(result)).toContain("command");
    expect(messages(result)).toContain("on_failure");
  });

  it("attributes the diagnostic to the offending step, not the workflow", () => {
    const result = workflowWith({ id: "s", kind: "command", command: "verification.run", args: {}, nope: 1 });

    expect(result.diagnostics.some((d) => d.step === "s")).toBe(true);
  });

  it("accepts a step that uses only declared fields", () => {
    const result = workflowWith({
      id: "s",
      kind: "command",
      command: "verification.run",
      args: {},
      timeout: "90s",
      on_failure: "done",
    });

    expect(messages(result)).not.toContain("unknown field");
  });

  it("does not treat a field valid on another kind as valid here", () => {
    // `then` is real, but only on a condition. Accepting it anywhere would
    // reintroduce exactly the silent-ignore this fixes.
    const result = workflowWith({ id: "s", kind: "command", command: "verification.run", args: {}, then: "done" });

    expect(messages(result)).toContain('unknown field "then"');
  });
});

describe("the allow-list matches the schema it duplicates", () => {
  const schemaSource = readFileSync(join(__dirname, "..", "src", "workflow", "schema.ts"), "utf8");

  /** Field names declared on an interface body in schema.ts. */
  function declaredFields(interfaceName: string): string[] {
    const start = schemaSource.indexOf(`export interface ${interfaceName}`);
    if (start < 0) throw new Error(`${interfaceName} not found in schema.ts`);
    const body = schemaSource.slice(start, schemaSource.indexOf("\n}", start));
    return [...body.matchAll(/^\s*readonly ([a-z_]+)\??:/gm)].map((m) => m[1]);
  }

  const INTERFACES: Record<string, string> = {
    agent: "AgentStep",
    command: "CommandStep",
    condition: "ConditionStep",
    approval: "ApprovalStep",
    outcome: "OutcomeStep",
  };

  it.each(SUPPORTED_STEP_KINDS)("allows every field %s declares", (kind) => {
    const declared = [...declaredFields("WorkflowStepBase"), ...declaredFields(INTERFACES[kind])];
    const allowed = allowedStepFields(kind);

    // If this fails, someone added a field to schema.ts and the validator will
    // now reject manifests that legitimately use it.
    expect(declared.filter((f) => !allowed.includes(f))).toEqual([]);
  });

  it.each(SUPPORTED_STEP_KINDS)("allows nothing %s does not declare", (kind) => {
    const declared = [...declaredFields("WorkflowStepBase"), ...declaredFields(INTERFACES[kind])];

    expect(allowedStepFields(kind).filter((f) => !declared.includes(f))).toEqual([]);
  });
});
