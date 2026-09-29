import { existsSync, readFileSync } from "node:fs";
import { REFERENCE_PATH, renderReference } from "../scripts/generate-catalog-reference";

/**
 * The command/event reference is generated. This is the test that stops it
 * from becoming fiction.
 *
 * The failure it guards against is specific: someone adds a command, or flips
 * `requiresApproval`, and the table keeps describing the old boundary. A
 * reader then believes an approval gate exists where it does not. That is a
 * worse outcome than having no table, so drift fails the build.
 */
describe("the generated command/event reference matches the source catalog", () => {
  it("is present", () => {
    expect(existsSync(REFERENCE_PATH)).toBe(true);
  });

  it("is current — regenerate with scripts/generate-catalog-reference.ts", () => {
    const onDisk = readFileSync(REFERENCE_PATH, "utf8");
    expect(onDisk).toBe(renderReference());
  });

  it("documents every command in the catalog, not a curated subset", () => {
    const rendered = renderReference();
    for (const id of ["investigation.record", "fix.propose", "fix.verify", "fix.apply", "constitution.propose", "constitution.apply"]) {
      expect(rendered).toContain(`\`${id}\``);
    }
  });

  it("states the approval requirement for the command that writes the constitution", () => {
    const rendered = renderReference();
    const row = rendered.split("\n").find((l) => l.startsWith("| `constitution.apply` |"));
    expect(row).toBeDefined();
    expect(row).toContain("**required**");
  });
});
