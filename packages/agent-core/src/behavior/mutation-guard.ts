import { CompiledBehaviorPackage } from "./compiler";
import { classifyPath } from "./protected-paths";

/**
 * The single mutation class exempt from protected-path refusal below.
 *
 * Declared here, beside the check it governs, so the exemption has exactly one
 * name in the codebase. `cqrs/command-registry.ts` imports it from this module
 * — never the reverse, which would be a cycle — and refuses to register any
 * command descriptor that claims this class without requiring approval.
 */
export const SANCTIONED_PROTECTED_CLASS = "constitution.write";

/**
 * The mutation class permitted to write the hand-authored agent brief (br-42nn).
 *
 * A SECOND sanctioned class rather than a widening of the first. Reusing
 * "constitution.write" would have been one line, but it would make a decision
 * entry indistinguishable from a constitution amendment in code, in logs and
 * in the registry's own refusal message -- and the two carry different
 * authority. Keeping them distinct means a behavior granted one cannot write
 * the other, which is the property worth having.
 */
export const SANCTIONED_DECISION_CLASS = "decision.write";

/**
 * The single authorization chokepoint for mutations (TRD-002).
 *
 * Before this existed, `CompiledBehaviorPackage.hasMutationAuthority()`
 * was defined with zero call sites: `capabilities.mutation_classes`
 * was parsed, validated, compiled, and then never consulted by
 * anything. Declaring a mutation class had no runtime consequence, so
 * the governance model was documentation rather than enforcement.
 *
 * Everything that mutates state must route through `authorize()`.
 * Scattering equivalent checks across individual call sites is exactly
 * the failure mode this replaces — one reachable chokepoint is
 * auditable; N optional wrappers are not.
 *
 * `policy.mode` branching (propose/auto/shadow) is handled here as of
 * TRD-017, and the protected-path write boundary as of TRD-020. Both
 * live at this one chokepoint on purpose: a second enforcement site
 * would be a second thing to forget.
 */

export type MutationKind = "write" | "delete" | "commit";

export interface MutationRequest {
  /** Declared class of the mutation, e.g. "artifact.write". */
  mutationClass: string;
  /** Target path, when the mutation is path-scoped. */
  path?: string;
  kind: MutationKind;
}

export type MutationDecision =
  | { allowed: true }
  | { allowed: false; reason: string; escalate: boolean };

export interface MutationGuard {
  /**
   * True when this guard is actually consulted at a real mutation
   * boundary. The loader refuses `mode: auto` manifests when this is
   * false rather than degrading to unenforced auto-apply (TRD-004).
   */
  readonly enforcementActive: boolean;
  /** The policy mode this guard enforces. */
  readonly mode: PolicyMode;
  authorize(request: MutationRequest): MutationDecision;
}

export type PolicyMode = "auto" | "propose" | "shadow";

export interface MutationGuardOptions {
  /** Overrides the manifest mode; used by the auto-fix loop's dry runs. */
  mode?: PolicyMode;
}

export function createMutationGuard(
  compiled: CompiledBehaviorPackage,
  options: MutationGuardOptions = {},
): MutationGuard {
  const behaviorName = compiled.manifest.metadata.name;
  const declared = compiled.manifest.capabilities.mutation_classes;
  const mode: PolicyMode = options.mode ?? (compiled.manifest.policy.mode as PolicyMode);

  return {
    enforcementActive: true,
    mode,
    authorize(request: MutationRequest): MutationDecision {
      if (!request.mutationClass) {
        return {
          allowed: false,
          reason: `mutation denied for behavior "${behaviorName}": no mutation class declared on the request`,
          escalate: false,
        };
      }

      // Deliberately consults hasMutationAuthority() and never
      // hasTool(): a bash grant must never be mistakable for
      // artifact-write authority (AC-011-3). A behavior that holds
      // `bash` but not `artifact.write` is denied here even though it
      // could physically shell out — the denial is what makes the
      // separation real rather than nominal.
      if (!compiled.hasMutationAuthority(request.mutationClass)) {
        return {
          allowed: false,
          reason:
            `mutation class "${request.mutationClass}" is not granted to behavior "${behaviorName}" ` +
            `(capabilities.mutation_classes: [${declared.join(", ")}])`,
          escalate: true,
        };
      }

      // The write boundary is checked BEFORE mode. A protected path is
      // refused even in `mode: auto` with every class granted: the
      // cheapest way to make a failing test pass is to edit the test,
      // and no amount of declared authority should buy that (TRD-020 /
      // AC-015-2). Mechanical path check, no model involvement.
      //
      // ONE exception, and it is a recorded decision rather than an
      // assumption. br-9uqd retired the older "approval IS a pull request"
      // design -- main is protected and advances only through a dev -> main
      // release PR, so human review is structural now -- and named this
      // consequence directly: "WriteBoundaryMonitor must permit exactly that
      // one authorized write." Without it `constitution.apply` cannot reach
      // its write, and REQ-SAFE-008's separate, auditable application would be
      // satisfied by application being impossible: governance that reads as
      // working right up until someone needs it to work.
      //
      // Why this stays narrow. A mutation class is declared by a command
      // DESCRIPTOR, never by behavior data, so no manifest can mint
      // `constitution.write` for itself; the only route to it is a registered
      // command. CommandRegistry.register() refuses any descriptor claiming
      // SANCTIONED_PROTECTED_CLASS without `requiresApproval`, so this cannot
      // be widened later by adding an unapproved command in a distant file.
      // Coarse class/path scoping is all that belongs here -- the guard runs
      // BEFORE approval, so it has no approval state to consult. The
      // anti-forgery checks live one layer down, in the constitution.apply
      // handler: proposal exists, is a constitution proposal, is unapplied,
      // and its baseSha256 still matches the file on disk.
      //
      // This widens what is reachable. It does not widen who may reach it,
      // and buys nothing against a test file, a fixture or a guardrail source.
      if (request.path) {
        const verdict = classifyPath(request.path);
        // Each exemption is keyed to BOTH a path reason and a class, so a
        // behavior holding one sanctioned class cannot use it to reach the
        // other's file. A single "is sanctioned" flag would have collapsed
        // that distinction the first time a second class was added.
        const sanctioned =
          (verdict.reason === "constitution" && request.mutationClass === SANCTIONED_PROTECTED_CLASS) ||
          (verdict.reason === "decision-memory" && request.mutationClass === SANCTIONED_DECISION_CLASS);
        if (verdict.protected && !sanctioned) {
          return {
            allowed: false,
            reason:
              `write to protected path refused for behavior "${behaviorName}": ` +
              `${request.path} is a ${verdict.reason}`,
            escalate: true,
          };
        }
      }

      // Mode semantics (TRD-017). Previously `policy.mode` was parsed,
      // validated and then never consulted at a mutation boundary, so
      // `propose` and `auto` behaved identically at runtime.
      if (mode === "shadow") {
        return {
          allowed: false,
          reason: `behavior "${behaviorName}" runs in mode: shadow; all mutations are observed and denied`,
          escalate: false,
        };
      }

      if (mode === "propose") {
        return {
          allowed: false,
          reason:
            `behavior "${behaviorName}" runs in mode: propose; direct ${request.kind} to ` +
            `${request.path ?? "(no path)"} is denied — emit a proposal artifact instead`,
          escalate: true,
        };
      }

      return { allowed: true };
    },
  };
}
