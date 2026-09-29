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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
 * Copies a directory using a copy-on-write clone, or reports that it cannot.
 *
 * A git worktree is a checkout of a COMMIT, so gitignored content is absent —
 * `node_modules` above all. Without it the test command cannot find its own
 * runner, so `fix.verify` could never reach a verdict of `passed` and the
 * propose -> verify -> apply chain terminated at step two (br-t0so).
 *
 * The three ways to give the workspace its dependencies are not equal:
 *
 *   symlink -> instant, but a write through the link reaches the live tree.
 *              This is the defect br-bxm7 recorded against the old sandbox
 *              and it must not come back.
 *   copy    -> safe, and slow enough on a real `node_modules` to make
 *              verification unusable.
 *   CoW     -> instant AND private. Writes diverge from the source instead
 *              of propagating to it.
 *
 * So CoW, and where the filesystem cannot do it we REFUSE and say so. A
 * fallback to symlinking would trade a visible limitation for an invisible
 * hazard, and a fallback to copying would trade it for a verification step
 * nobody waits for.
 */
function cloneDirectory(source: string, destination: string): { ok: true } | { ok: false; reason: string } {
  // APFS (macOS) and btrfs/xfs (Linux) express the same operation
  // differently. `--reflink=always` fails rather than silently copying, which
  // is what we want: a silent copy would be the slow path in disguise.
  const attempts: readonly (readonly string[])[] = [
    ["cp", "-c", "-R", source, destination],
    ["cp", "-R", "--reflink=always", source, destination],
  ];

  const failures: string[] = [];
  for (const [command, ...args] of attempts) {
    const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (result.status === 0) return { ok: true };
    failures.push(`${command} ${args[0]}: ${(result.stderr ?? "").trim() || `exit ${result.status}`}`);
  }
  return { ok: false, reason: failures.join("; ") };
}

/**
 * Dependency directories worth cloning into the workspace.
 *
 * Top level plus one level down, which covers a plain repo and the npm
 * workspaces layout. Deliberately not a full walk: a recursive search would
 * descend into `node_modules` itself and spend longer looking than cloning.
 */
export function dependencyDirectories(repoRoot: string): string[] {
  const found: string[] = [];
  const top = join(repoRoot, "node_modules");
  if (existsSync(top)) found.push("node_modules");

  for (const container of ["packages", "apps"]) {
    const base = join(repoRoot, container);
    if (!existsSync(base)) continue;
    let entries: string[];
    try {
      entries = readdirSync(base);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (existsSync(join(base, entry, "node_modules"))) {
        found.push(join(container, entry, "node_modules"));
      }
    }
  }
  return found;
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

  // Give the workspace its dependencies, or refuse. A worktree without
  // `node_modules` cannot run the test command, so verification would be
  // permanently inconclusive — safe, but useless (br-t0so).
  for (const relative of dependencyDirectories(repoRoot)) {
    const target = join(worktreeRoot, relative);
    mkdirSync(dirname(target), { recursive: true });
    const cloned = cloneDirectory(join(repoRoot, relative), target);
    if (!cloned.ok) {
      git(repoRoot, ["worktree", "remove", "--force", worktreeRoot]);
      rmSync(dir, { recursive: true, force: true });
      git(repoRoot, ["worktree", "prune"]);
      return {
        ok: false,
        reason:
          `cannot isolate: ${relative} could not be cloned copy-on-write, so the workspace would ` +
          `have no dependencies and could not run the suite (${cloned.reason}). ` +
          `Copy-on-write needs APFS, btrfs or xfs. Verification is refused rather than run ` +
          `against a shared or empty tree.`,
      };
    }
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
