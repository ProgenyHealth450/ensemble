import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProposalStore,
  createCommandCatalog,
  ApprovalHost,
} from "@sunstone-partners/ensemble-agent-core";
import { AgentPort } from "@sunstone-partners/ensemble-agent-core";
import { createActivate } from "../src/extension";
import {
  cleanupSandboxes,
  enterSandbox,
  fakePi,
  failingToolResult,
  sandbox,
  SandboxFile,
} from "./support/harness";

/**
 * Exit gate 3 (`br-behavior-runtime-cqrs-xl24.16`): the reference flow of §4
 * is package-defined and reproducible FROM FIXTURES.
 *
 *     test.failure.observed
 *       -> investigate (read-only agent step)
 *       -> fix.propose (typed command; no project edit)
 *       -> isolated verification
 *       -> outcome: fix.proposed | investigation.inconclusive | behavior.blocked
 *
 *     fix.verified (passed)
 *       -> constitution-learning investigates recurrence
 *       -> constitution.propose (no direct write)
 *
 * "Reproducible from fixtures" is the part the bead is strict about: the
 * previous end-to-end proof depended on a bespoke driver script on one
 * machine, which is not reproducibility. Everything here is a temp git repo,
 * the real `activate()`, and Pi's real event shapes.
 *
 * Note what is NOT faked: the behavior packages are ordinary YAML, the
 * interpreter is the shared one, and the commands are the real catalog. Only
 * the model and the test runner are injected, because a test that calls a live
 * model is not a fixture.
 */

jest.setTimeout(60_000);
afterAll(cleanupSandboxes);

const FIX_BEHAVIOR = `api_version: ensemble.sunstone.dev/v1
kind: Behavior
metadata:
  name: fix-failing-test
  version: 2.0.0
trigger:
  event_type: test.failure.observed
  predicate:
    isError: { equals: true }
policy:
  mode: propose
  timeout: 30m
capabilities:
  tools: [read, grep, glob]
  mutation_classes: []
  commands: [investigation.record, fix.propose, fix.verify]
execution:
  graph: fix-failing-test
  test_command: npm test
  workflow:
    schema_version: "1.0.0"
    start: investigate
    steps:
      - id: investigate
        kind: agent
        prompt: prompts/investigate.md
        tools: [read, grep, glob]
        expect: json
        timeout: 5m
        attempts: 2
        inputs:
          command: \${event.payload.command}
          failureOutput: \${event.payload.output}
        on_failure: inconclusive
      - id: record-diagnosis
        kind: command
        command: investigation.record
        args:
          command: \${event.payload.command}
          diagnosis: \${steps.investigate.diagnosis}
          confidence: \${steps.investigate.confidence}
          evidence: \${steps.investigate.evidence}
        on_failure: inconclusive
      - id: confident-enough
        kind: condition
        left: \${steps.investigate.confidence}
        operator: in
        right: [high, medium]
        then: has-candidate
        otherwise: inconclusive
      - id: has-candidate
        kind: condition
        left: \${steps.investigate.writes}
        operator: exists
        then: propose-fix
        otherwise: inconclusive
      - id: propose-fix
        kind: command
        command: fix.propose
        args:
          issue: \${event.payload.command}
          rationale: \${steps.investigate.diagnosis}
          writes: \${steps.investigate.writes}
          evidence: \${steps.investigate.evidence}
        on_failure: blocked
      - id: verify-candidate
        kind: command
        command: fix.verify
        args:
          proposalRef: \${steps.propose-fix.proposalRef}
          command: \${behavior.testCommand}
        on_failure: proposed
      - id: proposed
        kind: outcome
        outcome: fix.proposed
        status: succeeded
        evidence:
          - \${steps.propose-fix.proposalRef}
      - id: inconclusive
        kind: outcome
        outcome: investigation.inconclusive
        status: inconclusive
      - id: blocked
        kind: outcome
        outcome: behavior.blocked
        status: blocked
outcomes:
  - fix.proposed
  - investigation.inconclusive
  - behavior.blocked
`;

const LEARN_BEHAVIOR = `api_version: ensemble.sunstone.dev/v1
kind: Behavior
metadata:
  name: constitution-learning
  version: 1.0.0
trigger:
  event_type: fix.verified
  predicate:
    verdict: { equals: passed }
policy:
  mode: propose
  timeout: 30m
capabilities:
  tools: [read, grep, glob]
  mutation_classes: []
  commands: [constitution.propose]
execution:
  graph: constitution-learning
  workflow:
    schema_version: "1.0.0"
    start: assess
    steps:
      - id: assess
        kind: agent
        prompt: prompts/assess.md
        tools: [read, grep, glob]
        expect: json
        timeout: 5m
        inputs:
          proposalRef: \${event.payload.proposalRef}
          detail: \${event.payload.detail}
        on_failure: no-change
      - id: warrants-a-rule
        kind: condition
        left: \${steps.assess.warrantsRule}
        operator: equals
        right: true
        then: propose-amendment
        otherwise: no-change
      - id: propose-amendment
        kind: command
        command: constitution.propose
        args:
          rule: \${steps.assess.rule}
          rationale: \${steps.assess.rationale}
          diff: \${steps.assess.diff}
          sourceEvidence: \${steps.assess.sourceEvidence}
        on_failure: blocked
      - id: proposed
        kind: outcome
        outcome: constitution.proposed
        status: succeeded
      - id: no-change
        kind: outcome
        outcome: constitution.no_change_warranted
        status: succeeded
      - id: blocked
        kind: outcome
        outcome: behavior.blocked
        status: blocked
outcomes:
  - constitution.proposed
  - constitution.no_change_warranted
  - behavior.blocked
`;

const SOURCE = "exports.add = (a, b) => a - b;\n";
const CANDIDATE = "exports.add = (a, b) => a + b;\n";
const CONSTITUTION = "# Constitution\n\n## Rules\n\n1. No secrets in code.\n";

const FILES: readonly SandboxFile[] = [
  { path: ".ensemble/behaviors/fix-failing-test/behavior.yaml", contents: FIX_BEHAVIOR },
  { path: ".ensemble/behaviors/fix-failing-test/prompts/investigate.md", contents: "Diagnose {{command}}.\n" },
  { path: ".ensemble/behaviors/constitution-learning/behavior.yaml", contents: LEARN_BEHAVIOR },
  { path: ".ensemble/behaviors/constitution-learning/prompts/assess.md", contents: "Assess {{proposalRef}}.\n" },
  { path: "src/math.js", contents: SOURCE },
  { path: "docs/standards/constitution.md", contents: CONSTITUTION },
  { path: "package.json", contents: JSON.stringify({ name: "ref", version: "1.0.0" }) },
];

const INVESTIGATION = JSON.stringify({
  diagnosis: "add() subtracts; the operator is wrong",
  confidence: "high",
  evidence: ["src/math.js:1 - uses - instead of +"],
  writes: [{ path: "src/math.js", contents: CANDIDATE }],
});

const ASSESSMENT = JSON.stringify({
  warrantsRule: true,
  rule: "A suite that fails to load must count as a failure",
  rationale: "amends Rule 1; a non-loading suite was counted as passing",
  diff: "2. **A suite that fails to load counts as a failure.**",
  sourceEvidence: ["docs/standards/constitution.md:5"],
});

function agentReturning(replies: Record<string, string>): AgentPort & { steps: string[] } {
  const steps: string[] = [];
  return {
    steps,
    async invoke(request) {
      steps.push(`${request.behavior}:${request.stepId}`);
      const reply = replies[request.stepId];
      return reply === undefined
        ? { ok: false, reason: `no scripted reply for ${request.stepId}` }
        : { ok: true, reply };
    },
  };
}

/**
 * The real catalog with the test runner and the worktree injected.
 *
 * Verification still goes through `verifyOutput`, so the fail-closed rules
 * under test are the production ones; only the process that produces the
 * output is replaced.
 */
function catalogFor(root: string, output: { stdout: string; exitCode: number }) {
  return createCommandCatalog({
    workspaceRoot: root,
    store: new ProposalStore(root),
    runCommand: () => ({ stdout: output.stdout, stderr: "", exitCode: output.exitCode, timedOut: false }),
    // A throwaway directory rather than a git worktree: the isolation boundary
    // itself is covered in hostile-tools.e2e.test.ts, and re-proving it here
    // would make this test fail for a reason unrelated to the flow. It must
    // still be a DIFFERENT directory from the project -- pointing it at the
    // live root would make the candidate land in the tree this test exists to
    // prove is untouched.
    isolate: () => {
      const dir = mkdtempSync(join(tmpdir(), "ref-flow-verify-"));
      return { ok: true, workspace: { root: dir, dispose: () => rmSync(dir, { recursive: true, force: true }) } };
    },
  });
}

const PASSING_JEST = "Tests:       2 passed, 0 failed, 2 total\n";

async function runFlow(
  root: string,
  agent: AgentPort,
  output = { stdout: PASSING_JEST, exitCode: 0 },
  approvalHost?: ApprovalHost,
) {
  enterSandbox(root);
  const instance = createActivate({ agent, catalog: catalogFor(root, output), approvalHost });
  const { pi, fire, userMessages } = fakePi();
  instance.activate(pi);
  await fire("tool_result", failingToolResult("npm test", "Tests:       1 failed, 0 passed, 1 total"));
  return { instance, userMessages };
}

function proposals(root: string): Record<string, unknown>[] {
  const dir = join(root, ".ensemble", "proposals");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

describe("the reference flow runs from package data alone", () => {
  it("investigates, proposes, verifies, and changes nothing in the project", async () => {
    const root = sandbox(FILES);
    const agent = agentReturning({ investigate: INVESTIGATION, assess: ASSESSMENT });

    const { instance, userMessages } = await runFlow(root, agent);

    const fixRun = instance.runRecords.find((r) => r.behavior === "fix-failing-test");
    expect(fixRun?.run?.terminal).toBe("succeeded");
    expect(fixRun?.run?.outcome).toBe("fix.proposed");

    // Every step the package declared actually ran, in order.
    expect(fixRun?.run?.steps.map((s) => s.stepId)).toEqual([
      "investigate",
      "record-diagnosis",
      "confident-enough",
      "has-candidate",
      "propose-fix",
      "verify-candidate",
      "proposed",
    ]);

    const fix = proposals(root).find((p) => p.kind === "fix");
    expect(fix).toBeDefined();
    expect((fix as { verifications: { verdict: string }[] }).verifications[0].verdict).toBe("passed");
    expect((fix as { appliedAt?: string }).appliedAt).toBeUndefined();

    // The canonical state is untouched: a proposal exists, the file does not
    // carry it, and nothing was queued onto a later turn.
    expect(readFileSync(join(root, "src", "math.js"), "utf8")).toBe(SOURCE);
    expect(userMessages).toEqual([]);
  });

  it("composes: the constitution behavior reacts to verified evidence, not to the failure", async () => {
    const root = sandbox(FILES);
    const agent = agentReturning({ investigate: INVESTIGATION, assess: ASSESSMENT });

    const { instance } = await runFlow(root, agent);

    // The assessment step ran, and it ran for the SECOND behavior, triggered
    // by `fix.verified` rather than by `test.failure.observed`. That ordering
    // is the whole of REQ-SAFE-008's "trigger only on verified evidence".
    expect(agent.steps).toEqual(["fix-failing-test:investigate", "constitution-learning:assess"]);

    const learnRun = instance.runRecords.find((r) => r.behavior === "constitution-learning");
    expect(learnRun?.run?.terminal).toBe("succeeded");
    expect(learnRun?.run?.outcome).toBe("constitution.proposed");

    const amendment = proposals(root).find((p) => p.kind === "constitution");
    expect(amendment).toBeDefined();
    expect((amendment as { evidence: string[] }).evidence.length).toBeGreaterThan(0);

    // Proposed, never applied. The constitution on disk is untouched.
    expect((amendment as { appliedAt?: string }).appliedAt).toBeUndefined();
    expect(readFileSync(join(root, "docs", "standards", "constitution.md"), "utf8")).toBe(CONSTITUTION);
  });

  it("does not run the constitution behavior when verification did not pass", async () => {
    const root = sandbox(FILES);
    const agent = agentReturning({ investigate: INVESTIGATION, assess: ASSESSMENT });

    // Zero tests: `inconclusive`, never `passed`.
    await runFlow(root, agent, { stdout: "Tests:       0 total\n", exitCode: 0 });

    expect(agent.steps).toEqual(["fix-failing-test:investigate"]);
    expect(proposals(root).some((p) => p.kind === "constitution")).toBe(false);
  });

  it("a trivial fix that warrants no rule produces no amendment", async () => {
    const root = sandbox(FILES);
    const agent = agentReturning({
      investigate: INVESTIGATION,
      // A one-line arithmetic bug legitimately implies no constitution change.
      // A system that emits a rule per fix produces a constitution nobody
      // reads, which costs more than it adds.
      assess: JSON.stringify({ warrantsRule: false, rationale: "an operator typo implies no rule" }),
    });

    const { instance } = await runFlow(root, agent);

    const learnRun = instance.runRecords.find((r) => r.behavior === "constitution-learning");
    expect(learnRun?.run?.outcome).toBe("constitution.no_change_warranted");
    expect(proposals(root).some((p) => p.kind === "constitution")).toBe(false);
  });

  it("an inaccurate model success claim is rejected by independent verification", async () => {
    const root = sandbox(FILES);
    const agent = agentReturning({ investigate: INVESTIGATION, assess: ASSESSMENT });

    // The runner says everything passed AND that a suite could not load. Both
    // cannot be true, and the reading that would let a broken fix through is
    // the one to disbelieve (br-gwww).
    await runFlow(root, agent, {
      stdout: "Test suite failed to run\nCannot find module '../src/rounding'\nTests:       2 passed, 0 failed, 2 total\n",
      exitCode: 0,
    });

    const fix = proposals(root).find((p) => p.kind === "fix") as { verifications: { verdict: string; detail: string }[] };
    expect(fix.verifications[0].verdict).toBe("inconclusive");
    expect(fix.verifications[0].detail).toMatch(/could not be loaded/);
    // And because nothing was verified, no constitution behavior fired.
    expect(agent.steps).toEqual(["fix-failing-test:investigate"]);
  });

  it("a duplicate failure event does not start a second overlapping run", async () => {
    const root = sandbox(FILES);
    const agent = agentReturning({ investigate: INVESTIGATION, assess: ASSESSMENT });

    enterSandbox(root);
    const instance = createActivate({ agent, catalog: catalogFor(root, { stdout: PASSING_JEST, exitCode: 0 }) });
    const { pi, fire } = fakePi();
    instance.activate(pi);

    const event = failingToolResult("npm test", "Tests:       1 failed, 0 passed, 1 total");
    await fire("tool_result", event);
    await fire("tool_result", { ...event, toolCallId: "tr-2" });

    const fixRuns = instance.runRecords.filter((r) => r.behavior === "fix-failing-test");
    const invoked = fixRuns.filter((r) => r.run);
    const refused = fixRuns.filter((r) => r.skipped);

    // The second event is seen and explicitly refused rather than silently
    // dropped, so an operator reading status can tell the difference between
    // "bounded" and "broken".
    expect(invoked).toHaveLength(1);
    expect(refused.length).toBeGreaterThan(0);
    expect(refused[0].skipped).toMatch(/budget exhausted/);
  });
});
