import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentPort } from "../src/agent-port";

/**
 * "I could not check" must not resolve to "therefore allow".
 *
 * Found while investigating br-r3om, which recorded a write to package.json
 * with no corresponding tool call in any transcript. The port's two OS-level
 * boundaries — an isolated worktree as cwd, and a throwaway HOME — stop a
 * child that writes RELATIVE paths. They deliberately do not stop one that
 * writes an ABSOLUTE path back into the live repository, and the file says so
 * rather than pretending otherwise.
 *
 * Detection is therefore the only control covering that residual case. So a
 * detection that could not run is not a neutral outcome: it is the absence of
 * the single control that applies. Before this, `drift === undefined` fell
 * through to `return { ok: true, reply }` — the br-dowt pattern, in the
 * containment path.
 *
 * It was reachable mainly when the port ran unisolated, which is precisely
 * when containment is weakest, so failing open was worst exactly where it
 * mattered most.
 */

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A directory that is NOT a git repo, so no tree baseline can be captured. */
function nonRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "no-git-"));
  dirs.push(dir);
  return dir;
}

function port(root: string) {
  return createAgentPort({
    repoRoot: root,
    // Unisolated on purpose: this is the configuration in which drift
    // detection is the only remaining control.
    allowUnisolated: true,
    isolate: () => ({ ok: false as const, reason: "not a git repository (test)" }),
    run: async () => "the agent's reply",
  });
}

const REQUEST = {
  behavior: "b",
  stepId: "s",
  prompt: "p",
  tools: ["read"],
  timeoutMs: 10_000,
  signal: new AbortController().signal,
};

describe("an unverifiable working tree is refused, not trusted", () => {
  it("discards the reply when drift could not be determined", async () => {
    const result = await port(nonRepo()).invoke(REQUEST as never);

    expect(result.ok).toBe(false);
  });

  it("says why, rather than reporting a generic failure", async () => {
    const result = (await port(nonRepo()).invoke(REQUEST as never)) as { ok: false; reason: string };

    expect(result.reason).toMatch(/could not be checked/);
    // The consequence is stated, not just the condition: a reader must
    // understand that a write into the live repo cannot be ruled out.
    expect(result.reason).toMatch(/cannot be ruled out/);
  });

  it("does not return the agent's reply, which is the actual hazard", async () => {
    const result = await port(nonRepo()).invoke(REQUEST as never);

    expect(JSON.stringify(result)).not.toContain("the agent's reply");
  });

  it("logs the unavailability, so a refusal is explicable after the fact", async () => {
    const entries: Record<string, unknown>[] = [];
    const p = createAgentPort({
      repoRoot: nonRepo(),
      allowUnisolated: true,
      isolate: () => ({ ok: false as const, reason: "not a git repository (test)" }),
      run: async () => "reply",
      log: (entry) => entries.push(entry),
    });

    await p.invoke(REQUEST as never);

    expect(entries.some((e) => e.kind === "agent-invoke-drift-unavailable")).toBe(true);
  });

  it("still refuses outright when isolation is unavailable and unisolated is not allowed", async () => {
    // The stronger, pre-existing guarantee must survive this change: an
    // uncontained child is not a supported degraded mode.
    const p = createAgentPort({
      repoRoot: nonRepo(),
      isolate: () => ({ ok: false as const, reason: "not a git repository (test)" }),
      run: async () => "reply",
    });

    const result = (await p.invoke(REQUEST as never)) as { ok: false; reason: string };
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/refusing to invoke/);
  });
});
