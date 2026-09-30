/**
 * The built-in command catalog.
 *
 * Every effect the reference flow can have is one of these. That is the whole
 * claim of REQ-CQRS-002: if a behavior changes something, it happened here,
 * with a declared mutation class, through `MutationGuard`, in an outcome whose
 * name matches what actually occurred.
 *
 * The split across `propose` / `verify` / `apply` is not ceremony. Each was a
 * separate live failure:
 *
 *   propose  a `mode: propose` run left a fix applied, because the only code
 *            path that could produce a fix also wrote it (br-dowt).
 *   verify   a candidate was verified in the user's tree, so verification and
 *            mutation were the same act and could not be ordered differently.
 *   apply    application was implied by verification passing; no human was
 *            asked, and nothing revalidated the tree in between.
 *
 * They are separate commands so that "proposed", "verified" and "applied" are
 * separate facts with separate authority, which is what REQ-CQRS-003 asks for
 * in the abstract and what the incident log asks for concretely.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CommandDescriptor, EvidenceRef, HandlerOutcome } from "./command-contract";
import { FieldSchema } from "./field-schema";
import { Proposal, ProposalStore, currentHash, hashContents } from "./proposal-store";
import { VerificationResult, verifyOutput } from "./verification";
import { createIsolatedWorkspace, materialize } from "./isolated-workspace";
import { checkWorkspaceIntegrity } from "../workspace/integrity";
import { DocClaim, verifyClaims } from "../docs/claim-verification";
import { classifyPath } from "../behavior/protected-paths";
import { SANCTIONED_PROTECTED_CLASS } from "./command-registry";

export interface CommandCatalogDeps {
  readonly workspaceRoot: string;
  readonly store: ProposalStore;
  /** Runs a shell command and returns raw output. Injectable for tests. */
  readonly runCommand?: (
    command: string,
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; spawnFailed?: boolean };
  /** Overrides isolated-workspace creation; tests supply a plain directory. */
  readonly isolate?: typeof createIsolatedWorkspace;
  /** Resolves where a constitution amendment belongs (REQ-SAFE-008, br-nft8). */
  readonly resolveConstitutionPath?: (workspaceRoot: string) => { path: string } | { reason: string };
  /** Overridable so tests can point the agent brief at a sandbox. */
  readonly resolveDecisionsPath?: (workspaceRoot: string) => { path: string } | { reason: string };
  readonly now?: () => string;
  /**
   * Told about each approved write to a protected path, after it lands
   * (br-9uqd: "WriteBoundaryMonitor must permit exactly that one authorized
   * write"). A host running an effect-based boundary adopts the new content
   * as its baseline here; without this, the boundary reverts the amendment a
   * human just approved on the next tool call and the run still reports it
   * applied. Not a permission: MutationGuard and the approval gate have
   * already decided by the time it is called.
   */
  readonly onSanctionedWrite?: (absolutePath: string) => void;
}

const WRITE_SCHEMA: FieldSchema = {
  type: "object",
  fields: { path: { type: "string", minLength: 1 }, contents: { type: "string" } },
};

const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60_000;

function defaultRunCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; spawnFailed?: boolean } {
  const result = spawnSync("bash", ["-lc", command], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status,
    timedOut: result.error?.message?.includes("ETIMEDOUT") === true || result.signal === "SIGTERM",
    spawnFailed: result.error !== undefined && result.status === null && result.signal === null,
  };
}

/**
 * Where a constitution amendment belongs (br-nft8).
 *
 * The decision recorded here: amendments go to the constitution that already
 * exists, and nowhere else. A constitution is a property of the project, not
 * of whichever worktree happened to run the failing command — writing one into
 * a throwaway checkout means the rule is learned and then discarded, which
 * looks exactly like governance working while the governance evaporates.
 *
 * So the search walks up from the workspace root looking for an existing
 * `docs/standards/constitution.md`. If there is none, the command FAILS and
 * says so. Creating a second constitution somewhere plausible is the outcome
 * this refuses.
 */
import { formatDecisionEntry, resolveDecisionsPath } from "./decision-memory";

export function resolveConstitutionPath(workspaceRoot: string): { path: string } | { reason: string } {
  const relative = join("docs", "standards", "constitution.md");
  let current = resolve(workspaceRoot);
  for (;;) {
    const candidate = join(current, relative);
    try {
      readFileSync(candidate, "utf8");
      return { path: candidate };
    } catch {
      /* keep walking */
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return {
    reason:
      `no existing ${relative} was found at or above ${workspaceRoot}; ` +
      `refusing to create a new constitution in a workspace that has none, because an amendment ` +
      `written somewhere the project does not read is learned and then discarded`,
  };
}

export function createCommandCatalog(deps: CommandCatalogDeps): CommandDescriptor<never, unknown>[] {
  const now = deps.now ?? (() => new Date().toISOString());
  const run = deps.runCommand ?? defaultRunCommand;
  const isolate = deps.isolate ?? createIsolatedWorkspace;
  const constitutionPath = deps.resolveConstitutionPath ?? resolveConstitutionPath;
  const decisionsPath = deps.resolveDecisionsPath ?? resolveDecisionsPath;

  /** Records an investigation's structured diagnosis. Reads nothing, writes nothing. */
  const investigationRecord: CommandDescriptor<
    { command: string; diagnosis: string; confidence: string; evidence?: string[] },
    unknown
  > = {
    id: "investigation.record",
    version: "1.0.0",
    description: "Record a structured diagnosis for an observed test failure",
    requiredCapability: "investigation.record",
    emits: ["test.failure.investigated"],
    input: {
      type: "object",
      fields: {
        command: { type: "string", minLength: 1 },
        diagnosis: { type: "string", minLength: 1 },
        confidence: { type: "string", enum: ["high", "medium", "low", "inconclusive"] },
        evidence: { type: "array", items: { type: "string" } },
      },
      optional: ["evidence"],
    },
    result: {
      type: "object",
      fields: {
        confidence: { type: "string" },
        events: { type: "record", values: { type: "unknown" } },
      },
    },
    async handler(ctx, args) {
      ctx.log({ kind: "investigation", confidence: args.confidence });
      return {
        status: "completed",
        result: {
          confidence: args.confidence,
          events: {
            "test.failure.investigated": {
              command: args.command,
              diagnosis: args.diagnosis,
              confidence: args.confidence,
              evidence: args.evidence ?? [],
            },
          },
        },
        evidence: (args.evidence ?? []).map((e): EvidenceRef => ({ kind: "note", ref: e })),
      };
    },
  };

  /**
   * Creates a reviewable proposal. Declares NO mutation class, because it
   * changes nothing in the project — the artifact lands under
   * `.ensemble/proposals/`, which is runtime state.
   *
   * This is what makes `mode: propose` a working mode rather than a dead end:
   * the behavior still produces something, and that something is reviewable.
   */
  const fixPropose: CommandDescriptor<
    { issue: string; rationale: string; writes: { path: string; contents: string }[]; evidence?: string[] },
    unknown
  > = {
    id: "fix.propose",
    version: "1.0.0",
    description: "Create a reviewable fix proposal without changing the project",
    requiredCapability: "fix.propose",
    emits: ["fix.proposed", "fix.rejected"],
    input: {
      type: "object",
      fields: {
        issue: { type: "string", minLength: 1 },
        rationale: { type: "string" },
        writes: { type: "array", items: WRITE_SCHEMA, minItems: 1 },
        evidence: { type: "array", items: { type: "string" } },
      },
      optional: ["evidence"],
    },
    result: {
      type: "object",
      fields: {
        proposalRef: { type: "string" },
        paths: { type: "array", items: { type: "string" } },
        events: { type: "record", values: { type: "unknown" } },
      },
    },
    async handler(ctx, args): Promise<HandlerOutcome<unknown>> {
      for (const write of args.writes) {
        if (write.path.startsWith("/") || write.path.split(/[\\/]/).includes("..")) {
          return { status: "rejected", reason: `path ${JSON.stringify(write.path)} escapes the workspace` };
        }
        // Refused at proposal time, not at apply time. A proposal that cannot
        // legally be applied is not a proposal; carrying it forward would put
        // a protected-path edit in front of a human as though it were an
        // option.
        const verdict = classifyPath(write.path);
        if (verdict.protected) {
          return {
            status: "rejected",
            reason: `${write.path} is a ${verdict.reason} and cannot be proposed for modification`,
          };
        }
      }

      const proposal = deps.store.create(
        {
          kind: "fix",
          behavior: ctx.behavior ?? "(none)",
          issue: args.issue,
          rationale: args.rationale,
          correlationId: ctx.correlationId,
          evidence: args.evidence ?? [],
          writes: args.writes.map((w) => ({
            path: w.path,
            contents: w.contents,
            // Captured now so a later apply can tell whether the tree moved
            // under the proposal (REQ-SAFE-005).
            baseSha256: currentHash(deps.workspaceRoot, w.path),
          })),
        },
        now(),
      );

      const paths = proposal.writes.map((w) => w.path);
      ctx.log({ kind: "fix-proposed", proposalRef: proposal.ref, paths });
      return {
        // `accepted`, never `completed`: a proposal exists, the fix does not.
        status: "accepted",
        proposalRef: proposal.ref,
        result: {
          proposalRef: proposal.ref,
          paths,
          events: {
            "fix.proposed": {
              proposalRef: proposal.ref,
              issue: args.issue,
              paths,
              rationale: args.rationale,
            },
          },
        },
        evidence: [{ kind: "proposal", ref: proposal.ref, detail: join(deps.store.directory, `${proposal.ref}.json`) }],
      };
    },
  };

  /**
   * Verifies a proposal in an isolated workspace. Non-mutating to the user's
   * tree by construction: the candidate is written into a throwaway worktree.
   */
  const fixVerify: CommandDescriptor<{ proposalRef: string; command: string; timeoutMs?: number }, unknown> = {
    id: "fix.verify",
    version: "1.0.0",
    description: "Run a verification command against a proposal in an isolated workspace",
    requiredCapability: "fix.verify",
    emits: ["fix.verified"],
    input: {
      type: "object",
      fields: {
        proposalRef: { type: "string", minLength: 1 },
        command: { type: "string", minLength: 1 },
        timeoutMs: { type: "number", integer: true, min: 1000 },
      },
      optional: ["timeoutMs"],
    },
    result: {
      type: "object",
      fields: {
        verdict: { type: "string" },
        detail: { type: "string" },
        framework: { type: "string" },
        events: { type: "record", values: { type: "unknown" } },
      },
    },
    async handler(ctx, args): Promise<HandlerOutcome<unknown>> {
      const proposal = deps.store.read(args.proposalRef);
      if (!proposal) return { status: "rejected", reason: `unknown proposal "${args.proposalRef}"` };

      const isolation = isolate(deps.workspaceRoot, "verify");
      if (!isolation.ok) {
        // Cannot isolate ⇒ cannot verify. Falling back to the live tree would
        // make verification a mutation, which is the thing being avoided.
        const result: VerificationResult = {
          status: "inconclusive",
          detail: isolation.reason,
          framework: "unknown",
          unloadableSuites: [],
        };
        return completeVerification(ctx, proposal, args.command, result);
      }

      try {
        const placed = materialize(isolation.workspace, proposal.writes);
        if (!placed.ok) {
          return completeVerification(ctx, proposal, args.command, {
            status: "inconclusive",
            detail: placed.reason,
            framework: "unknown",
            unloadableSuites: [],
          });
        }

        // The last run of this exact command, if any. Comparing against a
        // different command's total would be meaningless.
        const previous = proposal.verifications.filter((v) => v.command === args.command).slice(-1)[0];
        const output = run(
          args.command,
          isolation.workspace.root,
          args.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
          ctx.signal,
        );
        const verdict = verifyOutput({
          ...output,
          command: args.command,
          previousTotal: previous?.total,
        });
        return completeVerification(ctx, proposal, args.command, verdict);
      } finally {
        isolation.workspace.dispose();
      }
    },
  };

  function completeVerification(
    ctx: { log: (e: Record<string, unknown>) => void },
    proposal: Proposal,
    command: string,
    verdict: VerificationResult,
  ): HandlerOutcome<unknown> {
    deps.store.update({
      ...proposal,
      verifications: [
        ...proposal.verifications,
        { verdict: verdict.status, detail: verdict.detail, command, at: now(), total: verdict.total },
      ],
    });
    ctx.log({ kind: "fix-verified", proposalRef: proposal.ref, verdict: verdict.status });
    return {
      // `completed` because the verification itself ran to a conclusion. The
      // conclusion may well be "inconclusive"; that is the verdict, not the
      // status of the command.
      status: "completed",
      result: {
        verdict: verdict.status,
        detail: verdict.detail,
        framework: verdict.framework,
        events: {
          "fix.verified": {
            proposalRef: proposal.ref,
            verdict: verdict.status,
            detail: verdict.detail,
            command,
            // Carried so a downstream behavior judges the fix with the
            // diagnosis in hand rather than inferring one from a verdict
            // (br-zcxb). The rationale IS the investigation's diagnosis:
            // fix-failing-test passes `${steps.investigate.diagnosis}` into
            // fix.propose as `rationale`.
            rationale: proposal.rationale,
            evidence: proposal.evidence,
          },
        },
      },
      evidence: [{ kind: "verification", ref: proposal.ref, detail: verdict.detail }],
    };
  }

  /**
   * Applies a proposal. The only command in the catalog that writes project
   * source, and therefore the only one carrying `artifact.write`.
   *
   * Under `mode: propose` the registry refuses it before the handler runs, so
   * "propose cannot mutate" is a property of the boundary rather than of this
   * function remembering to check.
   */
  const fixApply: CommandDescriptor<{ proposalRef: string; paths?: string[] }, unknown> = {
    id: "fix.apply",
    version: "1.0.0",
    description: "Apply a verified fix proposal to the workspace",
    requiredCapability: "fix.apply",
    mutation: { class: "artifact.write", kind: "write" },
    requiresApproval: true,
    emits: ["fix.applied", "fix.rejected"],
    input: {
      type: "object",
      fields: {
        proposalRef: { type: "string", minLength: 1 },
        paths: { type: "array", items: { type: "string" } },
      },
      optional: ["paths"],
    },
    result: {
      type: "object",
      fields: {
        proposalRef: { type: "string" },
        paths: { type: "array", items: { type: "string" } },
        events: { type: "record", values: { type: "unknown" } },
      },
    },
    async handler(ctx, args): Promise<HandlerOutcome<unknown>> {
      const proposal = deps.store.read(args.proposalRef);
      if (!proposal) return { status: "rejected", reason: `unknown proposal "${args.proposalRef}"` };
      if (proposal.appliedAt) {
        return { status: "rejected", reason: `proposal ${proposal.ref} was already applied at ${proposal.appliedAt}` };
      }

      const passed = proposal.verifications.some((v) => v.verdict === "passed");
      if (!passed) {
        // REQ-SAFE-006: an auto-apply path may accept a change only when a
        // verifier proved the required suite ran and passed. No verdict, or
        // an inconclusive one, is not that proof.
        const latest = proposal.verifications[proposal.verifications.length - 1];
        return {
          status: "rejected",
          reason: latest
            ? `proposal ${proposal.ref} has no passing verification; latest verdict was ${latest.verdict}: ${latest.detail}`
            : `proposal ${proposal.ref} has not been verified`,
        };
      }

      // Revalidated against the CURRENT tree, not against the tree at proposal
      // time (REQ-SAFE-002). Between proposing and applying, the user may have
      // edited the same file, and their edit wins.
      const stale = deps.store.staleWrites(proposal);
      if (stale.length > 0) {
        return {
          status: "rejected",
          reason:
            `proposal ${proposal.ref} is stale: ${stale.join(", ")} changed since it was created. ` +
            `Nothing was written; re-investigate against the current tree rather than overwriting a concurrent edit`,
        };
      }

      const applied: string[] = [];
      for (const write of proposal.writes) {
        // Asked per path even though the registry pre-authorized the set: a
        // handler that mutates without asking is the failure mode, and one
        // chokepoint consulted twice costs nothing.
        const decision = ctx.authorizeMutation({ mutationClass: "artifact.write", path: write.path, kind: "write" });
        if (!decision.allowed) {
          return { status: "rejected", reason: decision.reason };
        }
        const abs = resolve(deps.workspaceRoot, write.path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, write.contents, "utf8");
        applied.push(write.path);
      }

      deps.store.update({ ...proposal, appliedAt: now() });
      ctx.log({ kind: "fix-applied", proposalRef: proposal.ref, paths: applied });
      return {
        status: "completed",
        result: {
          proposalRef: proposal.ref,
          paths: applied,
          events: { "fix.applied": { proposalRef: proposal.ref, paths: applied } },
        },
        evidence: [{ kind: "proposal", ref: proposal.ref }],
      };
    },
  };

  const constitutionPropose: CommandDescriptor<
    { rule: string; rationale: string; diff: string; sourceEvidence: string[] },
    unknown
  > = {
    id: "constitution.propose",
    version: "1.0.0",
    description: "Create an evidence-backed constitution amendment proposal",
    requiredCapability: "constitution.propose",
    emits: ["constitution.proposed"],
    input: {
      type: "object",
      fields: {
        rule: { type: "string", minLength: 1 },
        rationale: { type: "string", minLength: 1 },
        diff: { type: "string", minLength: 1 },
        sourceEvidence: { type: "array", items: { type: "string" }, minItems: 1 },
      },
    },
    result: {
      type: "object",
      fields: {
        proposalRef: { type: "string" },
        events: { type: "record", values: { type: "unknown" } },
      },
    },
    async handler(ctx, args): Promise<HandlerOutcome<unknown>> {
      // REQ-SAFE-008 requires source evidence, and requiring it in the schema
      // is what stops "a test passed, therefore a rule" from being expressible.
      const target = constitutionPath(deps.workspaceRoot);
      if ("reason" in target) return { status: "rejected", reason: target.reason };

      const proposal = deps.store.create(
        {
          kind: "constitution",
          behavior: ctx.behavior ?? "(none)",
          issue: args.rule,
          rationale: args.rationale,
          correlationId: ctx.correlationId,
          evidence: args.sourceEvidence,
          writes: [
            {
              path: target.path,
              contents: args.diff,
              baseSha256: currentHash(deps.workspaceRoot, target.path),
            },
          ],
        },
        now(),
      );

      ctx.log({ kind: "constitution-proposed", proposalRef: proposal.ref, target: target.path });
      return {
        status: "accepted",
        proposalRef: proposal.ref,
        result: {
          proposalRef: proposal.ref,
          events: {
            "constitution.proposed": {
              proposalRef: proposal.ref,
              rule: args.rule,
              rationale: args.rationale,
              diff: args.diff,
              sourceEvidence: args.sourceEvidence,
            },
          },
        },
        evidence: args.sourceEvidence.map((e): EvidenceRef => ({ kind: "evidence", ref: e })),
      };
    },
  };

  /**
   * Applies a constitution amendment. Separate command, separate capability,
   * separate approval, separate event — REQ-SAFE-008's "approval and
   * application are separate, auditable operations", made structural.
   */
  const constitutionApply: CommandDescriptor<{ proposalRef: string }, unknown> = {
    id: "constitution.apply",
    version: "1.0.0",
    description: "Apply an approved constitution amendment to the canonical constitution",
    requiredCapability: "constitution.apply",
    mutation: { class: SANCTIONED_PROTECTED_CLASS, kind: "write" },
    requiresApproval: true,
    emits: ["constitution.applied", "constitution.declined"],
    input: { type: "object", fields: { proposalRef: { type: "string", minLength: 1 } } },
    result: {
      type: "object",
      fields: {
        proposalRef: { type: "string" },
        path: { type: "string" },
        events: { type: "record", values: { type: "unknown" } },
      },
    },
    async handler(ctx, args): Promise<HandlerOutcome<unknown>> {
      const proposal = deps.store.read(args.proposalRef);
      if (!proposal) return { status: "rejected", reason: `unknown proposal "${args.proposalRef}"` };
      if (proposal.kind !== "constitution") {
        return { status: "rejected", reason: `proposal ${proposal.ref} is a ${proposal.kind} proposal` };
      }
      if (proposal.appliedAt) {
        return { status: "rejected", reason: `proposal ${proposal.ref} was already applied at ${proposal.appliedAt}` };
      }

      const target = constitutionPath(deps.workspaceRoot);
      if ("reason" in target) return { status: "rejected", reason: target.reason };

      const write = proposal.writes[0];
      const onDisk = currentHash(deps.workspaceRoot, target.path);
      if (onDisk !== write.baseSha256) {
        return {
          status: "rejected",
          reason: `${target.path} changed since the amendment was proposed; nothing was written`,
        };
      }

      const decision = ctx.authorizeMutation({
        mutationClass: SANCTIONED_PROTECTED_CLASS,
        path: target.path,
        kind: "write",
      });
      if (!decision.allowed) return { status: "rejected", reason: decision.reason };

      const existing = (() => {
        try {
          return readFileSync(target.path, "utf8");
        } catch {
          return "";
        }
      })();
      const amended = `${existing.replace(/\s*$/, "")}\n\n${write.contents.trim()}\n`;
      writeFileSync(target.path, amended, "utf8");
      // Adopted before anything else can observe it. If adoption throws, the
      // handler fails -- reported as "failed", never "declined" -- rather than
      // claiming an amendment that the boundary is about to revert.
      deps.onSanctionedWrite?.(target.path);
      deps.store.update({ ...proposal, appliedAt: now() });

      ctx.log({ kind: "constitution-applied", proposalRef: proposal.ref, path: target.path });
      return {
        status: "completed",
        result: {
          proposalRef: proposal.ref,
          path: target.path,
          events: { "constitution.applied": { proposalRef: proposal.ref, path: target.path } },
        },
        evidence: [
          { kind: "constitution", ref: target.path, detail: `sha256 ${hashContents(amended)}` },
          ...proposal.evidence.map((e): EvidenceRef => ({ kind: "evidence", ref: e })),
        ],
      };
    },
  };

  /**
   * Adjudicates claims extracted from documentation (br-gpha).
   *
   * THE SPLIT IS THE SAFEGUARD. A model proposes candidate claims, because
   * finding them in prose needs judgement. This command decides, and its
   * decisions are mechanical and reproducible. A model that both proposed and
   * adjudicated would be marking its own homework — which is literally how
   * the invented line citations were produced: by grepping a file after
   * inserting a note, then reading that note back as corroboration.
   */
  const docVerify: CommandDescriptor<{ claims: DocClaim[]; sourceFiles?: string[] }, unknown> = {
    id: "doc.verify",
    version: "1.0.0",
    description: "Check documented paths, npm scripts and exported symbols against the tree",
    requiredCapability: "doc.verify",
    emits: ["behavior.observation.recorded"],
    input: {
      type: "object",
      fields: {
        claims: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            fields: {
              kind: { type: "string", minLength: 1 },
              value: { type: "string", minLength: 1 },
              source: { type: "string" },
            },
            optional: ["source"],
          },
        },
        sourceFiles: { type: "array", items: { type: "string" } },
      },
      optional: ["sourceFiles"],
    },
    result: {
      type: "object",
      fields: {
        ok: { type: "boolean" },
        checked: { type: "number" },
        unresolved: { type: "array", items: { type: "record", values: { type: "unknown" } } },
        events: { type: "record", values: { type: "unknown" } },
      },
    },
    async handler(ctx, args): Promise<HandlerOutcome<unknown>> {
      const known: ReadonlySet<string> = new Set(["path", "npm-script", "symbol"]);
      const unknownKind = args.claims.find((c) => !known.has(c.kind));
      if (unknownKind) {
        // Rejected, not ignored. Silently dropping a claim kind would let a
        // document report "all claims verified" when some were never checked
        // — a vacuous pass wearing the costume of a thorough one.
        return { status: "rejected", reason: `unknown claim kind "${unknownKind.kind}"` };
      }

      const report = verifyClaims({
        root: deps.workspaceRoot,
        claims: args.claims,
        sourceFiles: args.sourceFiles,
      });

      ctx.log({ kind: "doc-verified", checked: report.checked, unresolved: report.unresolved.length });
      return {
        status: "completed",
        result: {
          ok: report.ok,
          checked: report.checked,
          unresolved: report.unresolved,
          events: {
            "behavior.observation.recorded": {
              observation: "doc.claims",
              ok: report.ok,
              checked: report.checked,
              unresolved: report.unresolved,
            },
          },
        },
        evidence: report.verdicts.map((v) => ({
          kind: "doc-claim" as const,
          ref: v.value,
          detail: `${v.holds ? "holds" : "UNRESOLVED"}: ${v.detail}${v.source ? ` (${v.source})` : ""}`,
        })),
      };
    },
  };

  /**
   * Runs a verification command in an isolated workspace, unbound to any
   * proposal (br-zctt).
   *
   * `fix.verify` does the same work but only for a proposal's writes. A gate
   * that wants to check the tree AS IT STANDS had no command at all, so this
   * exists rather than overloading `fix.verify` with an optional proposal —
   * an optional binding on a security-relevant command is how the binding
   * ends up skipped.
   *
   * THE VERDICT IS THE POINT, NOT THE EXIT CODE. `verifyOutput` returns
   * `inconclusive` for a run that executed nothing, so "Tests: 0 total,
   * exit 0" cannot be reported as success. A gate that accepts a vacuous pass
   * is worse than no gate, because it manufactures confidence (br-cwrh).
   */
  const verificationRun: CommandDescriptor<{ command: string; timeoutMs?: number }, unknown> = {
    id: "verification.run",
    version: "1.0.0",
    description: "Run a verification command against the current tree in an isolated workspace",
    requiredCapability: "verification.run",
    emits: ["behavior.observation.recorded"],
    input: {
      type: "object",
      fields: {
        command: { type: "string", minLength: 1 },
        timeoutMs: { type: "number", integer: true, min: 1000 },
      },
      optional: ["timeoutMs"],
    },
    result: {
      type: "object",
      fields: {
        verdict: { type: "string" },
        detail: { type: "string" },
        framework: { type: "string" },
        vacuous: { type: "boolean" },
        events: { type: "record", values: { type: "unknown" } },
      },
    },
    async handler(ctx, args): Promise<HandlerOutcome<unknown>> {
      const isolation = isolate(deps.workspaceRoot, "verification");
      if (!isolation.ok) {
        // Cannot isolate ⇒ cannot verify. Running in the live tree would make
        // verification a mutation, which is the thing being avoided — and
        // "we could not isolate" must never resolve to "therefore proceed".
        return {
          status: "completed",
          result: {
            verdict: "inconclusive",
            detail: isolation.reason,
            framework: "unknown",
            vacuous: false,
            events: {
              "behavior.observation.recorded": {
                observation: "verification.run",
                verdict: "inconclusive",
                detail: isolation.reason,
              },
            },
          },
          evidence: [{ kind: "verification", ref: args.command, detail: isolation.reason }],
        };
      }

      try {
        const output = run(
          args.command,
          isolation.workspace.root,
          args.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
          ctx.signal,
        );
        const verdict = verifyOutput({ ...output, command: args.command });
        // A run that executed nothing is reported as such in its own field,
        // so a consumer cannot collapse it into "not passed" and lose the
        // distinction between "your code is broken" and "nothing was checked".
        const vacuous = verdict.status === "inconclusive" && verdict.total === 0;

        ctx.log({ kind: "verification-run", command: args.command, verdict: verdict.status, vacuous });
        return {
          status: "completed",
          result: {
            verdict: verdict.status,
            detail: verdict.detail,
            framework: verdict.framework,
            vacuous,
            events: {
              "behavior.observation.recorded": {
                observation: "verification.run",
                command: args.command,
                verdict: verdict.status,
                detail: verdict.detail,
                vacuous,
              },
            },
          },
          evidence: [{ kind: "verification", ref: args.command, detail: verdict.detail }],
        };
      } finally {
        isolation.workspace.dispose();
      }
    },
  };

  /**
   * Read-only workspace integrity check (br-c4ni).
   *
   * No mutation class and no approval, because it changes nothing: it reads
   * the filesystem and reports. Deliberately NOT a repair — a fix here means
   * `npm install`, which is the developer's call, and a runtime that silently
   * rewrote a dependency tree would be a worse problem than the one it solved.
   */
  const workspaceCheck: CommandDescriptor<{ root?: string }, unknown> = {
    id: "workspace.check",
    version: "1.0.0",
    description: "Report unresolvable workspace symlinks and lockfile drift, without repairing them",
    requiredCapability: "workspace.check",
    emits: ["behavior.observation.recorded"],
    input: { type: "object", fields: { root: { type: "string" } }, optional: ["root"] },
    result: {
      type: "object",
      fields: {
        ok: { type: "boolean" },
        findings: { type: "array", items: { type: "record", values: { type: "unknown" } } },
        checked: { type: "record", values: { type: "unknown" } },
        events: { type: "record", values: { type: "unknown" } },
      },
    },
    async handler(ctx, args): Promise<HandlerOutcome<unknown>> {
      const report = checkWorkspaceIntegrity(args.root ?? deps.workspaceRoot);

      ctx.log({ kind: "workspace-checked", ok: report.ok, findings: report.findings.length });
      return {
        status: "completed",
        result: {
          ok: report.ok,
          findings: report.findings,
          checked: report.checked,
          events: {
            "behavior.observation.recorded": {
              observation: "workspace.integrity",
              ok: report.ok,
              findings: report.findings,
              checked: report.checked,
            },
          },
        },
        // The counts are the evidence. A report with no findings means
        // something only if it says how much it looked at.
        evidence: [
          {
            kind: "workspace",
            ref: args.root ?? deps.workspaceRoot,
            detail: `${report.checked.linkCount} links examined, lockfile ${report.checked.lockfile ? "compared" : "not present"}`,
          },
        ],
      };
    },
  };

  /**
   * Records a decision reached in conversation (br-42nn).
   *
   * PROPOSE ONLY. The apply half is a separate, approval-gated command for the
   * same reason the constitution has two: AGENTS.md is read by every future
   * session, so a wrong entry becomes a fabricated premise that later work
   * builds on rather than a mistake someone notices. An aspirational event
   * catalog nobody re-checked already cost this project a session's design
   * work, which is the concrete case this guards against.
   *
   * `provenance` is required and free-text rather than an enum: the honest
   * answer is usually "the user corrected me in conversation on <date>", and
   * an enum would force that into a category that loses the only detail worth
   * having.
   */
  const decisionPropose: CommandDescriptor<
    { decision: string; rationale: string; provenance: string; evidence: string[] },
    unknown
  > = {
    id: "decision.propose",
    version: "1.0.0",
    description: "Record an evidence-backed decision for the hand-authored agent brief",
    requiredCapability: "decision.propose",
    emits: ["decision.proposed"],
    input: {
      type: "object",
      fields: {
        decision: { type: "string", minLength: 1 },
        rationale: { type: "string", minLength: 1 },
        provenance: { type: "string", minLength: 1 },
        // minItems 1 makes an unevidenced entry INEXPRESSIBLE rather than
        // discouraged. The whole risk here is confident text with no source.
        evidence: { type: "array", items: { type: "string" }, minItems: 1 },
      },
    },
    result: {
      type: "object",
      fields: {
        proposalRef: { type: "string" },
        events: { type: "record", values: { type: "unknown" } },
      },
    },
    async handler(ctx, args): Promise<HandlerOutcome<unknown>> {
      const target = decisionsPath(deps.workspaceRoot);
      if ("reason" in target) return { status: "rejected", reason: target.reason };

      const recordedAt = now().slice(0, 10);
      const entry = formatDecisionEntry({
        decision: args.decision,
        rationale: args.rationale,
        evidence: args.evidence,
        provenance: args.provenance,
        recordedAt,
      });

      const proposal = deps.store.create(
        {
          kind: "decision",
          behavior: ctx.behavior ?? "(none)",
          issue: args.decision,
          rationale: args.rationale,
          correlationId: ctx.correlationId,
          evidence: args.evidence,
          writes: [{ path: target.path, contents: entry, baseSha256: currentHash(deps.workspaceRoot, target.path) }],
        },
        now(),
      );

      ctx.log({ kind: "decision-proposed", proposalRef: proposal.ref, target: target.path });
      return {
        status: "accepted",
        proposalRef: proposal.ref,
        result: {
          proposalRef: proposal.ref,
          events: {
            "decision.proposed": {
              proposalRef: proposal.ref,
              decision: args.decision,
              rationale: args.rationale,
              provenance: args.provenance,
              evidence: args.evidence,
              recordedAt,
            },
          },
        },
        evidence: args.evidence.map((e): EvidenceRef => ({ kind: "evidence", ref: e })),
      };
    },
  };

  return [
    investigationRecord as unknown as CommandDescriptor<never, unknown>,
    fixPropose as unknown as CommandDescriptor<never, unknown>,
    fixVerify as unknown as CommandDescriptor<never, unknown>,
    fixApply as unknown as CommandDescriptor<never, unknown>,
    constitutionPropose as unknown as CommandDescriptor<never, unknown>,
    constitutionApply as unknown as CommandDescriptor<never, unknown>,
    docVerify as unknown as CommandDescriptor<never, unknown>,
    verificationRun as unknown as CommandDescriptor<never, unknown>,
    workspaceCheck as unknown as CommandDescriptor<never, unknown>,
    decisionPropose as unknown as CommandDescriptor<never, unknown>,
  ];
}

/** Capability required by each built-in command, for validation and status output. */
export const BUILTIN_COMMAND_CAPABILITIES: Readonly<Record<string, string>> = {
  "investigation.record": "investigation.record",
  "fix.propose": "fix.propose",
  "fix.verify": "fix.verify",
  "fix.apply": "fix.apply",
  "constitution.propose": "constitution.propose",
  "constitution.apply": "constitution.apply",
  "doc.verify": "doc.verify",
  "verification.run": "verification.run",
  "workspace.check": "workspace.check",
  "decision.propose": "decision.propose",
};
