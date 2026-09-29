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
    const port = createAgentPort({ repoRoot: process.cwd(), sandbox: () => UNSUPPORTED });

    const result = await port.invoke(request());

    if (result.ok) throw new Error("expected refusal, got a reply");
    expect(result.reason).toContain("not a supported degraded mode");
  });

  it("names the consequence, not just the missing feature", async () => {
    // An operator reading this must understand what they lose, or they will
    // reach for the escape hatch without knowing its cost.
    const port = createAgentPort({ repoRoot: process.cwd(), sandbox: () => UNSUPPORTED });

    const result = await port.invoke(request());

    if (result.ok) throw new Error("expected refusal");
    expect(result.reason).toContain("absolute path");
    expect(result.reason).toContain("detection cannot undo it");
  });

  it("proceeds when the operator explicitly allows unconfined writes", async () => {
    let reached = false;
    const port = createAgentPort({
      repoRoot: process.cwd(),
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
      repoRoot: process.cwd(),
      sandbox: () => UNSUPPORTED,
      run: async () => {
        reached = true;
        return "reply";
      },
    });

    const result = await port.invoke(request());

    expect(reached).toBe(true);
    // Deliberately NOT asserting `result.ok`. repoRoot is the live package
    // directory, and a full test run writes dist/ while this executes, so the
    // drift detector can legitimately refuse. That refusal is correct and
    // unrelated to confinement; asserting ok would make this test fail for a
    // reason it is not about. What matters is that it was not refused BEFORE
    // reaching the child.
    if (!result.ok) expect(result.reason).not.toContain("degraded mode");
  });

  it("reaches it when the host can confine too", async () => {
    let reached = false;
    const port = createAgentPort({
      repoRoot: process.cwd(),
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
