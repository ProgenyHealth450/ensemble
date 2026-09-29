/**
 * Static validation of package workflow data (REQ-BEH-004, Story 2.1).
 *
 * Everything checkable before invocation is checked before invocation, and a
 * failure names the behavior and the step. The list of what gets checked comes
 * from a specific failure mode rather than from a desire for completeness:
 *
 *   a behavior's own `fix-prompt.md` silently replaced the entire prompt,
 *   including the response contract the runtime depended on, because loading
 *   was `template ?? default` with no check that the result still satisfied
 *   anything. The run then reported "no candidate offered" — a package error
 *   presented as a model failure.
 *
 * The lesson generalises: validate what a package REPLACES, not only what it
 * adds. So prompt references are resolved and read, agent steps must declare a
 * response contract, and a step's tool grant is checked against its behavior's
 * grant rather than assumed to be a subset.
 */

import {
  AgentStep,
  ApprovalStep,
  CommandStep,
  ConditionStep,
  MAX_STEP_TIMEOUT_MS,
  OutcomeStep,
  SUPPORTED_STEP_KINDS,
  WORKFLOW_SCHEMA_VERSION,
  WorkflowDefinition,
  WorkflowStep,
  WorkflowStepKind,
  parseDuration,
} from "./schema";
import { REFERENCE_ROOTS, collectReferences } from "./references";

export interface WorkflowDiagnostic {
  readonly behavior: string;
  /** Step ID, or `(workflow)` for whole-workflow problems. */
  readonly step: string;
  readonly message: string;
}

export interface WorkflowValidationInput {
  readonly behaviorName: string;
  readonly workflow: unknown;
  /** Tools the behavior declares; a step may narrow but never widen. */
  readonly behaviorTools: readonly string[];
  /** Command capabilities the behavior declares. */
  readonly behaviorCommands: readonly string[];
  /** Outcomes the manifest declares. */
  readonly declaredOutcomes: readonly string[];
  /**
   * Registered command IDs. Unknown commands fail closed (REQ-BEH-004).
   *
   * `undefined` means the caller has no registry to check against -- package
   * DISCOVERY runs before one exists -- and the binding check is skipped
   * rather than failed. An empty ARRAY is a different statement: a registry
   * exists and registers nothing, so every binding is genuinely unknown.
   * Conflating the two made discovery reject every workflow that calls a
   * command, which is every useful workflow.
   */
  readonly knownCommands?: readonly string[];
  /** Resolves a package-relative prompt path; returns undefined when missing. */
  readonly readPrompt?: (relativePath: string) => string | undefined;
  /** Capability required by each known command, for the grant check. */
  readonly commandCapability?: (commandId: string) => string | undefined;
}

export interface WorkflowValidationResult {
  readonly valid: boolean;
  readonly diagnostics: readonly WorkflowDiagnostic[];
  /** Present only when valid. */
  readonly workflow?: WorkflowDefinition;
}

export function validateWorkflow(input: WorkflowValidationInput): WorkflowValidationResult {
  const diagnostics: WorkflowDiagnostic[] = [];
  const note = (step: string, message: string): void => {
    diagnostics.push({ behavior: input.behaviorName, step, message });
  };

  const raw = input.workflow;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    note("(workflow)", `execution.workflow must be a mapping, got ${raw === null ? "null" : typeof raw}`);
    return { valid: false, diagnostics };
  }

  const candidate = raw as Record<string, unknown>;

  if (candidate.schema_version !== WORKFLOW_SCHEMA_VERSION) {
    // An unrecognised schema version is refused rather than best-effort
    // interpreted: a workflow written against primitives this runtime does not
    // have would otherwise run with those steps quietly absent.
    note(
      "(workflow)",
      `unsupported workflow schema_version ${JSON.stringify(candidate.schema_version)}; this runtime implements ${WORKFLOW_SCHEMA_VERSION}`,
    );
    return { valid: false, diagnostics };
  }

  if (!Array.isArray(candidate.steps) || candidate.steps.length === 0) {
    note("(workflow)", "execution.workflow.steps must be a non-empty array");
    return { valid: false, diagnostics };
  }

  const steps = candidate.steps as Record<string, unknown>[];
  const ids = new Map<string, Record<string, unknown>>();
  for (const step of steps) {
    const id = step.id;
    if (typeof id !== "string" || id.length === 0) {
      note("(workflow)", "every step requires a non-empty string 'id'");
      continue;
    }
    if (ids.has(id)) {
      note(id, "duplicate step id");
      continue;
    }
    ids.set(id, step);
  }

  if (typeof candidate.start !== "string" || !ids.has(candidate.start)) {
    note("(workflow)", `execution.workflow.start must name a declared step; got ${JSON.stringify(candidate.start)}`);
  }

  const targetExists = (target: unknown): boolean => typeof target === "string" && ids.has(target);

  for (const [id, step] of ids) {
    const kind = step.kind;
    if (typeof kind !== "string" || !(SUPPORTED_STEP_KINDS as readonly string[]).includes(kind)) {
      // Explicit rejection, never a silent skip (REQ-BEH-002).
      note(
        id,
        `unsupported step kind ${JSON.stringify(kind)}; this runtime implements [${SUPPORTED_STEP_KINDS.join(", ")}]`,
      );
      continue;
    }

    if (step.timeout !== undefined) {
      if (typeof step.timeout !== "string") {
        note(id, "'timeout' must be a duration string such as '90s'");
      } else {
        const ms = parseDuration(step.timeout);
        if (ms === undefined) note(id, `'timeout' ${JSON.stringify(step.timeout)} is not a duration such as '90s' or '5m'`);
        else if (ms > MAX_STEP_TIMEOUT_MS) {
          note(id, `'timeout' ${step.timeout} exceeds the runtime maximum of ${MAX_STEP_TIMEOUT_MS}ms`);
        } else if (ms <= 0) note(id, "'timeout' must be greater than zero");
      }
    }

    if (step.on_failure !== undefined && !targetExists(step.on_failure)) {
      note(id, `'on_failure' names ${JSON.stringify(step.on_failure)}, which is not a declared step`);
    }

    for (const path of collectReferences(step)) {
      const root = path.split(".")[0];
      if (!(REFERENCE_ROOTS as readonly string[]).includes(root)) {
        note(id, `reference \${${path}} has root "${root}", not one of [${REFERENCE_ROOTS.join(", ")}]`);
        continue;
      }
      if (root === "steps") {
        const referenced = path.split(".")[1];
        if (!referenced || !ids.has(referenced)) {
          note(id, `reference \${${path}} names step "${referenced ?? ""}", which is not declared`);
        }
      }
    }

    // br-n3gj: a field the schema does not define is a typo or a belief about
    // a feature that does not exist, and silence makes the two
    // indistinguishable. `next: some-step` compiled clean in two shipped
    // manifests; the flow was correct only because declaration order happened
    // to match the intent, so reordering steps for readability would have
    // rewired the workflow with no diagnostic at any point. Naming the key and
    // listing what was allowed is the whole fix: the author needs to learn
    // that the field is ignored, which is the one thing the runtime never told
    // them.
    for (const key of Object.keys(step)) {
      if (!isAllowedStepField(kind, key)) {
        note(id, `unknown field ${JSON.stringify(key)} on a '${kind}' step; allowed fields are [${allowedStepFields(kind).join(", ")}]`);
      }
    }

    switch (kind) {
      case "agent":
        validateAgentStep(step as unknown as AgentStep, id, input, note);
        break;
      case "command":
        validateCommandStep(step as unknown as CommandStep, id, input, note);
        break;
      case "condition":
        validateConditionStep(step as unknown as ConditionStep, id, targetExists, note);
        break;
      case "approval":
        validateApprovalStep(step as unknown as ApprovalStep, id, targetExists, note);
        break;
      case "outcome":
        validateOutcomeStep(step as unknown as OutcomeStep, id, input, note);
        break;
    }
  }

  // Every workflow must be able to terminate. A package whose only path runs
  // off the end of the step list has no terminal state, and the interpreter
  // would have to invent one.
  const hasOutcome = [...ids.values()].some((s) => s.kind === "outcome");
  if (!hasOutcome) note("(workflow)", "workflow declares no 'outcome' step, so it has no terminal state");

  const unreachable = findUnreachable(candidate.start as string, ids);
  for (const id of unreachable) {
    note(id, "step is unreachable from 'start'");
  }

  if (diagnostics.length > 0) return { valid: false, diagnostics };
  return {
    valid: true,
    diagnostics,
    workflow: candidate as unknown as WorkflowDefinition,
  };
}


/**
 * The fields each step kind accepts, mirroring schema.ts exactly.
 *
 * This is duplication, and deliberately so: TypeScript interfaces vanish at
 * run time, and a manifest is parsed YAML, not a typed object. There is no way
 * to derive these from the interfaces without a schema library, and adding one
 * to police five step kinds would be a larger commitment than the problem
 * warrants. The cost is that a new field must be added in two places — which
 * a conformance test enforces by failing when they diverge.
 */
const COMMON_STEP_FIELDS = ["id", "kind", "timeout", "on_failure"] as const;

const STEP_FIELDS: Record<WorkflowStepKind, readonly string[]> = {
  agent: ["prompt", "tools", "inputs", "expect", "max_output_bytes", "attempts"],
  command: ["command", "args"],
  condition: ["left", "operator", "right", "then", "otherwise"],
  approval: ["title", "message", "on_approved", "on_declined"],
  outcome: ["outcome", "status", "evidence"],
};

/** Allowed fields for a kind, common ones included, for use in diagnostics. */
export function allowedStepFields(kind: string): readonly string[] {
  const specific = STEP_FIELDS[kind as WorkflowStepKind] ?? [];
  return [...COMMON_STEP_FIELDS, ...specific];
}

function isAllowedStepField(kind: string, key: string): boolean {
  return allowedStepFields(kind).includes(key);
}

type Note = (step: string, message: string) => void;

function validateAgentStep(step: AgentStep, id: string, input: WorkflowValidationInput, note: Note): void {
  if (typeof step.prompt !== "string" || step.prompt.length === 0) {
    note(id, "agent step requires 'prompt' naming a package-relative prompt file");
  } else if (step.prompt.startsWith("/") || step.prompt.split(/[\\/]/).includes("..")) {
    note(id, `'prompt' ${JSON.stringify(step.prompt)} must be a package-relative path without '..'`);
  } else if (input.readPrompt) {
    const contents = input.readPrompt(step.prompt);
    if (contents === undefined) {
      // REQ-BEH-003: a missing required prompt fails activation visibly.
      note(id, `prompt file '${step.prompt}' is missing or unreadable`);
    } else if (contents.trim().length === 0) {
      note(id, `prompt file '${step.prompt}' is empty`);
    }
  }

  if (!Array.isArray(step.tools)) {
    note(id, "agent step requires a 'tools' array (may be empty for a no-tool invocation)");
  } else {
    const behaviorTools = new Set(input.behaviorTools);
    for (const tool of step.tools) {
      if (typeof tool !== "string") {
        note(id, "every entry in 'tools' must be a string");
        continue;
      }
      if (!behaviorTools.has(tool)) {
        // A step widening its behavior's grant would make the manifest's
        // capability list advisory. It is the declaration operators read.
        note(
          id,
          `tool "${tool}" is not in the behavior's capabilities.tools ` +
            `[${input.behaviorTools.join(", ") || "none"}]; a step may narrow a grant but never widen it`,
        );
      }
    }
  }

  if (step.expect !== "json" && step.expect !== "text") {
    note(id, `agent step requires 'expect' of "json" or "text"; got ${JSON.stringify(step.expect)}`);
  }

  if (step.max_output_bytes !== undefined) {
    if (typeof step.max_output_bytes !== "number" || step.max_output_bytes <= 0) {
      note(id, "'max_output_bytes' must be a positive number");
    }
  }
  if (step.attempts !== undefined) {
    if (typeof step.attempts !== "number" || step.attempts < 1 || step.attempts > 3) {
      note(id, "'attempts' must be a number between 1 and 3");
    }
  }
}

function validateCommandStep(step: CommandStep, id: string, input: WorkflowValidationInput, note: Note): void {
  if (typeof step.command !== "string" || step.command.length === 0) {
    note(id, "command step requires 'command' naming a registered command");
    return;
  }
  if (input.knownCommands !== undefined && !input.knownCommands.includes(step.command)) {
    note(
      id,
      `command "${step.command}" is not registered; known commands are [${input.knownCommands.join(", ") || "none"}]`,
    );
    return;
  }
  const capability = input.commandCapability?.(step.command);
  if (capability && !input.behaviorCommands.includes(capability)) {
    note(
      id,
      `command "${step.command}" requires capability "${capability}", which the behavior does not declare ` +
        `(capabilities.commands: [${input.behaviorCommands.join(", ") || "none"}])`,
    );
  }
  if (step.args !== undefined && (typeof step.args !== "object" || step.args === null || Array.isArray(step.args))) {
    note(id, "'args' must be a mapping");
  }
}

function validateConditionStep(
  step: ConditionStep,
  id: string,
  targetExists: (t: unknown) => boolean,
  note: Note,
): void {
  if (typeof step.left !== "string" || step.left.length === 0) {
    note(id, "condition step requires 'left' referencing a validated prior result");
  } else if (!step.left.includes("${")) {
    // A literal on the left means the branch is constant, which is either a
    // mistake or an attempt to encode a decision the package should state
    // directly.
    note(id, `'left' ${JSON.stringify(step.left)} is a literal; a condition must branch on a \${...} reference`);
  }

  const operators = ["equals", "not_equals", "in", "exists", "not_exists"];
  if (!operators.includes(step.operator)) {
    note(id, `unsupported operator ${JSON.stringify(step.operator)}; supported: [${operators.join(", ")}]`);
  }
  if ((step.operator === "equals" || step.operator === "not_equals") && step.right === undefined) {
    note(id, `operator "${step.operator}" requires 'right'`);
  }
  if (step.operator === "in" && !Array.isArray(step.right)) {
    note(id, `operator "in" requires 'right' to be an array`);
  }
  if (!targetExists(step.then)) note(id, `'then' names ${JSON.stringify(step.then)}, which is not a declared step`);
  if (!targetExists(step.otherwise)) {
    note(id, `'otherwise' names ${JSON.stringify(step.otherwise)}, which is not a declared step`);
  }
}

function validateApprovalStep(
  step: ApprovalStep,
  id: string,
  targetExists: (t: unknown) => boolean,
  note: Note,
): void {
  if (typeof step.title !== "string" || step.title.length === 0) note(id, "approval step requires 'title'");
  if (typeof step.message !== "string" || step.message.length === 0) note(id, "approval step requires 'message'");
  if (!targetExists(step.on_approved)) {
    note(id, `'on_approved' names ${JSON.stringify(step.on_approved)}, which is not a declared step`);
  }
  if (!targetExists(step.on_declined)) {
    note(id, `'on_declined' names ${JSON.stringify(step.on_declined)}, which is not a declared step`);
  }
}

function validateOutcomeStep(step: OutcomeStep, id: string, input: WorkflowValidationInput, note: Note): void {
  if (typeof step.outcome !== "string" || step.outcome.length === 0) {
    note(id, "outcome step requires 'outcome'");
    return;
  }
  if (!input.declaredOutcomes.includes(step.outcome)) {
    note(
      id,
      `outcome "${step.outcome}" is not declared in the manifest's outcomes [${input.declaredOutcomes.join(", ") || "none"}]`,
    );
  }
  const statuses = ["succeeded", "inconclusive", "blocked", "failed"];
  if (!statuses.includes(step.status)) {
    note(id, `'status' must be one of [${statuses.join(", ")}]; got ${JSON.stringify(step.status)}`);
  }
}

function findUnreachable(start: string, ids: Map<string, Record<string, unknown>>): string[] {
  if (!ids.has(start)) return [];
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const current = ids.get(queue.shift() as string);
    if (!current) continue;
    const targets: unknown[] = [current.then, current.otherwise, current.on_approved, current.on_declined, current.on_failure];
    // A non-branching step falls through to the next declared step.
    if (current.kind === "agent" || current.kind === "command") {
      const order = [...ids.keys()];
      const index = order.indexOf(current.id as string);
      if (index >= 0 && index + 1 < order.length) targets.push(order[index + 1]);
    }
    for (const target of targets) {
      if (typeof target === "string" && ids.has(target) && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return [...ids.keys()].filter((id) => !seen.has(id));
}

/** Steps a workflow declares, in declaration order. Convenience for status output. */
export function stepIds(workflow: WorkflowDefinition): readonly string[] {
  return workflow.steps.map((s: WorkflowStep) => s.id);
}
