import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPort } from "@sunstone-partners/ensemble-agent-core";
import { createActivate } from "../src/extension";
import { createAgentPort } from "../src/agent-port";
import { cleanupSandboxes, enterSandbox, fakePi, failingToolResult, sandbox } from "./support/harness";

/**
 * br-x36p on the governed path: a run acts on the repository the FAILING
 * COMMAND ran in, not on the extension host's.
 *
 * Observed on dev: failures in /private/tmp/wt-autofix-fix sent fix-agent
 * children into the maintainer's main checkout, because every root came from
 * the host's process.cwd(). The same shape here would build the agent's
 * worktree, store the proposal and run verification against a repository
 * where nothing failed.
 *
 * Two real repositories, told apart by a committed identity file. The
 * verification command is the real spawn path in the real isolated worktree;
 * it copies that identity out, so the assertion cannot pass unless the
 * worktree was built from the failing repo.
 */

jest.setTimeout(60_000);

const markers: string[] = [];
afterAll(() => {
  cleanupSandboxes();
  markers.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function behavior(markerFile: string): string {
  return `api_version: ensemble.sunstone.dev/v1
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
  timeout: 10m
capabilities:
  tools: [read, grep, glob]
  mutation_classes: []
  commands: [fix.propose, fix.verify]
execution:
  graph: fix-failing-test
  test_command: 'cat identity.txt > ${markerFile} && echo "Tests:       1 passed, 1 total"'
  workflow:
    schema_version: "1.0.0"
    start: investigate
    steps:
      - id: investigate
        kind: agent
        prompt: prompts/investigate.md
        tools: [read, grep, glob]
        expect: json
        timeout: 2m
        on_failure: inconclusive
      - id: propose-fix
        kind: command
        command: fix.propose
        args:
          issue: \${event.payload.command}
          rationale: \${steps.investigate.diagnosis}
          writes: \${steps.investigate.writes}
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
}

const BROKEN = "exports.add = (a, b) => a - b;\n";
const FIXED = "exports.add = (a, b) => a + b;\n";

describe("a governed run acts on the failing command's repository (br-x36p)", () => {
  it("builds the agent workspace, stores the proposal and verifies in the failing repo", async () => {
    const markerDir = mkdtempSync(join(tmpdir(), "dispatch-root-marker-"));
    markers.push(markerDir);
    const marker = join(markerDir, "verified-in.txt");

    const host = sandbox([
      { path: ".ensemble/behaviors/fix-failing-test/behavior.yaml", contents: behavior(marker) },
      { path: ".ensemble/behaviors/fix-failing-test/prompts/investigate.md", contents: "Diagnose it.\n" },
      { path: "identity.txt", contents: "HOST\n" },
      { path: "src/math.js", contents: BROKEN },
    ]);
    const failing = sandbox([
      { path: "identity.txt", contents: "FAILING-REPO\n" },
      { path: "src/math.js", contents: BROKEN },
    ]);

    const roots: (string | undefined)[] = [];
    const agent: AgentPort = {
      async invoke(request) {
        roots.push(request.workspaceRoot);
        return {
          ok: true,
          reply: JSON.stringify({
            diagnosis: "add subtracts",
            confidence: "high",
            writes: [{ path: "src/math.js", contents: FIXED }],
          }),
        };
      },
    };

    enterSandbox(host);
    const instance = createActivate({ agent });
    const { pi, fire } = fakePi();
    instance.activate(pi);

    await fire("tool_result", {
      ...failingToolResult("npm test", "Tests:       1 failed, 0 passed, 1 total"),
      input: { command: "npm test", cwd: failing },
    });

    const run = instance.runRecords.find((r) => r.behavior === "fix-failing-test")?.run;
    expect(run?.terminal).toBe("succeeded");

    // The agent was pointed at the failing repo...
    expect(roots).toEqual([failing]);
    // ...its candidate was stored there, and nothing was stored in the host...
    expect(readdirSync(join(failing, ".ensemble", "proposals")).length).toBeGreaterThan(0);
    expect(existsSync(join(host, ".ensemble", "proposals"))).toBe(false);
    // ...and verification ran in a worktree of the failing repo.
    expect(readFileSync(marker, "utf8")).toBe("FAILING-REPO\n");
  });

  it("keeps the host repository for an event that names no cwd", async () => {
    const markerDir = mkdtempSync(join(tmpdir(), "dispatch-root-marker-"));
    markers.push(markerDir);
    const marker = join(markerDir, "verified-in.txt");
    const host = sandbox([
      { path: ".ensemble/behaviors/fix-failing-test/behavior.yaml", contents: behavior(marker) },
      { path: ".ensemble/behaviors/fix-failing-test/prompts/investigate.md", contents: "Diagnose it.\n" },
      { path: "identity.txt", contents: "HOST\n" },
      { path: "src/math.js", contents: BROKEN },
    ]);

    const roots: (string | undefined)[] = [];
    const agent: AgentPort = {
      async invoke(request) {
        roots.push(request.workspaceRoot);
        return { ok: true, reply: JSON.stringify({ diagnosis: "add subtracts", confidence: "high", writes: [{ path: "src/math.js", contents: FIXED }] }) };
      },
    };

    enterSandbox(host);
    const instance = createActivate({ agent });
    const { pi, fire } = fakePi();
    instance.activate(pi);
    await fire("tool_result", failingToolResult("npm test", "Tests:       1 failed, 0 passed, 1 total"));

    // process.cwd() reports the resolved path (macOS /var -> /private/var).
    expect(roots).toEqual([realpathSync(host)]);
    expect(readFileSync(marker, "utf8")).toBe("HOST\n");
  });
});

describe("the agent port isolates the repository the run names", () => {
  it("builds its worktree from request.workspaceRoot, not its configured root", async () => {
    const isolated: string[] = [];
    const port = createAgentPort({
      repoRoot: "/host/repo",
      isolate: (root) => {
        isolated.push(root);
        return { ok: false, reason: "stops here: only the root is under test" };
      },
      run: async () => "unused",
    });

    await port.invoke({
      prompt: "p",
      tools: [],
      expect: "json",
      maxOutputBytes: 1_000,
      timeoutMs: 1_000,
      signal: new AbortController().signal,
      behavior: "fix-failing-test",
      stepId: "investigate",
      workspaceRoot: "/failing/repo",
    });

    expect(isolated).toEqual(["/failing/repo"]);
  });
});
