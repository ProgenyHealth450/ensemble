import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentPort } from "@sunstone-partners/ensemble-agent-core";
import { createActivate } from "../src/extension";
import { cleanupSandboxes, enterSandbox, fakePi, sandbox } from "./support/harness";

/**
 * An approved constitution amendment must survive the write boundary
 * (br-9uqd: "WriteBoundaryMonitor must permit exactly that one authorized
 * write"; dev 4914226).
 *
 * The constitution is protected for the whole session, and the boundary
 * reverts any change to it on the next tool call. constitution.apply is the
 * one sanctioned writer, so without adoption the sequence is: approve ->
 * write -> run reports "applied" -> next tool call reverts it -> constitution
 * unchanged. Invisible, and exactly the failure the approval exists to avoid.
 *
 * Driven through production activate() with the REAL write boundary and the
 * real command catalog, because a stub monitor would accept an adoption that
 * does nothing.
 */

jest.setTimeout(60_000);
afterAll(cleanupSandboxes);

const CONSTITUTION = "docs/standards/constitution.md";
const ORIGINAL = "# Constitution\n\n1. No secrets in logs.\n";
const AMENDMENT = "2. A suite that fails to load counts as a failure.";

/**
 * `auto` because applying IS a write, and `propose` refuses every write at
 * the guard. The approval gate still has to say yes.
 */
const BEHAVIOR = `api_version: ensemble.sunstone.dev/v1
kind: Behavior
metadata:
  name: amend-constitution
  version: 1.0.0
trigger:
  event_type: runtime.session.started
policy:
  mode: auto
  timeout: 10m
capabilities:
  tools: []
  mutation_classes: [constitution.write]
  commands: [constitution.propose, constitution.apply]
execution:
  graph: amend-constitution
  test_command: npm test
  workflow:
    schema_version: "1.0.0"
    start: propose
    steps:
      - id: propose
        kind: command
        command: constitution.propose
        args:
          rule: a suite that fails to load counts as a failure
          rationale: verification trusted a runner the same run judged defective
          diff: "${AMENDMENT}"
          sourceEvidence: ["${CONSTITUTION}:3"]
        on_failure: blocked
      - id: apply
        kind: command
        command: constitution.apply
        args:
          proposalRef: \${steps.propose.proposalRef}
        on_failure: blocked
      - id: applied
        kind: outcome
        outcome: constitution.applied
        status: succeeded
      - id: blocked
        kind: outcome
        outcome: behavior.blocked
        status: blocked
outcomes:
  - constitution.applied
  - behavior.blocked
`;

const NO_AGENT: AgentPort = {
  async invoke() {
    return { ok: false, reason: "this workflow has no agent step" };
  },
};

describe("an approved constitution amendment and the write boundary (br-9uqd)", () => {
  it("survives the next tool call, while a later unapproved edit is still reverted", async () => {
    const root = sandbox([
      { path: ".ensemble/behaviors/amend-constitution/behavior.yaml", contents: BEHAVIOR },
      { path: CONSTITUTION, contents: ORIGINAL },
    ]);
    enterSandbox(root);
    const instance = createActivate({ agent: NO_AGENT, approvalHost: { hasUI: true, confirm: async () => true } });
    const { pi, fire } = fakePi();
    instance.activate(pi);

    await fire("session_start", { type: "session_start" });
    expect(instance.runRecords.find((r) => r.behavior === "amend-constitution")?.run?.terminal).toBe("succeeded");
    const amended = readFileSync(join(root, CONSTITUTION), "utf8");
    expect(amended).toContain(AMENDMENT);

    // The boundary runs on the next tool call. The approved text is its new
    // baseline, not a violation.
    expect(await fire("tool_result", {})).toBeUndefined();
    expect(readFileSync(join(root, CONSTITUTION), "utf8")).toBe(amended);

    // Adoption blesses that one change, not the path: an edit nobody
    // approved is reverted to the amended text.
    writeFileSync(join(root, CONSTITUTION), `${amended}3. Smuggled in afterwards.\n`);
    const reply = (await fire("tool_result", {})) as { isError?: boolean } | undefined;
    expect(reply?.isError).toBe(true);
    expect(readFileSync(join(root, CONSTITUTION), "utf8")).toBe(amended);
  });
});
