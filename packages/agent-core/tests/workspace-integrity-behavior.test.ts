import { join } from "node:path";
import { discoverBehaviorPackages } from "../src/behavior/package-discovery";
import { compile } from "../src/behavior/compiler";
import { explainInertTrigger } from "../src/behavior/trigger-producers";
import { BUILTIN_COMMAND_CAPABILITIES } from "../src/cqrs/commands";
import { EVENT_DISPOSITIONS } from "../src/behavior/event-disposition";

/**
 * br-c4ni: the shipped `workspace-integrity` package must actually work.
 *
 * A behavior that parses but never fires is the failure mode this repo has hit
 * repeatedly — 44 of 54 catalog types had no producer, and authors wrote
 * against them in good faith. So these assertions cover reachability, not just
 * well-formedness.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..");

function pkg() {
  const found = discoverBehaviorPackages(REPO_ROOT, { searchRoots: ["packages", "."] });
  const match = found.find((p) => p.behaviorId === "workspace-integrity");
  if (!match) throw new Error("workspace-integrity behavior package was not discovered");
  return match;
}

describe("the workspace-integrity package is valid", () => {
  it("parses and validates", () => {
    expect(pkg().parseError).toBeUndefined();
    expect(pkg().validationErrors ?? []).toEqual([]);
  });

  it("compiles without errors", () => {
    const result = compile({ behaviors: [pkg().manifest!] }, {});

    expect(result.errors).toEqual([]);
    expect(result.compiled).toHaveLength(1);
  });
});

describe("it can actually fire and actually act", () => {
  it("triggers on an event something really emits", () => {
    // The whole point of br-jgxo. A behavior on an unproduced trigger is
    // inert no matter how correct the rest of it is.
    expect(explainInertTrigger("runtime.session.started")).toBeUndefined();
  });

  it("declares the command it calls, so the registry will authorize it", () => {
    const manifest = pkg().manifest!;

    expect(manifest.capabilities.commands).toContain("workspace.check");
    // Holding a tool grant never implies holding a command capability
    // (REQ-SAFE-003), so the declaration has to be explicit and the command
    // has to exist.
    expect(BUILTIN_COMMAND_CAPABILITIES["workspace.check"]).toBe("workspace.check");
  });

  it("emits an event the catalog now genuinely produces", () => {
    // `behavior.observation.recorded` was declared-but-unemitted until this
    // command gave it a producer.
    expect(EVENT_DISPOSITIONS["behavior.observation.recorded"]).toBe("keep");
  });
});

describe("it claims no power it does not need", () => {
  it("asks for no tools at all", () => {
    // The check reads the filesystem through the command, so the behavior
    // needs no grants — not even `read`.
    expect(pkg().manifest!.capabilities.tools).toEqual([]);
  });

  it("declares no mutation classes", () => {
    expect(pkg().manifest!.capabilities.mutation_classes).toEqual([]);
  });

  it("runs in propose mode, because the remedy is the developer's call", () => {
    // `auto` is not a future upgrade path here. A runtime that silently
    // rewrote a dependency tree would be worse than the problem it fixed.
    expect(pkg().manifest!.policy.mode).toBe("propose");
  });
});
