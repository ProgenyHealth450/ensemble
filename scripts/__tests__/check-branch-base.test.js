const { execFileSync, spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const SCRIPT = join(__dirname, "..", "check-branch-base.js");

/**
 * `br-jg0l`: refuse work published from a branch behind its base.
 *
 * The case that matters most here is not "detects behind" — it is that the
 * check cannot pass VACUOUSLY. The first version of this script compared
 * against `@{u}`, which in a CI checkout resolves to the same branch, giving
 * `0 0` and a green tick that had compared nothing. A gate that passes
 * because it checked nothing is worse than no gate.
 */

const dirs = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function run(cwd, ...args) {
  const result = spawnSync("node", [SCRIPT, ...args], { cwd, encoding: "utf8" });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

/** A repo with `main`, and a `feature` branch forked one commit back. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "branch-base-"));
  dirs.push(dir);
  git(dir, "init", "--quiet", "--initial-branch=main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  writeFileSync(join(dir, "a.txt"), "1");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "first");
  git(dir, "branch", "feature");
  return dir;
}

describe("refusing a branch that is behind its base", () => {
  it("passes when the branch is level with its base", () => {
    const dir = repo();
    git(dir, "checkout", "--quiet", "feature");
    expect(run(dir, "--base", "main").code).toBe(0);
  });

  it("refuses when the base has moved ahead", () => {
    const dir = repo();
    writeFileSync(join(dir, "b.txt"), "2");
    git(dir, "add", "-A");
    git(dir, "commit", "--quiet", "-m", "base moved");
    git(dir, "checkout", "--quiet", "feature");

    const { code, out } = run(dir, "--base", "main");
    expect(code).toBe(1);
    expect(out).toMatch(/1 commit\(s\) behind main/);
  });

  it("names the commits it is missing, so the message is actionable", () => {
    const dir = repo();
    writeFileSync(join(dir, "b.txt"), "2");
    git(dir, "add", "-A");
    git(dir, "commit", "--quiet", "-m", "a distinctive subject line");
    git(dir, "checkout", "--quiet", "feature");

    expect(run(dir, "--base", "main").out).toMatch(/a distinctive subject line/);
  });

  it("passes when the branch is merely ahead", () => {
    const dir = repo();
    git(dir, "checkout", "--quiet", "feature");
    writeFileSync(join(dir, "c.txt"), "3");
    git(dir, "add", "-A");
    git(dir, "commit", "--quiet", "-m", "ahead only");

    expect(run(dir, "--base", "main").code).toBe(0);
  });

  it("fails CLOSED when the base ref is absent, rather than passing", () => {
    // The shallow-clone case. Exit 2, not 0: "I could not check" must never
    // resolve to "therefore allow" (br-dowt).
    const dir = repo();
    git(dir, "checkout", "--quiet", "feature");

    const { code, out } = run(dir, "--base", "origin/nonexistent");
    expect(code).toBe(2);
    expect(out).toMatch(/fetch-depth/);
  });

  it("refuses an empty --base rather than silently ignoring it", () => {
    const dir = repo();
    expect(run(dir, "--base").code).toBe(2);
  });
});
