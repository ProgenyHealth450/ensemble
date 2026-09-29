import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentPort } from "../src/agent-port";
import type { SandboxSupport } from "../src/write-sandbox";

/**
 * br-r3om: the refusal path when a host cannot confine writes.
 *
 * Detection is injected rather than probed so BOTH branches run everywhere.
 * Otherwise the fail-closed branch would only execute on hosts without a
 * sandbox -- never on the macOS development machine, and never on CI if CI
 * ever gained one. A refusal that is never exercised is an assumption.
 */

let tempRepo: string;

beforeAll(() => {
  // A real git repo so isolation and drift detection behave normally; empty
  // and throwaway so nothing this session edits can perturb it.
  tempRepo = mkdtempSync(join(tmpdir(), "sandbox-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: tempRepo });
  writeFileSync(join(tempRepo, "README.md"), "probe\n");
  execFileSync("git", ["add", "-A"], { cwd: tempRepo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: tempRepo });
});

afterAll(() => rmSync(tempRepo, { recursive: true, force: true }));

const UNSUPPORTED: SandboxSupport = { supported: false, reason: "no facility on this host" };
const SUPPORTED: SandboxSupport = { supported: true, mechanism: "test-sandbox" };

function request() {
  return {
    prompt: "p",
    tools: ["read"],
    expect: "text" as const,
    maxOutputBytes: 1000,
    timeoutMs: 1000,
    signal: AbortSignal.timeout(5000),
    behavior: "b",
    stepId: "s",
  };
}

describe("an unconfinable host refuses to spawn a real child", () => {
  it("refuses when confinement is unavailable", async () => {
    const port = createAgentPort({ repoRoot: tempRepo, sandbox: () => UNSUPPORTED });

    const result = await port.invoke(request());

    if (result.ok) throw new Error("expected refusal, got a reply");
    expect(result.reason).toContain("not a supported degraded mode");
  });

  it("names the consequence, not just the missing feature", async () => {
    // An operator reading this must understand what they lose, or they will
    // reach for the escape hatch without knowing its cost.
    const port = createAgentPort({ repoRoot: tempRepo, sandbox: () => UNSUPPORTED });

    const result = await port.invoke(request());

    if (result.ok) throw new Error("expected refusal");
    expect(result.reason).toContain("absolute path");
    expect(result.reason).toContain("detection cannot undo it");
  });

  it("proceeds when the operator explicitly allows unconfined writes", async () => {
    let reached = false;
    const port = createAgentPort({
      repoRoot: tempRepo,
      sandbox: () => UNSUPPORTED,
      allowUnconfinedWrites: true,
      run: async () => {
        reached = true;
        return "reply";
      },
    });

    await port.invoke(request());

    expect(reached).toBe(true);
  });
});

describe("a fake run is not blocked by host confinement", () => {
  /**
   * The gate that keeps this from breaking CI. Supplying `run` replaces
   * process execution outright, so there is no child for an OS sandbox to
   * confine. Without this, every fake-run test would refuse on Linux CI while
   * passing on macOS -- a red suite that says nothing about security.
   */
  it("reaches the injected run even when the host cannot confine", async () => {
    let reached = false;
    const port = createAgentPort({
      repoRoot: tempRepo,
      sandbox: () => UNSUPPORTED,
      run: async () => {
        reached = true;
        return "reply";
      },
    });

    const result = await port.invoke(request());

    expect(reached).toBe(true);
    // A throwaway git repo, NOT process.cwd(). Pointing repoRoot at the live
    // monorepo makes drift detection compare a tree this very test run writes
    // to (dist/, jest cache), so invoke() refuses for a real and correct
    // reason that has nothing to do with confinement. An isolated repoRoot
    // lets this assert ok outright instead of tolerating a failure it has to
    // explain away.
    expect(result.ok).toBe(true);
  });

  it("reaches it when the host can confine too", async () => {
    let reached = false;
    const port = createAgentPort({
      repoRoot: tempRepo,
      sandbox: () => SUPPORTED,
      run: async () => {
        reached = true;
        return "reply";
      },
    });

    await port.invoke(request());

    expect(reached).toBe(true);
  });
});
