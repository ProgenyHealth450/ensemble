import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Durable capture of decisions reached in conversation (br-42nn).
 *
 * WHY THIS IS NOT THE LEARNING PIPELINE. br-u5o/br-pyg learn from a failure
 * corpus: test failures, recurrence counts. The decision that motivated this
 * was not a failure -- nothing broke, no command errored. A human contradicted
 * a belief the agent had stated, and that correction was the entire signal.
 * No failure-driven machinery would ever have seen it.
 *
 * WHY THE BAR FOR WRITING IS HIGH. AGENTS.md is read by every future session,
 * so a wrong entry is much worse than a missing one: it becomes a fabricated
 * premise that later sessions treat as authoritative and build on. That is not
 * hypothetical -- an aspirational event catalog nobody re-checked misled a
 * session into designing a transport layer for messages nobody sends. Hence
 * propose-only here, approval and application separate, and evidence required
 * by the schema rather than by convention.
 */

/** A generated file must never be written directly; the generator owns it. */
const GENERATED_AGENTS_FILES = [join("packages", "pi", "AGENTS.md")];

export interface DecisionEntry {
  /** What was decided, in one line. */
  readonly decision: string;
  /** Why -- the reasoning that makes the decision reconstructable. */
  readonly rationale: string;
  /** Where it came from: a file, command output, or conversation turn. */
  readonly evidence: readonly string[];
  /** How this was learned. Provenance is part of the record, not metadata. */
  readonly provenance: string;
  /** ISO date; staleness must be visible on the entry itself. */
  readonly recordedAt: string;
}
/**
 * Finds the hand-authored AGENTS.md at the REPOSITORY ROOT.
 *
 * Deliberately NOT the walk-up-and-take-the-first-hit approach that
 * `resolveConstitutionPath` uses. There is exactly one constitution, but
 * AGENTS.md files are plural and some are GENERATED: this repo has the
 * hand-authored root file and `packages/pi/AGENTS.md`, which the package build
 * overwrites. A walk-up from anywhere under `packages/pi/` would find the
 * generated file first and write the entry into it, where it would survive
 * until the next regeneration and then vanish with no error. Anchoring to the
 * repo root makes that unreachable by construction rather than by denylist.
 *
 * Refuses rather than creating a file, for the same reason the constitution
 * resolver does: a decision written somewhere the project does not read has
 * been learned and then discarded, which is worse than not recording it
 * because it looks like it worked.
 */
export function resolveDecisionsPath(
  workspaceRoot: string,
  findRepoRoot: (from: string) => string | undefined = gitRoot,
): { path: string } | { reason: string } {
  const root = findRepoRoot(resolve(workspaceRoot));
  if (!root) {
    return {
      reason:
        `${workspaceRoot} is not inside a git repository, so there is no repository root ` +
        `whose AGENTS.md every session reads; refusing to guess which file to amend`,
    };
  }

  const candidate = join(root, "AGENTS.md");
  // Belt and braces. The root file should never be a generated one, but the
  // consequence of being wrong is a silent loss, so the check is cheap
  // insurance rather than redundancy.
  if (isGenerated(candidate)) {
    return { reason: `${candidate} is a generated file; its generator owns it and a direct write would be overwritten` };
  }
  try {
    readFileSync(candidate, "utf8");
    return { path: candidate };
  } catch {
    return {
      reason:
        `no AGENTS.md exists at the repository root ${root}; ` +
        `refusing to create one, because a decision written somewhere the project does not ` +
        `read is learned and then discarded`,
    };
  }
}

/** Locates the enclosing git repository root, or undefined outside one. */
function gitRoot(from: string): string | undefined {
  let current = from;
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Whether a path is a GENERATED agent file.
 *
 * `packages/pi/AGENTS.md` is produced by the package build. Writing an entry
 * there would survive exactly until the next regeneration and then vanish with
 * no error -- the silent-loss failure mode, and one nobody would think to look
 * for, since the write appeared to succeed.
 */
export function isGenerated(path: string): boolean {
  const normalized = path.split(/[\\/]/).join(sep);
  return GENERATED_AGENTS_FILES.some((generated) => normalized.endsWith(sep + generated) || normalized === generated);
}

/**
 * Renders an entry.
 *
 * Date and provenance are in the rendered text rather than held beside it: an
 * entry whose age and origin are only visible in a proposal record becomes an
 * undated assertion the moment it lands in the file, and undated assertions
 * are what let an aspirational document accumulate unchallenged.
 */
export function formatDecisionEntry(entry: DecisionEntry): string {
  const evidence = entry.evidence.map((item) => `  - ${item}`).join("\n");
  return [
    `### ${entry.decision}`,
    "",
    entry.rationale,
    "",
    `- **Decided:** ${entry.recordedAt}`,
    `- **Source:** ${entry.provenance}`,
    `- **Evidence:**`,
    evidence,
  ].join("\n");
}
