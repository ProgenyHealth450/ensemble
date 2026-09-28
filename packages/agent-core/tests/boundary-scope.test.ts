import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriteBoundaryMonitor } from "../src/behavior/write-boundary-monitor";
import { isAlwaysProtectedPath } from "../src/behavior/protected-paths";

const GUARD = "docs/standards/constitution.md";
const TEST_FILE = "tests/math.test.js";
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "boundary-scope-"));
  dirs.push(root);
  mkdirSync(join(root, "docs", "standards"), { recursive: true });
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, GUARD), "# rules\n");
  writeFileSync(join(root, TEST_FILE), "test('a', () => {});\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: root });
  return root;
}

const tracked = (root: string): string[] =>
  execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);

/**
 * Widening the boundary must not bless what happened while it was narrow.
 *
 * Replacing the monitor at window-open re-baselines every guardrail to its
 * CURRENT contents, so a tamper made while narrow becomes the new pristine
 * state: laundering performed by the boundary itself. Found by probe, not by
 * a failing test.
 *
 * Asserted here rather than end-to-end because the extension checks on every
 * tool call, and a window only ever opens in response to one -- so the
 * intervening check hides the difference. That ordering is a second line of
 * defence, not the guarantee; this is the guarantee.
 */
describe("widening the write boundary preserves what it already protected", () => {
  it("still reverts a guardrail tampered with while the boundary was narrow", () => {
    const root = repo();
    const monitor = new WriteBoundaryMonitor(root, isAlwaysProtectedPath);
    monitor.protectAll(tracked(root));

    writeFileSync(join(root, GUARD), "# rules\n- smuggled\n");

    monitor.setScope(() => true);
    monitor.protectAll(tracked(root));
    monitor.check();

    expect(readFileSync(join(root, GUARD), "utf8")).toBe("# rules\n");
  });

  it("leaves a test file edited while narrow alone, and protects it once widened", () => {
    const root = repo();
    const monitor = new WriteBoundaryMonitor(root, isAlwaysProtectedPath);
    monitor.protectAll(tracked(root));

    // The user's own edit, outside any window: theirs to make.
    writeFileSync(join(root, TEST_FILE), "test('mine', () => {});\n");
    monitor.check();
    expect(readFileSync(join(root, TEST_FILE), "utf8")).toBe("test('mine', () => {});\n");

    // Widening baselines it AS EDITED -- the user's state is what the fix
    // turn must not change, not some earlier state they already moved on from.
    monitor.setScope(() => true);
    monitor.protectAll(tracked(root));
    writeFileSync(join(root, TEST_FILE), "test('machine rewrote this', () => {});\n");
    monitor.check();
    expect(readFileSync(join(root, TEST_FILE), "utf8")).toBe("test('mine', () => {});\n");
  });

  it("re-baselines a test file at the SECOND window, not at the first", () => {
    const root = repo();
    const monitor = new WriteBoundaryMonitor(root);
    monitor.protectAll(tracked(root));

    // First window closes; the user then edits their own test file.
    monitor.setScope(isAlwaysProtectedPath);
    writeFileSync(join(root, TEST_FILE), "test('mine, between windows', () => {});\n");
    monitor.check();
    expect(readFileSync(join(root, TEST_FILE), "utf8")).toBe("test('mine, between windows', () => {});\n");

    // A second window opens. Keeping the FIRST window's snapshot would
    // revert the user's later edit to a state they abandoned -- destroying
    // work in the name of protecting it. The baseline must be their edit.
    monitor.setScope(() => true);
    monitor.protectAll(tracked(root));
    monitor.check();

    expect(readFileSync(join(root, TEST_FILE), "utf8")).toBe("test('mine, between windows', () => {});\n");
  });
});
