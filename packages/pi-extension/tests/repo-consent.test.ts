import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRepoConsent } from "../src/repo-consent";
import { activateBehaviorPipeline } from "../src/behavior-activation";
import { fakePi } from "./support/harness";

/**
 * br-fvmq: arming was a side effect of dependency layout, not consent.
 *
 * The extension activates in every omp session on the machine. Before this,
 * *arming* — discovering behaviors and wiring a matcher — happened because a
 * repo contained a `behaviors/` directory, or because something it depended on
 * shipped one. No one chose it. Install is consent for HAVING the runtime, not
 * for a given repository to be acted on.
 */

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const BEHAVIOR = `api_version: ensemble.sunstone.dev/v1
kind: Behavior
metadata:
  name: investigate-test-failure
  version: 1.0.0
trigger:
  event_type: test.failure.observed
policy:
  mode: propose
  timeout: 30m
capabilities:
  tools:
    - read
  mutation_classes: []
execution:
  graph: investigate-test-failure
outcomes:
  - test.failure.investigated
`;

/** A repo that ships a behavior, exactly as a dependency's payload would. */
function repo(consent?: string): string {
  const root = mkdtempSync(join(tmpdir(), "consent-"));
  dirs.push(root);
  const dir = join(root, "packages", "agent-core", "behaviors", "investigate-test-failure");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "behavior.yaml"), BEHAVIOR);
  if (consent !== undefined) {
    mkdirSync(join(root, ".ensemble"), { recursive: true });
    writeFileSync(join(root, ".ensemble", "config.yaml"), consent);
  }
  return root;
}

const activate = (root: string) => activateBehaviorPipeline(fakePi().pi, root);

describe("a repository is not armed without an explicit act", () => {
  it("refuses to arm a repo that merely contains behaviors", () => {
    const result = activate(repo());

    expect(result.consent?.armed).toBe(false);
    expect(result.loaded).toHaveLength(0);
  });

  it("does not even discover, so arming cannot be a side effect of layout", () => {
    // Consent is checked BEFORE discovery. If it were checked after, the
    // decision would still depend on what the dependency tree contained.
    expect(activate(repo()).discovered).toBe(0);
  });

  it("still returns a matcher, so an unarmed repo is inert and not broken", () => {
    const result = activate(repo());

    expect(result.matcher).toBeDefined();
    expect(result.skipped).toHaveLength(0);
  });

  it("arms when the repo says so", () => {
    const result = activate(repo("behaviors:\n  armed: true\n"));

    expect(result.consent?.armed).toBe(true);
    expect(result.loaded).toHaveLength(1);
  });
});

describe("presence of the file is not consent", () => {
  // `.ensemble/` already holds behavior packages, so a repo can have that
  // directory without anyone deciding anything. Treating presence as consent
  // would re-create the accident this bead is about.
  it.each([
    ["an empty file", ""],
    ["no behaviors section", "something_else: true\n"],
    ["a behaviors section without the key", "behaviors:\n  other: true\n"],
  ])("refuses %s", (_label, body) => {
    expect(readRepoConsent(repo(body)).armed).toBe(false);
  });

  it("refuses a value that is not literally true", () => {
    // "true" the string, from a hand-edited file, is not the boolean.
    expect(readRepoConsent(repo('behaviors:\n  armed: "yes"\n')).armed).toBe(false);
  });
});

describe("the refusal explains itself", () => {
  it("tells the user how to arm, since a silent no-op is indistinguishable from a bug", () => {
    const reason = readRepoConsent(repo()).reason;

    expect(reason).toMatch(/\.ensemble.config\.yaml is absent/);
    expect(reason).toMatch(/armed: true/);
  });

  it("does not lecture a repo that deliberately opted out", () => {
    // An explicit `false` is a decision, not an omission. Telling someone to
    // add a marker they already set is noise, and noise is how a consent
    // channel loses its meaning.
    const consent = readRepoConsent(repo("behaviors:\n  armed: false\n"));

    expect(consent.armed).toBe(false);
    expect(consent.reason).toMatch(/disarmed/);
    expect(consent.reason).not.toMatch(/armed: true/);
  });

  it("reports malformed yaml as unreadable rather than as absent", () => {
    const consent = readRepoConsent(repo("behaviors:\n  armed: [unclosed\n"));

    expect(consent.armed).toBe(false);
    expect(consent.reason).toMatch(/could not be parsed/);
  });
});
