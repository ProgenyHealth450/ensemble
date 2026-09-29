/**
 * Isolated workspaces for candidate verification (REQ-SAFE-005).
 *
 * "Verify the fix" used to mean: apply it to the user's tree, run the suite,
 * and `git checkout -- .` if it failed. Every part of that is a hazard. The
 * apply is a mutation the policy may forbid; the suite runs against a tree the
 * user is still editing; and the rollback discards their concurrent work
 * along with the candidate, reporting `restored: true` for a file it had never
 * captured.
 *
 * A git worktree replaces all three. The candidate is written into a separate
 * checkout of the same commit, the suite runs there, and cleanup removes a
 * directory rather than reverting anything. The user's tree is never touched,
 * so there is nothing to roll back and no concurrent edit to lose.
 *
 * Where a worktree is unavailable — no git, a detached checkout, a repo with
 * no commits — verification is reported as unavailable. It does not silently
 * fall back to the live tree. That fallback is exactly how a `propose` run
 * ended up leaving a fix applied.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface IsolatedWorkspace {
  readonly root: string;
  /** Removes the worktree and its registration. Safe to call twice. */
  dispose(): void;
}

export type IsolationResult =
  | { readonly ok: true; readonly workspace: IsolatedWorkspace }
  | { readonly ok: false; readonly reason: string };

function git(cwd: string, args: string[]): { status: number; out: string; err: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/**
 * Creates a throwaway worktree at the repository's current HEAD.
 *
 * HEAD rather than the working tree: a worktree is a checkout of a commit, so
 * uncommitted work in the user's tree is deliberately absent. That is a real
 * limitation and is reported rather than papered over — a candidate verified
 * here is verified against committed state.
 */
export function createIsolatedWorkspace(repoRoot: string, label = "verify"): IsolationResult {
  const head = git(repoRoot, ["rev-parse", "--verify", "HEAD"]);
  if (head.status !== 0) {
    return {
      ok: false,
      reason: `cannot isolate: ${repoRoot} is not a git repository with a commit (${head.err.trim() || "no HEAD"})`,
    };
  }

  let dir: string;
  try {
    dir = mkdtempSync(join(tmpdir(), `ensemble-${label}-`));
  } catch (error) {
    return { ok: false, reason: `cannot isolate: ${(error as Error).message}` };
  }

  const worktreeRoot = join(dir, "tree");
  const added = git(repoRoot, ["worktree", "add", "--detach", worktreeRoot, head.out.trim()]);
  if (added.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    return { ok: false, reason: `cannot isolate: git worktree add failed: ${added.err.trim()}` };
  }

  let disposed = false;
  return {
    ok: true,
    workspace: {
      root: worktreeRoot,
      dispose() {
        if (disposed) return;
        disposed = true;
        // Order matters: remove the registration first so git does not keep a
        // stale entry pointing at a directory that no longer exists.
        git(repoRoot, ["worktree", "remove", "--force", worktreeRoot]);
        rmSync(dir, { recursive: true, force: true });
        git(repoRoot, ["worktree", "prune"]);
      },
    },
  };
}

/** Writes candidate contents into an isolated workspace. */
export function materialize(
  workspace: IsolatedWorkspace,
  writes: readonly { path: string; contents: string }[],
): { ok: true } | { ok: false; reason: string } {
  for (const write of writes) {
    if (write.path.startsWith("/") || write.path.split(/[\\/]/).includes("..")) {
      return { ok: false, reason: `candidate path ${JSON.stringify(write.path)} escapes the workspace` };
    }
    const abs = resolve(workspace.root, write.path);
    if (!abs.startsWith(resolve(workspace.root))) {
      return { ok: false, reason: `candidate path ${JSON.stringify(write.path)} resolves outside the workspace` };
    }
    try {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, write.contents, "utf8");
    } catch (error) {
      return { ok: false, reason: `could not write ${write.path}: ${(error as Error).message}` };
    }
  }
  return { ok: true };
}
