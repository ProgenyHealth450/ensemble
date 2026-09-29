import { join } from "node:path";
import { discoverBehaviorPackages } from "../src/behavior/package-discovery";
import { compile } from "../src/behavior/compiler";
import { explainInertTrigger } from "../src/behavior/trigger-producers";
import { isLaunchInput } from "../src/behavior/event-disposition";
import { BUILTIN_COMMAND_CAPABILITIES } from "../src/cqrs/commands";
import { WorkflowDefinition, WorkflowStep } from "../src/workflow/schema";

/** br-zctt: the shipped pre-PR verification package. */

const REPO_ROOT = join(__dirname, "..", "..", "..");

function pkg() {
  const found = discoverBehaviorPackages(REPO_ROOT, { searchRoots: ["packages", "."] });
  const match = found.find((p) => p.behaviorId === "pre-pr-verification");
  if (!match) throw new Error("pre-pr-verification behavior package was not discovered");
  return match;
}

/**
 * `manifest.execution.workflow` is typed `unknown` on purpose — the workflow
 * validator owns its shape. The cast is justified rather than assumed: the
 * compile test above runs the real validator over this exact manifest, so by
 * the time these assertions read fields, the shape has been checked.
 */
const workflow = () => pkg().manifest!.execution.workflow as WorkflowDefinition;
const steps = (): readonly WorkflowStep[] => workflow().steps;
const step = (id: string) => steps().find((s) => s.id === id)!;

/**
 * Narrowed by kind rather than cast. A cast would let a step silently change
 * kind — say, a condition becoming an outcome — while these assertions kept
 * passing against fields that no longer mean what they did.
 */
function narrow<K extends WorkflowStep["kind"]>(id: string, kind: K): Extract<WorkflowStep, { kind: K }> {
  const found = step(id);
  if (!found) throw new Error(`no step "${id}"`);
  if (found.kind !== kind) throw new Error(`step "${id}" is a ${found.kind}, expected ${kind}`);
  return found as Extract<WorkflowStep, { kind: K }>;
}

describe("the package is valid and its commands exist", () => {
  it("compiles against the real command catalog", () => {
    // `knownCommands` is what makes this non-vacuous: without it the compiler
    // cannot check `capabilities.commands` at all, and a workflow calling a
    // command that does not exist would compile clean.
    const result = compile(
      { behaviors: [pkg().manifest!] },
      { knownCommands: Object.keys(BUILTIN_COMMAND_CAPABILITIES) },
    );

    expect(result.errors).toEqual([]);
    expect(result.compiled).toHaveLength(1);
  });

  it("declares the capability for the command it calls", () => {
    expect(pkg().manifest!.capabilities.commands).toContain("verification.run");
  });
});

describe("vacuity is checked before the verdict", () => {
  // The ordering IS the bead. A vacuous run reports `inconclusive`, so a naive
  // "is it passed?" branch routes it to the failure arm and describes
  // "nothing ran" as "tests failed" — sending the reader to debug code that
  // was never executed.
  it("branches on vacuity first", () => {
    // There is no `next:` field in this schema — a non-condition step falls
    // through to the step DECLARED AFTER IT, and only a condition redirects.
    // So declaration order is the wiring, and asserting it is the only way to
    // catch a reorder that silently changes the flow.
    const order = steps().map((s) => s.id);
    expect(order.indexOf("check-tests")).toBe(order.indexOf("tests") + 1);
    expect(narrow("check-tests", "condition").left).toBe("${steps.tests.result.vacuous}");
  });

  it("falls through from each command to its own check, in order", () => {
    const order = steps().map((s) => s.id);
    for (const [command, check] of [
      ["tests", "check-tests"],
      ["typecheck", "check-typecheck"],
      ["lint", "check-lint"],
    ]) {
      expect(order.indexOf(check)).toBe(order.indexOf(command) + 1);
    }
  });

  it("declares every terminal outcome after the last condition", () => {
    // A terminal outcome placed mid-list would become the fall-through target
    // of whatever precedes it, ending the run early and silently.
    const order = steps().map((s) => s.id);
    const lastCondition = Math.max(...steps().filter((s) => s.kind === "condition").map((s) => order.indexOf(s.id)));
    for (const outcome of steps().filter((s) => s.kind === "outcome")) {
      expect(order.indexOf(outcome.id)).toBeGreaterThan(lastCondition);
    }
  });

  it("only reaches the verdict branch when the run was not vacuous", () => {
    expect(narrow("check-tests", "condition").otherwise).toBe("check-tests-verdict");
  });

  it("reports a vacuous run as inconclusive, never as succeeded", () => {
    const outcome = narrow("vacuous", "outcome");

    expect(outcome.status).toBe("inconclusive");
    // Calling it a pass is the failure this behavior exists to prevent.
    expect(outcome.status).not.toBe("succeeded");
  });

  it("distinguishes a vacuous run from a genuine failure", () => {
    expect(narrow("tests-failed", "outcome").status).toBe("failed");
    expect(narrow("vacuous", "outcome").status).toBe("inconclusive");
  });
});

describe("it is honest about being an observer, not a gate", () => {
  it("triggers on a launch-input type, which is reachable but not blocking", () => {
    // Foreman starts a session with this fact; the behavior runs ALONGSIDE the
    // PR, never in front of it.
    expect(isLaunchInput("pull_request.proposed")).toBe(true);
    // And therefore must not be warned about as inert (br-d7lm).
    expect(explainInertTrigger("pull_request.proposed")).toBeUndefined();
  });

  it("runs in propose mode and claims no mutation", () => {
    expect(pkg().manifest!.policy.mode).toBe("propose");
    expect(pkg().manifest!.capabilities.mutation_classes).toEqual([]);
    expect(pkg().manifest!.capabilities.tools).toEqual([]);
  });
});

describe("it checks everything it claims to check", () => {
  it("runs tests, typecheck and lint as separate commands", () => {
    const commands = steps()
      .filter((s): s is Extract<WorkflowStep, { kind: "command" }> => s.kind === "command")
      .map((s) => s.args.command);

    // Separate rather than `a && b && c`, which reports only the first
    // failure; this is meant to tell you everything wrong in one pass.
    expect(commands).toEqual(["npm test", "npm run typecheck", "npm run lint"]);
  });

  it("has a terminal outcome for every failure mode", () => {
    for (const id of ["clean", "vacuous", "tests-failed", "typecheck-failed", "lint-failed"]) {
      expect(narrow(id, "outcome").kind).toBe("outcome");
    }
  });
});
