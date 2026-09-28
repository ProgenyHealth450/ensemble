import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriteBoundaryMonitor, changedPaths } from "../src/behavior/write-boundary-monitor";

/**
 * A long-lived monitor versus a checkout that moves underneath it.
 *
 * The incident these cover: a session activated, someone else ran
 * `pull --ff-only` on the same checkout, and the next tool call -- a
 * read-only `ls` -- reverted four merged files to activation-time content,
 * destroying ~175 lines of tests that arrived with the merge. The monitor was
 * working exactly as written; "pristine" was simply stale.
 */

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const GUARD = "packages/agent-core/src/behavior/mutation-guard.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** An origin repo plus a clone of it, both holding one protected file. */
function repoPair(): { origin: string; clone: string } {
  const root = mkdtempSync(join(tmpdir(), "ext-history-"));
  dirs.push(root);
  const origin = join(root, "origin");
  mkdirSync(join(origin, "packages", "agent-core", "src", "behavior"), { recursive: true });
  writeFileSync(join(origin, GUARD), "export const v = 1;\n");
  git(origin, ["init", "-q", "-b", "main"]);
  git(origin, ["config", "user.email", "t@t"]);
  git(origin, ["config", "user.name", "t"]);
  git(origin, ["add", "-A"]);
  git(origin, ["commit", "-qm", "init"]);

  const clone = join(root, "clone");
  git(root, ["clone", "-q", origin, clone]);
  git(clone, ["config", "user.email", "t@t"]);
  git(clone, ["config", "user.name", "t"]);
  return { origin, clone };
}

function armed(dir: string): WriteBoundaryMonitor {
  const monitor = new WriteBoundaryMonitor(dir);
  monitor.protectAll([...changedPaths(dir), GUARD]);
  return monitor;
}

describe("HEAD moving under a live monitor", () => {
  it("adopts work that arrived by pull instead of reverting it", () => {
    const { origin, clone } = repoPair();
    const monitor = armed(clone); // Baseline captured here, at v = 1.

    // A teammate lands new content and this checkout pulls it.
    writeFileSync(join(origin, GUARD), "export const v = 2;\n// merged work\n");
    git(origin, ["commit", "-qam", "upstream change"]);
    git(clone, ["pull", "-q", "--ff-only", "origin", "main"]);

    const result = monitor.check();

    expect(result.violations).toEqual([]);
    expect(readFileSync(join(clone, GUARD), "utf8")).toContain("merged work");
  });

  it("still reverts a local edit made after the pull", () => {
    const { origin, clone } = repoPair();
    const monitor = armed(clone);

    writeFileSync(join(origin, GUARD), "export const v = 2;\n// merged work\n");
    git(origin, ["commit", "-qam", "upstream change"]);
    git(clone, ["pull", "-q", "--ff-only", "origin", "main"]);
    monitor.check(); // Adopts the merged state.

    writeFileSync(join(clone, GUARD), "export const v = 2;\n// tampered\n");
    const result = monitor.check();

    expect(result.violations.map((v) => v.path)).toEqual([GUARD]);
    const onDisk = readFileSync(join(clone, GUARD), "utf8");
    expect(onDisk).toContain("merged work");
    expect(onDisk).not.toContain("tampered");
  });

  it("does NOT adopt a local commit, which would be a one-command bypass", () => {
    const { clone } = repoPair();
    const monitor = armed(clone);

    // The bypass: edit a protected file and commit it in a single shell
    // call, so HEAD moves and the file matches HEAD. Only the reflog
    // distinguishes this from a pull.
    writeFileSync(join(clone, GUARD), "export const v = 1;\n// laundered\n");
    git(clone, ["commit", "-qam", "sneak"]);

    const result = monitor.check();

    expect(result.violations.map((v) => v.path)).toEqual([GUARD]);
    expect(readFileSync(join(clone, GUARD), "utf8")).not.toContain("laundered");
  });

  it("does NOT adopt uncommitted changes riding along with a pull", () => {
    const { origin, clone } = repoPair();
    const monitor = armed(clone);

    writeFileSync(join(origin, GUARD), "export const v = 2;\n// merged work\n");
    git(origin, ["commit", "-qam", "upstream change"]);
    git(clone, ["pull", "-q", "--ff-only", "origin", "main"]);

    // Legitimate external move, but the working tree no longer matches HEAD.
    writeFileSync(join(clone, GUARD), "export const v = 2;\n// merged work\n// extra\n");
    const result = monitor.check();

    expect(result.violations.map((v) => v.path)).toEqual([GUARD]);
    expect(readFileSync(join(clone, GUARD), "utf8")).not.toContain("extra");
  });

  it("pending() reports nothing after an external pull", () => {
    const { origin, clone } = repoPair();
    const monitor = armed(clone);

    writeFileSync(join(origin, GUARD), "export const v = 2;\n// merged work\n");
    git(origin, ["commit", "-qam", "upstream change"]);
    git(clone, ["pull", "-q", "--ff-only", "origin", "main"]);

    expect(monitor.pending()).toEqual([]);
    expect(readFileSync(join(clone, GUARD), "utf8")).toContain("merged work");
  });
});
