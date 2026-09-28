import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixSandbox } from "../src/fix-sandbox";

/**
 * br-r3om: the fix-provider child ran in the LIVE repository with
 * --no-extensions, so no grant, guard, boundary or log applied to it.
 *
 * Acceptance from the bead: "a child that tries to write a file directly
 * leaves the repository unchanged (proven by a test whose fake child writes
 * to disk)". These tests do exactly that -- the "child" here is a real
 * process writing real files into the directory it was handed.
 */

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "sandbox-src-"));
  dirs.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "committed.ts"), "export const a = 1;\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: root });
  return root;
}

describe("fix-provider sandbox", () => {
  it("absorbs writes a child makes, leaving the live tree untouched", () => {
    const root = repo();
    const sandbox = createFixSandbox(root)!;
    expect(sandbox).toBeDefined();

    // Stand in for the child: write into the directory it was given, the
    // way an ungoverned agent with write tools would.
    writeFileSync(join(sandbox.dir, "src", "committed.ts"), "export const a = 999;\n");
    writeFileSync(join(sandbox.dir, "pretest-hook.json"), "{}\n");

    // The live repository is untouched: same content, no new file.
    expect(readFileSync(join(root, "src", "committed.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(existsSync(join(root, "pretest-hook.json"))).toBe(false);

    sandbox.cleanup();
    expect(existsSync(sandbox.dir)).toBe(false);
  });

  it("mirrors uncommitted work, or the child debugs a healthy repo", () => {
    // The failing test is normally the thing just written. A sandbox at
    // HEAD would not reproduce the failure at all.
    const root = repo();
    writeFileSync(join(root, "src", "committed.ts"), "export const a = 2; // edited\n");
    writeFileSync(join(root, "src", "brand-new.test.ts"), "it('fails', () => expect(1).toBe(2));\n");

    const sandbox = createFixSandbox(root)!;

    expect(readFileSync(join(sandbox.dir, "src", "committed.ts"), "utf8")).toContain("// edited");
    expect(readFileSync(join(sandbox.dir, "src", "brand-new.test.ts"), "utf8")).toContain("fails");
    sandbox.cleanup();
  });

  it("does not copy ignored files", () => {
    const root = repo();
    writeFileSync(join(root, ".gitignore"), "secrets.txt\n");
    writeFileSync(join(root, "secrets.txt"), "token\n");

    const sandbox = createFixSandbox(root)!;

    expect(existsSync(join(sandbox.dir, "secrets.txt"))).toBe(false);
    sandbox.cleanup();
  });

  it("cleans up without disturbing the live repository", () => {
    const root = repo();
    const sandbox = createFixSandbox(root)!;
    sandbox.cleanup();

    // No stale worktree registration left behind, and the tree still works.
    // Only the repository itself remains registered. (Asserting on the name
    // would be meaningless here: the test repo is itself called
    // "sandbox-src-...", which the first version of this test tripped over.)
    const worktrees = execFileSync("git", ["worktree", "list"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((line) => line.trim());
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]).not.toContain("ensemble-fix");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })).toBe("");
  });

  it("returns undefined outside a git repository, so the caller fails closed", () => {
    const plain = mkdtempSync(join(tmpdir(), "not-a-repo-"));
    dirs.push(plain);

    expect(createFixSandbox(plain)).toBeUndefined();
  });
});
