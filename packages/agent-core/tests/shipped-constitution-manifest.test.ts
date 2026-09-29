import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { runWorkflow } from "../src/workflow/interpreter";
import type { AgentPort } from "../src/workflow/interpreter";
import type { WorkflowDefinition } from "../src/workflow/schema";

/**
 * br-zcxb: the constitution behavior must judge a rule with the investigation's
 * DIAGNOSIS in hand, not merely the fact that something was verified.
 *
 * The producing half is covered in commands.test.ts: `fix.verified` carries
 * `rationale` and `evidence`. This is the consuming half, which nothing tested.
 * A manifest input is a `${...}` reference resolved at run time; if it names a
 * payload field that does not exist it resolves to nothing and the step runs
 * anyway, with a prompt quietly missing the one input the fix was about. That
 * is the same silent-unreachability shape as the repository.changed wiring.
 *
 * It reads the SHIPPED manifest deliberately. reference-flow.e2e.test.ts
 * embeds its own inline copy, and that copy has drifted: it still passes only
 * `proposalRef` and `detail`, predating this fix. A test fixture that diverges
 * from the artifact it stands for will report green on a manifest nobody runs.
 */

const MANIFEST_PATH = join(__dirname, "..", "..", "..", ".ensemble", "behaviors", "constitution-learning", "behavior.yaml");

function shippedWorkflow(): WorkflowDefinition {
  const manifest = load(readFileSync(MANIFEST_PATH, "utf8")) as {
    execution: { workflow: WorkflowDefinition };
  };
  return manifest.execution.workflow;
}

const DIAGNOSIS = "the suite counted a file that never loaded, so zero tests read as a pass";
const EVIDENCE = ["tests/a.test.ts:1", "src/math.js:3"];

/** A `fix.verified` payload of the shape commands.ts actually emits. */
function verifiedEvent() {
  return {
    type: "fix.verified",
    payload: {
      proposalRef: "prop-1",
      verdict: "passed",
      detail: "2 passed",
      command: "npm test",
      rationale: DIAGNOSIS,
      evidence: EVIDENCE,
    },
  };
}

function capturingAgent(): AgentPort & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async invoke(request) {
      prompts.push(request.prompt);
      // Decline a rule so the run stops at `no-change`; this test is about
      // what reached the assessment, not about what it concluded.
      return { ok: true, reply: JSON.stringify({ warrantsRule: false }) };
    },
  };
}

async function assessPrompt(): Promise<string> {
  const agent = capturingAgent();
  await runWorkflow({
    behavior: "constitution-learning",
    behaviorDigest: "d",
    workflow: shippedWorkflow(),
    event: verifiedEvent() as never,
    registry: { get: () => undefined } as never,
    authority: { canEmit: () => true } as never,
    agent,
    loadPrompt: () => "Assess {{proposalRef}}.\nDiagnosis: {{diagnosis}}\nEvidence: {{evidence}}\n",
    workspaceRoot: process.cwd(),
  });
  if (agent.prompts.length === 0) throw new Error("the assess step never ran");
  return agent.prompts[0];
}

describe("the shipped constitution-learning manifest forwards the diagnosis", () => {
  it("passes the investigation's diagnosis into the assessment", async () => {
    expect(await assessPrompt()).toContain(DIAGNOSIS);
  });

  it("passes the evidence that supported it", async () => {
    const prompt = await assessPrompt();

    for (const item of EVIDENCE) expect(prompt).toContain(item);
  });

  it("still passes the proposal reference, so the diagnosis did not displace it", async () => {
    expect(await assessPrompt()).toContain("prop-1");
  });

  it("declares both inputs in the manifest, not just in a comment", () => {
    // Guards the direction a refactor is most likely to break: someone
    // trimming "unused" inputs sees no test naming them unless one does.
    const step = shippedWorkflow().steps.find((s) => s.id === "assess") as { inputs: Record<string, string> };

    expect(step.inputs.diagnosis).toBe("${event.payload.rationale}");
    expect(step.inputs.evidence).toBe("${event.payload.evidence}");
  });
});

describe("the shipped prompt template renders what the manifest passes it", () => {
  /**
   * The tests above stub `loadPrompt`, so they prove the manifest RESOLVES
   * the inputs, not that anything displays them. Those are separate failures:
   * a prompt template that dropped `{{diagnosis}}` would still receive the
   * value and silently discard it, leaving the assessment exactly as blind as
   * before the fix while every manifest-level test stayed green.
   *
   * This is the last link in the chain: investigate -> rationale ->
   * fix.verified -> manifest inputs -> the text the model actually reads.
   */
  const promptPath = join(
    __dirname, "..", "..", "..", ".ensemble", "behaviors", "constitution-learning", "prompts", "assess.md",
  );
  const template = readFileSync(promptPath, "utf8");

  it("renders the diagnosis", () => {
    expect(template).toContain("{{diagnosis}}");
  });

  it("renders the evidence", () => {
    expect(template).toContain("{{evidence}}");
  });

  it("uses only placeholders the manifest supplies", () => {
    // The other direction: a placeholder with no matching input renders as a
    // literal `{{foo}}` in the prompt, which reads to the model as a
    // formatting glitch rather than missing data.
    const step = shippedWorkflow().steps.find((s) => s.id === "assess") as { inputs: Record<string, string> };
    const supplied = new Set(Object.keys(step.inputs));
    const used = [...template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);

    expect(used.filter((name) => !supplied.has(name))).toEqual([]);
  });
});
