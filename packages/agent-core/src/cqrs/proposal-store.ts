/**
 * Reviewable proposal artifacts (REQ-SAFE-001, REQ-SAFE-002).
 *
 * `mode: propose` must never apply a candidate change, but "denied" was never
 * the intended end state — a proposal that evaporates is the same as no
 * investigation having happened. The candidate becomes a durable, reviewable
 * artifact with a stable reference instead.
 *
 * The store lives under `.ensemble/proposals/`, which is runtime-owned state
 * and explicitly not project source: `tree-baseline.ts` already excludes
 * `.ensemble/` from drift detection for exactly this reason. Writing here is
 * therefore not a project mutation, and the proposal commands correspondingly
 * declare no mutation class. If that ever stops being true — if a proposal
 * could land in project source — the commands must gain one.
 *
 * Applying a proposal is a different command with a different authority, and
 * it re-reads the workspace before touching anything (REQ-SAFE-002).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type ProposalKind = "fix" | "constitution";

export interface ProposedWrite {
  /** Repository-relative path. */
  readonly path: string;
  readonly contents: string;
  /**
   * SHA-256 of the file's content when the proposal was made, or null when the
   * file did not exist. This is what makes a stale proposal detectable rather
   * than merely unlikely (REQ-SAFE-005).
   */
  readonly baseSha256: string | null;
}

export interface Proposal {
  readonly ref: string;
  readonly kind: ProposalKind;
  readonly behavior: string;
  readonly issue: string;
  readonly rationale: string;
  readonly writes: readonly ProposedWrite[];
  readonly evidence: readonly string[];
  readonly createdAt: string;
  readonly correlationId: string;
  /** Verification verdicts recorded against this proposal, newest last. */
  readonly verifications: readonly {
    readonly verdict: "passed" | "failed" | "inconclusive";
    readonly detail: string;
    readonly command: string;
    readonly at: string;
    /**
     * Suite size this run reported. Retained so the next run of the same
     * command can notice the count dropping — a fix that makes tests stop
     * being collected otherwise reads as an improvement (br-gwww).
     */
    readonly total?: number;
  }[];
  readonly appliedAt?: string;
}

export function hashContents(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

/** Current on-disk hash of a repo-relative path, or null when it does not exist. */
export function currentHash(root: string, relPath: string): string | null {
  const abs = resolve(root, relPath);
  try {
    if (!statSync(abs).isFile()) return null;
    return hashContents(readFileSync(abs));
  } catch {
    return null;
  }
}

export class ProposalStore {
  private readonly dir: string;

  constructor(private readonly root: string) {
    this.dir = join(root, ".ensemble", "proposals");
  }

  get directory(): string {
    return this.dir;
  }

  create(input: Omit<Proposal, "ref" | "createdAt" | "verifications">, at = new Date().toISOString()): Proposal {
    mkdirSync(this.dir, { recursive: true });
    const ref = `${input.kind}-${hashContents(`${input.behavior}:${input.issue}:${at}`).slice(0, 12)}`;
    const proposal: Proposal = { ...input, ref, createdAt: at, verifications: [] };
    writeFileSync(join(this.dir, `${ref}.json`), `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
    return proposal;
  }

  read(ref: string): Proposal | undefined {
    // A ref is a stable handle a workflow passes between steps, and therefore
    // an untrusted string by the time it reaches here.
    if (!/^[a-z]+-[0-9a-f]{12}$/.test(ref)) return undefined;
    const path = join(this.dir, `${ref}.json`);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Proposal;
    } catch {
      return undefined;
    }
  }

  update(proposal: Proposal): Proposal {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${proposal.ref}.json`), `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
    return proposal;
  }

  list(): readonly Proposal[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(this.dir, f), "utf8")) as Proposal;
        } catch {
          return undefined;
        }
      })
      .filter((p): p is Proposal => Boolean(p));
  }

  /**
   * Paths whose current content differs from what the proposal was computed
   * against.
   *
   * This is the check that makes "never silently overwrite concurrent user
   * edits" real. A proposal is a statement about a specific tree; applying it
   * to a different one is applying it to content the author never saw.
   */
  staleWrites(proposal: Proposal): readonly string[] {
    return proposal.writes
      .filter((write) => currentHash(this.root, write.path) !== write.baseSha256)
      .map((write) => write.path);
  }
}
