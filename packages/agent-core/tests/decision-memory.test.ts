import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatDecisionEntry, isGenerated, resolveDecisionsPath } from "../src/cqrs/decision-memory";

/**
 * br-42nn. The dangerous outcome here is not a crash, it is a decision written
 * somewhere nothing reads -- which looks exactly like success.
 */

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "decisions-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "AGENTS.md"), "# Agent brief\n");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("resolving the file a decision belongs in", () => {
  it("finds the hand-authored brief at the repository root", () => {
    const result = resolveDecisionsPath(repo);

    expect(result).toEqual({ path: join(repo, "AGENTS.md") });
  });

  it("finds it from a nested directory, not just the root", () => {
    const nested = join(repo, "packages", "thing", "src");
    mkdirSync(nested, { recursive: true });

    expect(resolveDecisionsPath(nested)).toEqual({ path: join(repo, "AGENTS.md") });
  });

  it("does NOT target a generated AGENTS.md that happens to be nearer", () => {
    // The failure this exists to prevent. `packages/pi/AGENTS.md` is written
    // by the package build; an entry placed there survives until the next
    // regeneration and then vanishes with no error and no warning. A resolver
    // that walked up from here and took the first hit would do exactly that.
    const generatedDir = join(repo, "packages", "pi");
    mkdirSync(generatedDir, { recursive: true });
    writeFileSync(join(generatedDir, "AGENTS.md"), "# GENERATED -- do not edit\n");

    expect(resolveDecisionsPath(generatedDir)).toEqual({ path: join(repo, "AGENTS.md") });
  });

  it("refuses when the repository root has no brief, rather than creating one", () => {
    rmSync(join(repo, "AGENTS.md"));

    const result = resolveDecisionsPath(repo);

    expect("reason" in result && result.reason).toContain("refusing to create one");
  });

  it("refuses outside a git repository, rather than guessing", () => {
    const loose = mkdtempSync(join(tmpdir(), "not-a-repo-"));
    try {
      const result = resolveDecisionsPath(loose, () => undefined);

      expect("reason" in result && result.reason).toContain("not inside a git repository");
    } finally {
      rmSync(loose, { recursive: true, force: true });
    }
  });

  it("names the generated file as generated", () => {
    expect(isGenerated(join("packages", "pi", "AGENTS.md"))).toBe(true);
    expect(isGenerated("AGENTS.md")).toBe(false);
  });
});

describe("the rendered entry carries its own provenance", () => {
  const entry = {
    decision: "Foreman launches the session Ensemble runs inside",
    rationale: "They are not peers exchanging events; treating them as peers produced a transport layer for messages nobody sends.",
    evidence: ["AGENTS.md:12", "docs/architecture/behavior-runtime-contract-v1.md:40"],
    provenance: "user correction in conversation",
    recordedAt: "2026-09-29",
  };

  it("states when it was decided", () => {
    // Staleness has to be visible ON the entry. An undated assertion in a file
    // every session trusts is how an aspirational document accumulates.
    expect(formatDecisionEntry(entry)).toContain("2026-09-29");
  });

  it("states where it came from", () => {
    expect(formatDecisionEntry(entry)).toContain("user correction in conversation");
  });

  it("lists every piece of evidence", () => {
    const rendered = formatDecisionEntry(entry);

    for (const item of entry.evidence) expect(rendered).toContain(item);
  });

  it("keeps the decision as the heading, so the file stays skimmable", () => {
    expect(formatDecisionEntry(entry).split("\n")[0]).toBe(`### ${entry.decision}`);
  });
});

describe("proposing writes nothing", () => {
  it("leaves the brief untouched on disk", async () => {
    // The core safety property: proposing is inert. Covered here against the
    // real file rather than only through the command, because "propose did not
    // write" is the claim, and the file is where it is true or false.
    const before = readFileSync(join(repo, "AGENTS.md"), "utf8");
    resolveDecisionsPath(repo);
    formatDecisionEntry({
      decision: "d",
      rationale: "r",
      evidence: ["e"],
      provenance: "p",
      recordedAt: "2026-09-29",
    });

    expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toBe(before);
    expect(existsSync(join(repo, "AGENTS.md"))).toBe(true);
  });
});
