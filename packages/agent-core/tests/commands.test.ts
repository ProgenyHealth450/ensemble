import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BehaviorAuthority,
  BehaviorManifest,
  CommandRegistry,
  CommandResult,
  ProposalStore,
  compile,
  createCommandCatalog,
  createMutationGuard,
  resolveConstitutionPath,
} from "../src";

/**
 * Story 3.2 (`br-behavior-runtime-cqrs-xl24.14`): proposal, verification,
 * approval and application are four separate facts.
 *
 * Each case below traces to something that actually happened:
 *
 *   a verified fix was LEFT APPLIED under `mode: propose`, because the only
 *   code path that could produce a fix also wrote it, and a missing baseline
 *   was treated as permission (br-dowt);
 *
 *   verification accepted `2 passed, 2 total` from a runner that had counted a
 *   suite which never loaded, while the same run's constitution amendment
 *   described that exact defect (br-gwww);
 *
 *   the applier wrote into whichever worktree ran the failing command, which
 *   may not be where the canonical project lives (br-nft8).
 *
 * Everything is driven through `registry.execute`, never by calling a handler
 * directly, because the registry is where the authorization lives and a test
 * that bypasses it proves nothing about production.
 */

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function workspace(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "cmd-cat-"));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const abs = join(root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  return root;
}

function manifest(overrides: {
  mode?: "propose" | "auto" | "shadow";
  commands?: string[];
  mutationClasses?: string[];
}): BehaviorManifest {
  return {
    api_version: "ensemble.sunstone.dev/v1",
    kind: "Behavior",
    metadata: { name: "fixer", version: "1.0.0" },
    trigger: { event_type: "test.failure.observed" },
    policy: { mode: overrides.mode ?? "propose", timeout: "10m" },
    capabilities: {
      tools: ["read"],
      mutation_classes: overrides.mutationClasses ?? [],
      commands: overrides.commands ?? ["fix.propose", "fix.verify", "fix.apply", "constitution.propose"],
    },
    execution: { graph: "g", test_command: "npm test" },
    outcomes: ["fix.proposed"],
  } as BehaviorManifest;
}

function authorityFor(m: BehaviorManifest): BehaviorAuthority {
  const compiled = compile({ behaviors: [m] }).compiled[0];
  return {
    name: compiled.manifest.metadata.name,
    digest: compiled.digest,
    commands: compiled.commands,
    guard: createMutationGuard(compiled),
  };
}

interface Harness {
  readonly registry: CommandRegistry;
  readonly store: ProposalStore;
  readonly root: string;
  readonly approvals: string[];
  readonly verifyRuns: string[];
  run(command: string, args: Record<string, unknown>): Promise<CommandResult>;
}

function harness(options: {
  root: string;
  manifest: BehaviorManifest;
  approve?: boolean | null;
  output?: { stdout: string; exitCode: number };
  isolationFails?: boolean;
}): Harness {
  const store = new ProposalStore(options.root);
  const approvals: string[] = [];
  const verifyRuns: string[] = [];
  const isolated = mkdtempSync(join(tmpdir(), "cmd-iso-"));
  roots.push(isolated);

  const catalog = createCommandCatalog({
    workspaceRoot: options.root,
    store,
    runCommand: (command) => {
      verifyRuns.push(command);
      return {
        stdout: options.output?.stdout ?? "Tests:       2 passed, 0 failed, 2 total\n",
        stderr: "",
        exitCode: options.output?.exitCode ?? 0,
        timedOut: false,
      };
    },
    isolate: () =>
      options.isolationFails
        ? { ok: false, reason: "not a git repository with a commit" }
        : { ok: true, workspace: { root: isolated, dispose: () => undefined } },
  });

  const registry = new CommandRegistry({
    workspaceRoot: options.root,
    sessionId: "s",
    executionId: "e",
    approval:
      options.approve === null
        ? undefined
        : {
            async request(input) {
              approvals.push(input.title);
              return options.approve
                ? { approved: true, reason: "approved by user" }
                : { approved: false, reason: "declined by user" };
            },
          },
  });
  for (const descriptor of catalog) registry.register(descriptor);

  const authority = authorityFor(options.manifest);
  return {
    registry,
    store,
    root: options.root,
    approvals,
    verifyRuns,
    run: (command, args) => registry.execute({ request: { command, args, via: "workflow-step" }, authority }),
  };
}

const CANDIDATE = { path: "src/math.js", contents: "exports.add = (a, b) => a + b;\n" };
const ORIGINAL = "exports.add = (a, b) => a - b;\n";

describe("propose mode produces a proposal and changes nothing", () => {
  it("accepts fix.propose, writes no project file, and refuses fix.apply at the boundary", async () => {
    const root = workspace({ "src/math.js": ORIGINAL });
    const h = harness({ root, manifest: manifest({ mode: "propose" }), approve: true });

    const proposed = await h.run("fix.propose", {
      issue: "npm test",
      rationale: "operator is wrong",
      writes: [CANDIDATE],
    });

    // `accepted`, never `completed`: a proposal exists, the fix does not.
    expect(proposed.status).toBe("accepted");
    expect(readFileSync(join(root, "src/math.js"), "utf8")).toBe(ORIGINAL);

    const ref = (proposed as { proposalRef: string }).proposalRef;
    const applied = await h.run("fix.apply", { proposalRef: ref });

    // Refused by the registry BEFORE the handler runs, so "propose cannot
    // mutate" is a property of the boundary rather than of a handler
    // remembering to check. No approval was even requested.
    expect(applied.status).toBe("unauthorized");
    // This manifest declares no mutation class at all, so the guard stops it
    // one step earlier than the mode check. Both refusals are wanted; the
    // next case isolates the mode one.
    expect((applied as { reason: string }).reason).toMatch(/is not granted to behavior/);
    expect(h.approvals).toEqual([]);
    expect(readFileSync(join(root, "src/math.js"), "utf8")).toBe(ORIGINAL);
  });

  it("refuses fix.apply on mode alone, even with the mutation class granted", async () => {
    // The isolated regression for br-dowt: every other authority is present
    // and `propose` is still the thing that says no.
    const root = workspace({ "src/math.js": ORIGINAL });
    const h = harness({
      root,
      manifest: manifest({ mode: "propose", mutationClasses: ["artifact.write"] }),
      approve: true,
    });

    const proposed = await h.run("fix.propose", { issue: "npm test", rationale: "r", writes: [CANDIDATE] });
    const ref = (proposed as { proposalRef: string }).proposalRef;
    await h.run("fix.verify", { proposalRef: ref, command: "npm test" });

    const applied = await h.run("fix.apply", { proposalRef: ref });

    expect(applied.status).toBe("unauthorized");
    expect((applied as { reason: string }).reason).toMatch(/mode: propose/);
    expect(h.approvals).toEqual([]);
    expect(readFileSync(join(root, "src/math.js"), "utf8")).toBe(ORIGINAL);
  });

  it("rejects a candidate targeting a protected path at proposal time", async () => {
    const root = workspace({});
    const h = harness({ root, manifest: manifest({}), approve: true });

    const result = await h.run("fix.propose", {
      issue: "npm test",
      rationale: "r",
      writes: [{ path: "tests/math.test.ts", contents: "weakened\n" }],
    });

    // A proposal that could never legally be applied is not an option, and
    // putting it in front of a human as though it were is the failure.
    expect(result.status).toBe("rejected");
    expect((result as { reason: string }).reason).toMatch(/test-file/);
    expect(h.store.list()).toEqual([]);
  });

  it("rejects absolute paths and traversal", async () => {
    const root = workspace({});
    const h = harness({ root, manifest: manifest({}), approve: true });

    for (const path of ["/etc/passwd", "../../outside.ts"]) {
      const result = await h.run("fix.propose", {
        issue: "npm test",
        rationale: "r",
        writes: [{ path, contents: "x" }],
      });
      expect(result.status).toBe("rejected");
      expect((result as { reason: string }).reason).toMatch(/escapes the workspace/);
    }
  });
});

describe("verification is a separate act with its own verdict", () => {
  it("completes with an inconclusive verdict rather than failing the command", async () => {
    const root = workspace({ "src/math.js": ORIGINAL });
    // Zero tests. The command ran to a conclusion; the conclusion is that
    // nothing was proven.
    const h = harness({ root, manifest: manifest({}), approve: true, output: { stdout: "Tests: 0 total\n", exitCode: 0 } });

    const proposed = await h.run("fix.propose", { issue: "npm test", rationale: "r", writes: [CANDIDATE] });
    const ref = (proposed as { proposalRef: string }).proposalRef;

    const verified = await h.run("fix.verify", { proposalRef: ref, command: "npm test" });

    expect(verified.status).toBe("completed");
    expect((verified as { result: { verdict: string } }).result.verdict).toBe("inconclusive");
    expect(h.store.read(ref)?.verifications[0].verdict).toBe("inconclusive");
  });

  it("reports inconclusive and never runs the suite when isolation is unavailable", async () => {
    const root = workspace({ "src/math.js": ORIGINAL });
    const h = harness({ root, manifest: manifest({}), approve: true, isolationFails: true });

    const proposed = await h.run("fix.propose", { issue: "npm test", rationale: "r", writes: [CANDIDATE] });
    const ref = (proposed as { proposalRef: string }).proposalRef;
    const verified = await h.run("fix.verify", { proposalRef: ref, command: "npm test" });

    // Falling back to the live tree would make verification a mutation, which
    // is precisely what the separation exists to avoid.
    expect((verified as { result: { verdict: string } }).result.verdict).toBe("inconclusive");
    expect(h.verifyRuns).toEqual([]);
    expect(readFileSync(join(root, "src/math.js"), "utf8")).toBe(ORIGINAL);
  });

  it("runs the candidate in the isolated workspace, not the project", async () => {
    const root = workspace({ "src/math.js": ORIGINAL });
    const h = harness({ root, manifest: manifest({}), approve: true });

    const proposed = await h.run("fix.propose", { issue: "npm test", rationale: "r", writes: [CANDIDATE] });
    await h.run("fix.verify", { proposalRef: (proposed as { proposalRef: string }).proposalRef, command: "npm test" });

    expect(h.verifyRuns).toEqual(["npm test"]);
    expect(readFileSync(join(root, "src/math.js"), "utf8")).toBe(ORIGINAL);
  });
});
describe("the diagnosis travels with the verdict", () => {
  /**
   * `br-zcxb`: the rule provider was asked to judge a constitution change
   * with no diagnosis in hand.
   *
   * `constitution-learning` triggers on `fix.verified`, which carried a
   * proposal reference, a verdict, a detail line and a command. That is the
   * fact that something was fixed and no account of WHY it broke — and the
   * cause is the only part a rule can be drawn from. The behavior had to
   * either guess, or reconstruct the investigation it could not see.
   *
   * A rule drawn from a guess is worse than no rule: a real verified fix sits
   * behind it, so it reads as evidence-backed and is harder to challenge than
   * it deserves.
   */
  const DIAGNOSIS = "the suite counted a file that never loaded, so zero tests read as a pass";

  async function verified(evidence: string[] = ["tests/a.test.ts:1"]) {
    const root = workspace({ "src/math.js": ORIGINAL });
    const h = harness({ root, manifest: manifest({}), approve: true });
    const proposed = await h.run("fix.propose", {
      issue: "npm test",
      rationale: DIAGNOSIS,
      writes: [CANDIDATE],
      evidence,
    });
    const ref = (proposed as { proposalRef: string }).proposalRef;
    const result = await h.run("fix.verify", { proposalRef: ref, command: "npm test" });
    return (result as { result: { events: Record<string, Record<string, unknown>> } }).result.events["fix.verified"];
  }

  it("carries the investigation's diagnosis on fix.verified", async () => {
    expect((await verified()).rationale).toBe(DIAGNOSIS);
  });

  it("carries the evidence that supported it, not just the prose", async () => {
    expect((await verified(["tests/a.test.ts:1", "src/math.js:3"])).evidence).toEqual([
      "tests/a.test.ts:1",
      "src/math.js:3",
    ]);
  });

  it("still carries the verdict, so the diagnosis did not displace it", async () => {
    const event = await verified();
    expect(event.verdict).toBe("passed");
    expect(event.proposalRef).toBeTruthy();
  });

  it("publishes cleanly when there is no evidence to carry", async () => {
    // The fields are optional on purpose: a proposal may legitimately carry
    // neither, and that must read as "none was recorded" rather than making
    // the event unpublishable.
    const event = await verified([]);
    expect(event.evidence).toEqual([]);
    expect(event.rationale).toBe(DIAGNOSIS);
  });
});

describe("application requires authority, approval, evidence and a current tree", () => {
  const applying = manifest({
    mode: "auto",
    mutationClasses: ["artifact.write"],
    commands: ["fix.propose", "fix.verify", "fix.apply"],
  });

  async function proposeAndVerify(h: Harness): Promise<string> {
    const proposed = await h.run("fix.propose", { issue: "npm test", rationale: "r", writes: [CANDIDATE] });
    const ref = (proposed as { proposalRef: string }).proposalRef;
    await h.run("fix.verify", { proposalRef: ref, command: "npm test" });
    return ref;
  }

  it("applies a verified, approved, current proposal exactly once", async () => {
    const root = workspace({ "src/math.js": ORIGINAL });
    const h = harness({ root, manifest: applying, approve: true });

    const ref = await proposeAndVerify(h);
    const applied = await h.run("fix.apply", { proposalRef: ref });

    expect(applied.status).toBe("completed");
    expect(h.approvals).toEqual(["Run fix.apply?"]);
    expect(readFileSync(join(root, "src/math.js"), "utf8")).toBe(CANDIDATE.contents);
    expect(h.store.read(ref)?.appliedAt).toBeDefined();

    // Applying is not idempotent by accident; a second attempt is refused
    // explicitly rather than quietly rewriting the file.
    const again = await h.run("fix.apply", { proposalRef: ref });
    expect(again.status).toBe("rejected");
    expect((again as { reason: string }).reason).toMatch(/already applied/);
  });

  it("refuses to apply a proposal with no passing verification", async () => {
    const root = workspace({ "src/math.js": ORIGINAL });
    const h = harness({ root, manifest: applying, approve: true });

    const proposed = await h.run("fix.propose", { issue: "npm test", rationale: "r", writes: [CANDIDATE] });
    const ref = (proposed as { proposalRef: string }).proposalRef;

    const applied = await h.run("fix.apply", { proposalRef: ref });
    expect(applied.status).toBe("rejected");
    expect((applied as { reason: string }).reason).toMatch(/has not been verified/);
    expect(readFileSync(join(root, "src/math.js"), "utf8")).toBe(ORIGINAL);
  });

  it("refuses to apply when the latest verdict is inconclusive", async () => {
    const root = workspace({ "src/math.js": ORIGINAL });
    const h = harness({
      root,
      manifest: applying,
      approve: true,
      // A runner reporting a pass while a suite could not load. br-gwww.
      output: {
        stdout: "Test suite failed to run\nCannot find module '../src/rounding'\nTests: 2 passed, 0 failed, 2 total\n",
        exitCode: 0,
      },
    });

    const ref = await proposeAndVerify(h);
    const applied = await h.run("fix.apply", { proposalRef: ref });

    expect(applied.status).toBe("rejected");
    expect((applied as { reason: string }).reason).toMatch(/inconclusive/);
    expect(readFileSync(join(root, "src/math.js"), "utf8")).toBe(ORIGINAL);
  });

  it("refuses a stale proposal and preserves the concurrent edit", async () => {
    const root = workspace({ "src/math.js": ORIGINAL });
    const h = harness({ root, manifest: applying, approve: true });

    const ref = await proposeAndVerify(h);

    // The user edits the same file between proposal and application. Their
    // edit wins; the proposal was computed against content that no longer
    // exists.
    const concurrent = "exports.add = (a, b) => a + b; // hand-fixed\n";
    writeFileSync(join(root, "src/math.js"), concurrent);

    const applied = await h.run("fix.apply", { proposalRef: ref });
    expect(applied.status).toBe("rejected");
    expect((applied as { reason: string }).reason).toMatch(/stale/);
    expect(readFileSync(join(root, "src/math.js"), "utf8")).toBe(concurrent);
  });

  it("fails closed when no approval channel is configured", async () => {
    const root = workspace({ "src/math.js": ORIGINAL });
    const h = harness({ root, manifest: applying, approve: null });

    const ref = await proposeAndVerify(h);
    const applied = await h.run("fix.apply", { proposalRef: ref });

    // Absence of a way to ask is a denial, never an implicit yes.
    expect(applied.status).toBe("unauthorized");
    expect((applied as { reason: string }).reason).toMatch(/failing closed/);
    expect(readFileSync(join(root, "src/math.js"), "utf8")).toBe(ORIGINAL);
  });

  it("does not apply when the human declines", async () => {
    const root = workspace({ "src/math.js": ORIGINAL });
    const h = harness({ root, manifest: applying, approve: false });

    const ref = await proposeAndVerify(h);
    const applied = await h.run("fix.apply", { proposalRef: ref });

    expect(applied.status).toBe("awaiting_approval");
    expect((applied as { reason: string }).reason).toMatch(/declined by user/);
    expect(readFileSync(join(root, "src/math.js"), "utf8")).toBe(ORIGINAL);
  });

  it("denies fix.apply to a behavior that does not declare the command", async () => {
    const root = workspace({ "src/math.js": ORIGINAL });
    const permissive = manifest({
      mode: "auto",
      mutationClasses: ["artifact.write"],
      commands: ["fix.propose", "fix.verify"],
    });
    const h = harness({ root, manifest: permissive, approve: true });

    const ref = await proposeAndVerify(h);
    const applied = await h.run("fix.apply", { proposalRef: ref });

    // Holding `artifact.write` is not holding `fix.apply`. The three
    // authority axes stay independent (REQ-SAFE-003).
    expect(applied.status).toBe("unauthorized");
    expect((applied as { reason: string }).reason).toMatch(/capabilities\.commands/);
  });
});

describe("the constitution is a proposal, and its home is decided, not guessed", () => {
  it("requires cited source evidence for an amendment", async () => {
    const root = workspace({ "docs/standards/constitution.md": "# C\n" });
    const h = harness({ root, manifest: manifest({}), approve: true });

    const result = await h.run("constitution.propose", {
      rule: "r",
      rationale: "why",
      diff: "+ rule",
      sourceEvidence: [],
    });

    // Schema-enforced, so "a test passed, therefore a rule" is not expressible.
    expect(result.status).toBe("malformed");
    expect((result as { reason: string }).reason).toMatch(/sourceEvidence/);
  });

  it("creates a reviewable amendment without writing the constitution", async () => {
    const original = "# C\n\n1. No secrets.\n";
    const root = workspace({ "docs/standards/constitution.md": original });
    const h = harness({ root, manifest: manifest({}), approve: true });

    const result = await h.run("constitution.propose", {
      rule: "a suite that fails to load counts as a failure",
      rationale: "amends rule 1",
      diff: "2. **A suite that fails to load counts as a failure.**",
      sourceEvidence: ["docs/standards/constitution.md:3"],
    });

    expect(result.status).toBe("accepted");
    expect(readFileSync(join(root, "docs/standards/constitution.md"), "utf8")).toBe(original);
    expect(h.store.list().some((p) => p.kind === "constitution")).toBe(true);
  });

  it("fails closed when the workspace has no constitution at all", async () => {
    // br-nft8. An amendment written into a throwaway worktree is learned and
    // then discarded, which looks exactly like governance working while the
    // governance evaporates. Refusing is the correct answer.
    const root = workspace({});
    const outcome = resolveConstitutionPath(root);
    expect("reason" in outcome).toBe(true);
    expect((outcome as { reason: string }).reason).toMatch(/refusing to create a new constitution/);

    const h = harness({ root, manifest: manifest({}), approve: true });
    const result = await h.run("constitution.propose", {
      rule: "r",
      rationale: "why",
      diff: "+ rule",
      sourceEvidence: ["somewhere"],
    });
    expect(result.status).toBe("rejected");
    expect(existsSync(join(root, "docs"))).toBe(false);
  });

  it("finds the constitution in an ancestor rather than creating a second one", async () => {
    const root = workspace({ "docs/standards/constitution.md": "# C\n" });
    const nested = join(root, "packages", "inner");
    mkdirSync(nested, { recursive: true });

    const outcome = resolveConstitutionPath(nested);
    expect(outcome).toEqual({ path: join(root, "docs", "standards", "constitution.md") });
  });
});
describe("applying a constitution amendment is a separate, approved, checkable act", () => {
  /**
   * These cases could not exist until br-dlol landed. Before it, `MutationGuard`
   * refused every protected path unconditionally, so `constitution.apply` could
   * never reach its write — REQ-SAFE-008's "approval and application are
   * separate, auditable operations" was satisfied by application being
   * impossible. That reads as governance working right up until someone needs
   * it to work, which is why it was a bug rather than a safe default.
   *
   * The carve-out (br-9uqd) is narrow, and these tests are what hold it narrow.
   */
  const ORIGINAL = "# Constitution\n\n1. No secrets in logs.\n";
  const AMENDMENT = "2. **A suite that fails to load counts as a failure.**";

  function applier(overrides: { approve?: boolean | null } = {}) {
    const root = workspace({ "docs/standards/constitution.md": ORIGINAL });
    const m = manifest({
      // `auto`, deliberately. A behavior that APPLIES an approved amendment is
      // performing a write, and `propose` refuses every write at the registry
      // boundary before any handler runs. The constitution-learning behavior
      // stays in `propose` precisely because it only ever proposes; the two
      // are different jobs with different authority, which is the separation
      // REQ-SAFE-008 asks for.
      mode: "auto",
      commands: ["constitution.propose", "constitution.apply"],
      mutationClasses: ["constitution.write"],
    });
    // NOT `?? true`: `null` is the "no approval channel at all" case, and
    // `null ?? true` would quietly hand the test a working auto-approver.
    const approve = overrides.approve === undefined ? true : overrides.approve;
    const h = harness({ root, manifest: m, approve });
    return { root, h, file: join(root, "docs/standards/constitution.md") };
  }

  async function propose(h: Harness) {
    const result = await h.run("constitution.propose", {
      rule: "a suite that fails to load counts as a failure",
      rationale: "verification trusted a runner the same run judged defective",
      diff: AMENDMENT,
      sourceEvidence: ["docs/standards/constitution.md:3"],
    });
    const ref = (result as { proposalRef: string }).proposalRef;
    expect(ref).toBeTruthy();
    return ref;
  }

  it("applies an approved amendment to the canonical file", async () => {
    const { h, file } = applier();
    const ref = await propose(h);

    const applied = await h.run("constitution.apply", { proposalRef: ref });

    expect(applied.status).toBe("completed");
    const after = readFileSync(file, "utf8");
    expect(after).toContain(AMENDMENT);
    // Appends. An amendment that silently replaced the document would lose
    // every rule it did not mention.
    expect(after).toContain("1. No secrets in logs.");
  });

  it("asks a human first, and writes nothing when the answer is no", async () => {
    const { h, file } = applier({ approve: false });
    const ref = await propose(h);

    const applied = await h.run("constitution.apply", { proposalRef: ref });

    expect(applied.status).toBe("awaiting_approval");
    expect(h.approvals.length).toBeGreaterThan(0);
    expect(readFileSync(file, "utf8")).toBe(ORIGINAL);
  });

  it("fails closed when there is no approval channel at all", async () => {
    const { h, file } = applier({ approve: null });
    const ref = await propose(h);

    const applied = await h.run("constitution.apply", { proposalRef: ref });

    expect(applied.status).not.toBe("completed");
    expect(readFileSync(file, "utf8")).toBe(ORIGINAL);
  });

  it("refuses when the constitution changed after the amendment was proposed", async () => {
    const { h, file } = applier();
    const ref = await propose(h);

    // Someone edits the constitution between proposal and approval. The
    // amendment was reasoned about against text that no longer exists.
    const edited = `${ORIGINAL}\n3. Unrelated human edit.\n`;
    writeFileSync(file, edited);

    const applied = await h.run("constitution.apply", { proposalRef: ref });

    expect(applied.status).toBe("rejected");
    expect((applied as { reason?: string }).reason).toMatch(/changed since/);
    expect(readFileSync(file, "utf8")).toBe(edited);
  });

  it("refuses to apply the same amendment twice", async () => {
    const { h } = applier();
    const ref = await propose(h);

    expect((await h.run("constitution.apply", { proposalRef: ref })).status).toBe("completed");
    const second = await h.run("constitution.apply", { proposalRef: ref });

    expect(second.status).toBe("rejected");
    expect((second as { reason?: string }).reason).toMatch(/already applied/);
  });

  it("refuses a behavior that did not declare the apply command", async () => {
    const root = workspace({ "docs/standards/constitution.md": ORIGINAL });
    const h = harness({
      root,
      // Declares the mutation class but not the command. A mutation grant is
      // not a command grant.
      manifest: manifest({ commands: ["constitution.propose"], mutationClasses: ["constitution.write"] }),
      approve: true,
    });
    const ref = await propose(h);

    const applied = await h.run("constitution.apply", { proposalRef: ref });

    // `unauthorized`, not `rejected`: the registry refused on capability
    // before the handler ran. The distinction is worth asserting — a handler
    // rejection would mean the command had been allowed to start.
    expect(applied.status).toBe("unauthorized");
    expect(readFileSync(join(root, "docs/standards/constitution.md"), "utf8")).toBe(ORIGINAL);
  });

  it("still refuses a protected path that is not the constitution", async () => {
    // The carve-out must buy nothing anywhere else. Same behavior, same
    // granted class, ordinary protected file.
    const m = manifest({ commands: ["fix.apply"], mutationClasses: ["constitution.write", "artifact.write"] });
    const compiled = compile({ behaviors: [m] }).compiled[0];
    const guard = createMutationGuard(compiled);

    const verdict = guard.authorize({
      mutationClass: "constitution.write",
      path: "packages/agent-core/tests/commands.test.ts",
      kind: "write",
    });

    expect(verdict.allowed).toBe(false);
  });
});
