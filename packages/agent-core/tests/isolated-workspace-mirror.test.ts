import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createIsolatedWorkspace, materialize } from "../src/cqrs/isolated-workspace";
import { createCommandCatalog } from "../src/cqrs/commands";
import { ProposalStore, currentHash } from "../src/cqrs/proposal-store";

/**
 * The isolated workspace mirrors the user's UNCOMMITTED work (OP-2; ported
 * from dev b59d2bf and b5d4ffb). Real git repositories and the real
 * createIsolatedWorkspace throughout: the failure being prevented only
 * exists where a real worktree is built from a real dirty tree.
 */

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function repo(files: Record<string, string>): string {
  const root = temp("mirror-repo-");
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("add", "-A");
  git("commit", "-qm", "initial");
  return root;
}

/** A tiny runner: every tests/*.test.js file is one test; prints a jest-shaped summary. */
const RUNNER = `const fs = require("fs");
let passed = 0, failed = 0;
for (const f of fs.readdirSync("tests").filter((f) => f.endsWith(".test.js"))) {
  try { require("./tests/" + f); passed++; } catch (e) { failed++; console.log("FAIL tests/" + f); }
}
console.log("Tests:       " + (failed ? failed + " failed, " : "") + passed + " passed, " + (passed + failed) + " total");
process.exit(failed ? 1 : 0);
`;

function isolate(root: string) {
  const result = createIsolatedWorkspace(root, "mirror-test");
  if (!result.ok) throw new Error(result.reason);
  return result.workspace;
}

describe("the isolated workspace is the user's working state, not HEAD (OP-2, b59d2bf)", () => {
  it("contains an uncommitted failing test, so fix.verify cannot pass a suite without it", async () => {
    const root = repo({
      "run.js": RUNNER,
      "src/math.js": "exports.add = (a, b) => a + b;\nexports.sub = (a, b) => a + b;\n",
      "tests/add.test.js": `if (require("../src/math").add(1, 2) !== 3) throw new Error("add");\n`,
    });
    // The user just wrote this test. It is untracked, and it fails.
    writeFileSync(join(root, "tests/sub.test.js"), `if (require("../src/math").sub(3, 1) !== 2) throw new Error("sub");\n`);

    const store = new ProposalStore(root);
    const catalog = createCommandCatalog({ workspaceRoot: root, store });
    const ctx = { log: () => undefined, signal: new AbortController().signal, behavior: "fix-failing-test", correlationId: "c" };
    const propose = catalog.find((c) => c.id === "fix.propose")!;
    const verify = catalog.find((c) => c.id === "fix.verify")!;

    // A candidate that does not touch the bug.
    const proposed = (await propose.handler(ctx as never, {
      issue: "node run.js",
      rationale: "unrelated",
      writes: [{ path: "src/other.js", contents: "exports.x = 1;\n" }],
    } as never)) as { proposalRef: string };
    const verified = (await verify.handler(ctx as never, {
      proposalRef: proposed.proposalRef,
      command: "node run.js",
    } as never)) as { result: { verdict: string; detail: string } };

    expect(verified.result.verdict).toBe("failed");
    expect(verified.result.detail).toContain("tests/sub.test.js");
  });

  it("carries tracked modifications, so verification sees what fix.propose hashed", () => {
    const root = repo({ "src/math.js": "exports.add = (a, b) => a - b;\n" });
    writeFileSync(join(root, "src/math.js"), "exports.add = (a, b) => a - b; // edited, not committed\n");

    const workspace = isolate(root);
    try {
      // fix.propose records currentHash(liveRoot, path) as baseSha256; the
      // workspace verification runs in holds the same bytes.
      expect(currentHash(workspace.root, "src/math.js")).toBe(currentHash(root, "src/math.js"));
      expect(readFileSync(join(workspace.root, "src/math.js"), "utf8")).toContain("edited, not committed");
    } finally {
      workspace.dispose();
    }
  });
});

describe("mirroring survives entries it cannot copy, and never leads out (b5d4ffb, br-boam)", () => {
  it("recreates an untracked symlinked directory instead of abandoning the workspace", () => {
    const root = repo({ "src/a.js": "a\n" });
    symlinkSync("src", join(root, "linked-src"));

    const workspace = isolate(root);
    try {
      expect(lstatSync(join(workspace.root, "linked-src")).isSymbolicLink()).toBe(true);
      expect(realpathSync(join(workspace.root, "linked-src"))).toBe(realpathSync(join(workspace.root, "src")));
    } finally {
      workspace.dispose();
    }
  });

  it("skips one uncopyable entry and still builds the workspace", () => {
    const root = repo({ "src/a.js": "a\n" });
    // Unreadable: git lists it, lstat sees a regular file, the copy fails.
    writeFileSync(join(root, "unreadable.txt"), "secret\n", { mode: 0o000 });
    writeFileSync(join(root, "new.test.js"), "new\n");

    const workspace = isolate(root);
    try {
      expect(existsSync(join(workspace.root, "new.test.js"))).toBe(true);
      expect(workspace.skipped?.some((s) => s.startsWith("unreadable.txt"))).toBe(true);
    } finally {
      workspace.dispose();
    }
  });

  it("does not recreate a symlink that leads outside the repository, so nothing written through it escapes", () => {
    const outside = temp("mirror-outside-");
    const root = repo({ "src/a.js": "a\n" });
    symlinkSync(outside, join(root, "escape"));

    const workspace = isolate(root);
    try {
      expect(existsSync(join(workspace.root, "escape"))).toBe(false);
      expect(workspace.skipped?.some((s) => s.startsWith("escape"))).toBe(true);
      // A candidate aimed through that path lands inside the workspace.
      expect(materialize(workspace, [{ path: "escape/pwned.txt", contents: "x" }]).ok).toBe(true);
      expect(existsSync(join(outside, "pwned.txt"))).toBe(false);
    } finally {
      workspace.dispose();
    }
  });
});
