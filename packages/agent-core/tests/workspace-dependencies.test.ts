import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIsolatedWorkspace, dependencyDirectories } from "../src/cqrs/isolated-workspace";

/**
 * `br-t0so`: an isolated workspace with no dependencies cannot verify anything.
 *
 * A git worktree is a checkout of a COMMIT, so gitignored content — and so
 * `node_modules` — is absent. The test command could not find its own runner,
 * `verifyOutput` correctly returned `inconclusive`, and `fix.verify` could
 * therefore never reach `passed`. Safe, and useless: the whole propose ->
 * verify -> approve -> apply chain terminated at step two.
 *
 * It was invisible to the suite because every existing test injects a fake
 * `runCommand`. These tests use the real filesystem for that reason.
 *
 * The fix must satisfy BOTH halves, and each half is a different past bug:
 *   - the workspace has its dependencies (this bead), and
 *   - a write through them does not reach the source tree (br-bxm7).
 */

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** A real git repo with a committed file and an uncommitted node_modules. */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "deps-"));
  dirs.push(root);
  writeFileSync(join(root, "index.js"), "module.exports = 1;\n");
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  mkdirSync(join(root, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(root, "node_modules", "left-pad", "index.js"), "module.exports = 'pad';\n");
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "first");
  return root;
}

describe("finding what to provision", () => {
  it("finds a top-level node_modules", () => {
    expect(dependencyDirectories(repo())).toContain("node_modules");
  });

  it("finds workspace package dependencies one level down", () => {
    const root = repo();
    mkdirSync(join(root, "packages", "a", "node_modules"), { recursive: true });
    expect(dependencyDirectories(root)).toContain(join("packages", "a", "node_modules"));
  });

  it("reports nothing for a repo with no dependencies, rather than guessing", () => {
    const root = mkdtempSync(join(tmpdir(), "bare-"));
    dirs.push(root);
    expect(dependencyDirectories(root)).toEqual([]);
  });
});

/**
 * Whether this machine's temp filesystem can clone copy-on-write, found by
 * trying the same two commands `cloneDirectory` uses.
 *
 * The positive tests below need CoW. APFS (macOS) and btrfs/xfs have it;
 * ext4 and the GitHub-hosted Linux runners do not. Where it is absent, the
 * designed behaviour is refusal (br-t0so), so those tests are SKIPPED WITH AN
 * ANNOUNCEMENT and the refusal is asserted instead. CI therefore still checks
 * what the product actually does on that filesystem; it just doesn't pretend
 * to check the clone.
 */
function copyOnWriteAvailable(): boolean {
  const probe = mkdtempSync(join(tmpdir(), "cow-probe-"));
  try {
    writeFileSync(join(probe, "a"), "x");
    for (const args of [["-c", join(probe, "a"), join(probe, "b")], ["--reflink=always", join(probe, "a"), join(probe, "c")]]) {
      try {
        execFileSync("cp", args, { stdio: "ignore" });
        return true;
      } catch {
        /* try the next form */
      }
    }
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

const COW = copyOnWriteAvailable();
const describeWithCow = COW ? describe : describe.skip;
if (!COW) {
  // eslint-disable-next-line no-console
  console.warn(
    "Skipping copy-on-write provisioning tests: this filesystem cannot clone copy-on-write. " +
      "Asserting the designed refusal instead (br-t0so).",
  );
}

(COW ? describe.skip : describe)("without copy-on-write, isolation refuses rather than degrading", () => {
  it("refuses, says why, and leaves no worktree behind", () => {
    const root = repo();
    const isolation = createIsolatedWorkspace(root, "test");
    expect(isolation.ok).toBe(false);
    if (isolation.ok) return;
    expect(isolation.reason).toContain("could not be cloned copy-on-write");
    expect(isolation.reason).toContain("Verification is refused");
    // Only the main worktree remains: the half-built one was removed.
    const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((l) => l.startsWith("worktree "));
    expect(worktrees).toHaveLength(1);
    // And the source's dependencies are untouched.
    expect(readFileSync(join(root, "node_modules", "left-pad", "index.js"), "utf8")).toBe("module.exports = 'pad';\n");
  });
});

describeWithCow("an isolated workspace can actually run the suite", () => {
  it("has the dependencies the worktree alone would not contain", () => {
    const root = repo();
    const isolation = createIsolatedWorkspace(root, "test");
    if (!isolation.ok) throw new Error(isolation.reason);

    // The exact thing that was missing: the worktree is a checkout of a
    // commit, and node_modules is gitignored, so without provisioning this
    // path does not exist.
    expect(existsSync(join(isolation.workspace.root, "node_modules", "left-pad", "index.js"))).toBe(true);
    isolation.workspace.dispose();
  });

  it("still carries the committed source, so the candidate has something to patch", () => {
    const root = repo();
    const isolation = createIsolatedWorkspace(root, "test");
    if (!isolation.ok) throw new Error(isolation.reason);

    expect(existsSync(join(isolation.workspace.root, "index.js"))).toBe(true);
    isolation.workspace.dispose();
  });
});

describeWithCow("provisioning does not reconnect the workspace to the live tree", () => {
  it("a new file in the workspace's dependencies does not appear in the source", () => {
    const root = repo();
    const isolation = createIsolatedWorkspace(root, "test");
    if (!isolation.ok) throw new Error(isolation.reason);

    writeFileSync(join(isolation.workspace.root, "node_modules", "planted.js"), "x");

    // br-bxm7 in one line: the old sandbox symlinked node_modules, so this
    // write reached the user's real dependencies.
    expect(existsSync(join(root, "node_modules", "planted.js"))).toBe(false);
    isolation.workspace.dispose();
  });

  it("modifying a shared dependency file leaves the source byte-identical", () => {
    const root = repo();
    const original = readFileSync(join(root, "node_modules", "left-pad", "index.js"), "utf8");
    const isolation = createIsolatedWorkspace(root, "test");
    if (!isolation.ok) throw new Error(isolation.reason);

    writeFileSync(join(isolation.workspace.root, "node_modules", "left-pad", "index.js"), "TAMPERED");

    // Copy-on-write, not hardlinks: a hardlinked file would share an inode
    // and this assertion would fail.
    expect(readFileSync(join(root, "node_modules", "left-pad", "index.js"), "utf8")).toBe(original);
    isolation.workspace.dispose();
  });

  it("removes everything it provisioned on dispose", () => {
    const root = repo();
    const isolation = createIsolatedWorkspace(root, "test");
    if (!isolation.ok) throw new Error(isolation.reason);
    const workspaceRoot = isolation.workspace.root;

    isolation.workspace.dispose();

    expect(existsSync(workspaceRoot)).toBe(false);
    // And the source's own dependencies survive the cleanup.
    expect(existsSync(join(root, "node_modules", "left-pad", "index.js"))).toBe(true);
  });
});
