import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWorkspaceIntegrity, findDanglingLinks, findLockfileDrift } from "../src/workspace/integrity";

/**
 * br-c4ni. These tests reconstruct the actual incident rather than a tidy
 * analogue, because the tidy analogue is the one that already gets caught.
 *
 * What happened: the ROOT link to @sunstone-partners/ensemble-agent-core
 * pointed at a deleted throwaway worktree, while a NESTED link under
 * packages/pi-extension/node_modules resolved correctly and shadowed it. Every
 * local signal said the workspace was healthy. It was not.
 */

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "integrity-"));
  dirs.push(root);
  mkdirSync(join(root, "node_modules", "@scope"), { recursive: true });
  mkdirSync(join(root, "packages", "consumer", "node_modules", "@scope"), { recursive: true });
  mkdirSync(join(root, "packages", "real"), { recursive: true });
  return root;
}

describe("a dangling workspace link is found", () => {
  it("reports a link whose target no longer exists", () => {
    const root = workspace();
    symlinkSync(join(root, "packages", "deleted"), join(root, "node_modules", "@scope", "lib"));

    const { findings } = findDanglingLinks(root);

    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("dangling-symlink");
  });

  it("says nothing about a link that resolves", () => {
    const root = workspace();
    symlinkSync(join(root, "packages", "real"), join(root, "node_modules", "@scope", "lib"));

    expect(findDanglingLinks(root).findings).toEqual([]);
  });

  it("counts what it examined, so a clean report is not confused with a skipped one", () => {
    const root = workspace();
    symlinkSync(join(root, "packages", "real"), join(root, "node_modules", "@scope", "lib"));

    // "0 findings" from a check that never ran is the most reassuring
    // possible lie, so the count is part of the result.
    expect(checkWorkspaceIntegrity(root).checked.linkCount).toBe(1);
  });
});

describe("the shadowed case, which is the one that actually bit", () => {
  it("reports a broken root link even though a nested link hides it", () => {
    const root = workspace();
    // Root link: broken, exactly as the deleted /tmp worktree was.
    symlinkSync(join(root, "packages", "deleted"), join(root, "node_modules", "@scope", "lib"));
    // Nested link: resolves, so every local signal reads "fine".
    symlinkSync(
      join(root, "packages", "real"),
      join(root, "packages", "consumer", "node_modules", "@scope", "lib"),
    );

    const { findings } = findDanglingLinks(root);

    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("shadowed-dangling-symlink");
  });

  it("explains why a shadowed break is worse, not merely different", () => {
    const root = workspace();
    symlinkSync(join(root, "packages", "deleted"), join(root, "node_modules", "@scope", "lib"));
    symlinkSync(
      join(root, "packages", "real"),
      join(root, "packages", "consumer", "node_modules", "@scope", "lib"),
    );

    const { findings } = findDanglingLinks(root);

    expect(findings[0].detail).toMatch(/tests can pass/);
    expect(findings[0].detail).toMatch(/broken for anyone else/);
  });
});

describe("lockfile drift", () => {
  const withManifests = (pkg: unknown, lock: unknown): string => {
    const root = workspace();
    writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify(lock));
    return root;
  };

  it("reports a dependency the lockfile does not record", () => {
    const root = withManifests(
      { dependencies: { left: "^1.0.0" } },
      { packages: { "": { dependencies: {} } } },
    );

    const { findings } = findLockfileDrift(root);

    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toMatch(/not in the lockfile/);
  });

  it("reports a range that disagrees", () => {
    const root = withManifests(
      { dependencies: { left: "^2.0.0" } },
      { packages: { "": { dependencies: { left: "^1.0.0" } } } },
    );

    expect(findLockfileDrift(root).findings[0].detail).toMatch(/\^2\.0\.0.*\^1\.0\.0/);
  });

  it("stays silent when they agree", () => {
    const root = withManifests(
      { dependencies: { left: "^1.0.0" }, devDependencies: { right: "~3.0.0" } },
      { packages: { "": { dependencies: { left: "^1.0.0" }, devDependencies: { right: "~3.0.0" } } } },
    );

    expect(findLockfileDrift(root).findings).toEqual([]);
  });

  it("reports that it did not check, rather than passing, when files are absent", () => {
    // Silence from an absent check must not read as a clean bill of health.
    expect(findLockfileDrift(workspace()).checked).toBe(false);
  });
});

describe("the whole check", () => {
  it("is ok on a healthy workspace", () => {
    const root = workspace();
    symlinkSync(join(root, "packages", "real"), join(root, "node_modules", "@scope", "lib"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: {} }));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: { "": {} } }));

    expect(checkWorkspaceIntegrity(root).ok).toBe(true);
  });

  it("is not ok when anything is wrong, and says what", () => {
    const root = workspace();
    symlinkSync(join(root, "packages", "deleted"), join(root, "node_modules", "@scope", "lib"));

    const report = checkWorkspaceIntegrity(root);

    expect(report.ok).toBe(false);
    expect(report.findings[0].path).toMatch(/node_modules/);
  });

  it("never repairs anything it finds", () => {
    // A runtime that silently rewrote a dependency tree would be a far worse
    // problem than the one it fixed. The link must still be there afterwards.
    const root = workspace();
    const link = join(root, "node_modules", "@scope", "lib");
    symlinkSync(join(root, "packages", "deleted"), link);

    checkWorkspaceIntegrity(root);

    expect(findDanglingLinks(root).findings).toHaveLength(1);
  });
});
