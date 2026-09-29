/**
 * The declarative workflow representation (REQ-BEH-002).
 *
 * Deliberately small. §2.1 is explicit that new primitives are a runtime
 * change with a schema version bump, and that combinations of existing
 * primitives are package data. The temptation this resists is a general
 * expression language: once a manifest can evaluate arbitrary text, the
 * manifest becomes code, and "no behavior-specific TypeScript" is satisfied by
 * moving the TypeScript into YAML.
 *
 * So there are five step kinds and one reference syntax, and nothing else.
 *
 * Reference syntax: `${path.to.value}` resolved against a closed scope of
 * `event`, `steps`, `behavior` and `workspace`. It is substitution, not
 * evaluation — no operators, no calls, no indexing by computed key. A
 * reference that does not resolve is an error at run time and, where it is
 * statically knowable, at validation time.
 */

export const WORKFLOW_SCHEMA_VERSION = "1.0.0";

/** Step kinds the interpreter implements. Anything else is rejected, not skipped. */
export const SUPPORTED_STEP_KINDS = ["agent", "command", "condition", "approval", "outcome"] as const;
export type WorkflowStepKind = (typeof SUPPORTED_STEP_KINDS)[number];

export interface WorkflowStepBase {
  /** Stable, unique within the workflow. Referenced by conditions and bindings. */
  readonly id: string;
  readonly kind: WorkflowStepKind;
  /** Bounded per REQ-SAFE-007. Duration string, e.g. `90s`, `5m`. */
  readonly timeout?: string;
  /**
   * Where to go when this step fails. Must name another step or an outcome.
   * Absent means the workflow terminates with a `failed` terminal state —
   * explicit, never a silent continue.
   */
  readonly on_failure?: string;
}

/**
 * A bounded agent invocation. The prompt lives in a package file, not here:
 * REQ-BEH-003 requires prompt text to be editable without a rebuild, and
 * inlining it in the manifest would make every prompt edit a digest-visible
 * manifest edit.
 */
export interface AgentStep extends WorkflowStepBase {
  readonly kind: "agent";
  /** Package-relative path to the prompt template, e.g. `prompts/investigate.md`. */
  readonly prompt: string;
  /**
   * Explicit tool grant for this invocation. Narrower than the behavior's
   * grant is allowed; wider is a validation error. A step cannot widen what
   * its behavior declared.
   */
  readonly tools: readonly string[];
  /** Values substituted into the prompt template, each a reference or literal. */
  readonly inputs?: Record<string, string>;
  /**
   * Shape the reply must satisfy. The reply is parsed as JSON and checked
   * against the named response contract; prose that merely claims success
   * fails the contract and the step fails with it.
   */
  readonly expect: "json" | "text";
  /** Maximum reply size in bytes (REQ-SAFE-007 output bound). */
  readonly max_output_bytes?: number;
  readonly attempts?: number;
}

/** One registered typed command, with schema-validated arguments. */
export interface CommandStep extends WorkflowStepBase {
  readonly kind: "command";
  /** Registered command ID. Unknown IDs fail validation, not run time. */
  readonly command: string;
  /** Argument values; strings may contain `${...}` references. */
  readonly args: Record<string, unknown>;
}

export type ConditionOperator = "equals" | "not_equals" | "in" | "exists" | "not_exists";

/**
 * A branch on a *structured* prior result (REQ-BEH-002 item 3).
 *
 * `left` must reference a validated value — a command result field or a
 * schema-checked agent output. It cannot reference free prose, and there is no
 * operator that inspects natural language, because "the model said it worked"
 * is the claim this contract exists to stop treating as evidence.
 */
export interface ConditionStep extends WorkflowStepBase {
  readonly kind: "condition";
  readonly left: string;
  readonly operator: ConditionOperator;
  readonly right?: unknown;
  /** Step or outcome ID taken when the condition holds. */
  readonly then: string;
  /** Step or outcome ID taken when it does not. Required: no implicit fallthrough. */
  readonly otherwise: string;
}

export interface ApprovalStep extends WorkflowStepBase {
  readonly kind: "approval";
  readonly title: string;
  readonly message: string;
  readonly on_approved: string;
  readonly on_declined: string;
}

/** Terminal state. Every path through a workflow ends at one of these. */
export interface OutcomeStep extends WorkflowStepBase {
  readonly kind: "outcome";
  /** Must be declared in the manifest's `outcomes` list. */
  readonly outcome: string;
  readonly status: "succeeded" | "inconclusive" | "blocked" | "failed";
  /** References to evidence gathered during the run. */
  readonly evidence?: readonly string[];
}

export type WorkflowStep = AgentStep | CommandStep | ConditionStep | ApprovalStep | OutcomeStep;

export interface WorkflowDefinition {
  readonly schema_version: string;
  /** ID of the first step. */
  readonly start: string;
  readonly steps: readonly WorkflowStep[];
}

/** A duration string the schema accepts: `30s`, `10m`, `2h`. */
export const DURATION_PATTERN = /^(\d+)(ms|s|m|h)$/;

export function parseDuration(value: string): number | undefined {
  const match = DURATION_PATTERN.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  switch (match[2]) {
    case "ms":
      return amount;
    case "s":
      return amount * 1000;
    case "m":
      return amount * 60_000;
    case "h":
      return amount * 3_600_000;
    default:
      return undefined;
  }
}

/** Upper bound on any declared step timeout, so a package cannot opt out of bounding. */
export const MAX_STEP_TIMEOUT_MS = 30 * 60_000;
/** Upper bound on a whole workflow run. */
export const MAX_WORKFLOW_TIMEOUT_MS = 60 * 60_000;
/** Hard cap on step transitions, so a cyclic package cannot loop forever. */
export const MAX_STEP_TRANSITIONS = 64;
