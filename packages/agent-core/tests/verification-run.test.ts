import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommandCatalog } from "../src/cqrs/commands";
import { ProposalStore } from "../src/cqrs/proposal-store";

/**
 * br-zctt: a pre-PR gate that accepts a vacuous pass is worse than no gate,
 * because it manufactures confidence in a change that nothing checked.
 *
 * `verification.run` exists because `fix.verify` can only verify a proposal's
 * writes; a gate wants to check the tree as it stands. It was written as a
 * separate command rather than an optional proposal binding on `fix.verify`,
 * since an optional binding on a security-relevant command is how the binding
 * comes to be skipped.
 */

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

function runVerification(options: {
  stdout?: string;
  exitCode?: number;
  isolationFails?: boolean;
}): Promise<{ verdict: string; vacuous: boolean; detail: string }> {
  const root = mkdtempSync(join(tmpdir(), "verrun-"));
  const isolated = mkdtempSync(join(tmpdir(), "verrun-iso-"));
  roots.push(root, isolated);

  const catalog = createCommandCatalog({
    workspaceRoot: root,
    store: new ProposalStore(root),
    runCommand: () => ({
      stdout: options.stdout ?? "Tests:       2 passed, 2 total\n",
      stderr: "",
      exitCode: options.exitCode ?? 0,
      timedOut: false,
    }),
    isolate: () =>
      options.isolationFails
        ? { ok: false, reason: "not a git repository with a commit" }
        : { ok: true, workspace: { root: isolated, dispose: () => undefined } },
  });

  const descriptor = catalog.find((c) => c.id === "verification.run");
  if (!descriptor) throw new Error("verification.run is not in the catalog");

  return descriptor
    .handler({ log: () => undefined, signal: new AbortController().signal } as never, {
      command: "npm test",
    } as never)
    .then((outcome) => {
      if (outcome.status !== "completed") throw new Error(`unexpected status ${outcome.status}`);
      return outcome.result as { verdict: string; vacuous: boolean; detail: string };
    });
}

describe("a vacuous run is never reported as a pass", () => {
  it("flags a suite that ran zero tests", async () => {
    const result = await runVerification({ stdout: "Tests:       0 total\n", exitCode: 0 });

    // Exit code 0. A bare exit-code gate would have called this success.
    expect(result.vacuous).toBe(true);
    expect(result.verdict).not.toBe("passed");
  });

  it("keeps vacuity in its own field, so it cannot be collapsed into failure", async () => {
    // "Your code is broken" and "nothing was checked" send a reader to
    // completely different places. A consumer that only sees "not passed"
    // loses that distinction and sends them to debug code that never ran.
    const broken = await runVerification({ stdout: "Tests:       1 failed, 1 total\n", exitCode: 1 });

    expect(broken.verdict).toBe("failed");
    expect(broken.vacuous).toBe(false);
  });

  it("passes a run that genuinely executed tests", async () => {
    const result = await runVerification({ stdout: "Tests:       2 passed, 2 total\n", exitCode: 0 });

    expect(result.verdict).toBe("passed");
    expect(result.vacuous).toBe(false);
  });
});

describe("it refuses to verify what it could not isolate", () => {
  it("reports inconclusive rather than falling back to the live tree", async () => {
    // Running in the live tree would make verification a mutation — the exact
    // thing isolation exists to avoid. "We could not isolate" must not
    // resolve to "therefore proceed".
    const result = await runVerification({ isolationFails: true });

    expect(result.verdict).toBe("inconclusive");
    expect(result.detail).toMatch(/not a git repository/);
  });

  it("does not report an unisolated run as vacuous, which would misattribute the cause", async () => {
    const result = await runVerification({ isolationFails: true });

    expect(result.vacuous).toBe(false);
  });
});

describe("the command is registered and constrained", () => {
  it("is in the catalog with its own capability", async () => {
    const root = mkdtempSync(join(tmpdir(), "verrun-cap-"));
    roots.push(root);
    const catalog = createCommandCatalog({ workspaceRoot: root, store: new ProposalStore(root) });
    const descriptor = catalog.find((c) => c.id === "verification.run")!;

    expect(descriptor.requiredCapability).toBe("verification.run");
  });

  it("declares no mutation class, because verifying changes nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "verrun-mut-"));
    roots.push(root);
    const catalog = createCommandCatalog({ workspaceRoot: root, store: new ProposalStore(root) });
    const descriptor = catalog.find((c) => c.id === "verification.run")!;

    expect(descriptor.mutation).toBeUndefined();
    expect(descriptor.requiresApproval).toBeFalsy();
  });
});
