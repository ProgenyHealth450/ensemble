import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyClaims } from "../src/docs/claim-verification";

/**
 * br-gpha. These cases are the ACTUAL fabrications from this session, not
 * invented examples — the point is to prove the check catches the things that
 * really got written down and believed.
 */

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "claims-"));
  dirs.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { validate: "echo", test: "jest" } }));
  writeFileSync(join(root, "src", "real.ts"), "export function compile(pkg, options) {}\n");
  return root;
}

const verify = (root: string, claims: Parameters<typeof verifyClaims>[0]["claims"]) =>
  verifyClaims({ root, claims, sourceFiles: ["src/real.ts"] });

describe("a path that does not exist is caught", () => {
  it("catches the CLI that was documented but never existed", () => {
    // The real one: "npx ts-node packages/agent-core/scripts/validate-behaviors.ts",
    // hedged in prose with "if present in your checkout" — a hedge is not a check.
    const report = verify(repo(), [
      { kind: "path", value: "scripts/validate-behaviors.ts", source: "guide.md" },
    ]);

    expect(report.ok).toBe(false);
    expect(report.unresolved[0].detail).toMatch(/no such file/);
  });

  it("confirms a path that is really there", () => {
    expect(verify(repo(), [{ kind: "path", value: "src/real.ts" }]).ok).toBe(true);
  });

  it("refuses an absolute path instead of resolving it", () => {
    // Checking /etc/passwd would "hold" while telling the reader nothing
    // about this repository.
    const report = verify(repo(), [{ kind: "path", value: "/etc/passwd" }]);

    expect(report.ok).toBe(false);
    expect(report.unresolved[0].detail).toMatch(/not a repository-relative path/);
  });

  it("refuses a path that escapes the repository", () => {
    expect(verify(repo(), [{ kind: "path", value: "../elsewhere" }]).ok).toBe(false);
  });
});

describe("a command the reader is told to type", () => {
  it("catches a script that package.json does not declare", () => {
    const report = verify(repo(), [{ kind: "npm-script", value: "verify-behaviors" }]);

    expect(report.unresolved[0].detail).toMatch(/no script named/);
  });

  it("confirms one that exists", () => {
    expect(verify(repo(), [{ kind: "npm-script", value: "validate" }]).ok).toBe(true);
  });
});

describe("a symbol the documentation names", () => {
  it("confirms a real export", () => {
    expect(verify(repo(), [{ kind: "symbol", value: "compile" }]).ok).toBe(true);
  });

  it("catches a symbol nothing exports", () => {
    const report = verify(repo(), [{ kind: "symbol", value: "validateBehaviors" }]);

    expect(report.unresolved[0].detail).toMatch(/no export named/);
  });

  it("rejects anything that is not a plain identifier, rather than building a regex from it", () => {
    // A claim value goes into a RegExp; letting arbitrary text through would
    // make the checker's behavior depend on the text it was asked to check.
    expect(verify(repo(), [{ kind: "symbol", value: "compile(.*)" }]).ok).toBe(false);
  });
});

describe("an empty claim set is not a pass", () => {
  it("reports not-ok when there was nothing to check", () => {
    // "Nothing to check" and "everything checked out" are different facts.
    // Collapsing them is the vacuous-success pattern (br-cwrh, br-zctt), and
    // here it would let a doc with no extractable claims report as verified.
    const report = verify(repo(), []);

    expect(report.ok).toBe(false);
    expect(report.checked).toBe(0);
  });

  it("counts what it examined", () => {
    const report = verify(repo(), [
      { kind: "path", value: "src/real.ts" },
      { kind: "npm-script", value: "validate" },
    ]);

    expect(report.checked).toBe(2);
  });
});

describe("the report separates what failed from what was examined", () => {
  it("keeps every verdict, not just the failures", () => {
    const report = verify(repo(), [
      { kind: "path", value: "src/real.ts" },
      { kind: "path", value: "src/missing.ts" },
    ]);

    expect(report.verdicts).toHaveLength(2);
    expect(report.unresolved).toHaveLength(1);
    // The source travels with the verdict, so a report names the document.
    expect(report.unresolved[0].value).toBe("src/missing.ts");
  });
});
