/**
 * The workflow interpreter (REQ-BEH-002, REQ-RUN-001, REQ-SAFE-007).
 *
 * One engine for every behavior. There is no behavior name in this file and
 * none may be added: the moment the interpreter knows what
 * `fix-failing-test` is, acceptance criterion 1 is lost and a new behavior
 * needs TypeScript again.
 *
 * Provider-neutral by rule (REQ-RUN-004). Agent invocation and approval are
 * injected ports; the Pi/OMP adapter supplies them. Nothing here imports a
 * host type or knows how a model is reached.
 *
 * Bounding is not advisory. Every step has a timeout, every agent step an
 * attempt budget and an output cap, the whole run a transition cap and a
 * global deadline, and cancellation propagates through an AbortSignal the
 * ports are required to honour. A workflow that exceeds any of them ends at a
 * terminal failure state; it does not continue with a warning.
 */

import {
  AgentStep,
  ApprovalStep,
  CommandStep,
  ConditionStep,
  MAX_STEP_TRANSITIONS,
  MAX_WORKFLOW_TIMEOUT_MS,
  OutcomeStep,
  WorkflowDefinition,
  WorkflowStep,
  parseDuration,
} from "./schema";
import { ReferenceScope, resolveValue } from "./references";
import { BehaviorAuthority, CommandRegistry } from "../cqrs/command-registry";
import { CommandResult } from "../cqrs/command-contract";
import { BehaviorEvent } from "../events";

/** A bounded agent invocation, supplied by the host adapter. */
export interface AgentPort {
  invoke(request: {
    readonly prompt: string;
    readonly tools: readonly string[];
    readonly expect: "json" | "text";
    readonly maxOutputBytes: number;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
    readonly behavior: string;
    readonly stepId: string;
  }): Promise<{ readonly ok: true; readonly reply: string } | { readonly ok: false; readonly reason: string }>;
}

export interface ApprovalPort {
  request(input: {
    readonly title: string;
    readonly message: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly approved: boolean; readonly reason: string }>;
}

/** Loads a package-relative asset. Called per invocation, so edits take effect. */
export type PromptLoader = (relativePath: string) => string | undefined;

export type StepStatus = "completed" | "failed" | "skipped";

export interface StepRecord {
  readonly stepId: string;
  readonly kind: WorkflowStep["kind"];
  readonly status: StepStatus;
  readonly detail: string;
  readonly startedAt: string;
  readonly endedAt: string;
  /** Structured value bound into `${steps.<id>}` for later references. */
  readonly output?: unknown;
}

export type TerminalState = "succeeded" | "inconclusive" | "blocked" | "failed" | "cancelled";

export interface WorkflowRunResult {
  readonly behavior: string;
  readonly behaviorDigest: string;
  readonly terminal: TerminalState;
  /** Declared outcome name when the run reached an `outcome` step. */
  readonly outcome?: string;
  readonly reason: string;
  readonly steps: readonly StepRecord[];
  readonly evidence: readonly string[];
  readonly correlationId: string;
}

export interface WorkflowRunOptions {
  readonly behavior: string;
  readonly behaviorDigest: string;
  readonly workflow: WorkflowDefinition;
  readonly event: BehaviorEvent;
  readonly registry: CommandRegistry;
  readonly authority: BehaviorAuthority;
  readonly agent: AgentPort;
  readonly approval?: ApprovalPort;
  readonly loadPrompt: PromptLoader;
  readonly workspaceRoot: string;
  /**
   * The behavior's declared `execution.test_command`, exposed to the workflow
   * as `${behavior.testCommand}`.
   *
   * Threaded rather than duplicated into the workflow's own args: a package
   * that spells its verification command twice can spell it two different
   * ways, and then "the suite that was verified" and "the suite that failed"
   * quietly diverge.
   */
  readonly testCommand?: string;
  /** Whole-run bound; defaults to the behavior's policy timeout. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly log?: (entry: Record<string, unknown>) => void;
  readonly now?: () => string;
}

const DEFAULT_STEP_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

export async function runWorkflow(options: WorkflowRunOptions): Promise<WorkflowRunResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const log = options.log ?? (() => undefined);
  const correlationId = options.event.id;
  const steps = new Map(options.workflow.steps.map((s) => [s.id, s]));
  const order = options.workflow.steps.map((s) => s.id);
  const records: StepRecord[] = [];
  const outputs: Record<string, unknown> = {};
  const evidence: string[] = [];

  const runDeadline = Math.min(options.timeoutMs ?? MAX_WORKFLOW_TIMEOUT_MS, MAX_WORKFLOW_TIMEOUT_MS);
  const controller = new AbortController();
  // Chained rather than replaced: a caller cancelling the session must cancel
  // in-flight step work, and a run that exceeds its own deadline must do the
  // same to its children. Both funnel into one signal the ports honour.
  const onExternalAbort = (): void => controller.abort();
  // An already-aborted signal never fires `abort` again, so subscribing to it
  // is not enough: a run started inside a session the caller had already
  // cancelled would see a clear signal, invoke agents and execute commands,
  // and only stop when its own deadline expired. Cancellation has to fail
  // closed on entry, not merely on the transition.
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  const runTimer = setTimeout(() => controller.abort(), runDeadline);

  // One wording for one fact, used by every exit that observes the abort, so
  // the terminal reason cannot disagree with itself depending on where the
  // run noticed.
  const cancellationReason = (): string =>
    options.signal?.aborted ? "cancelled by the caller" : `workflow exceeded its ${runDeadline}ms budget`;

  const finish = (terminal: TerminalState, reason: string, outcome?: string): WorkflowRunResult => {
    clearTimeout(runTimer);
    options.signal?.removeEventListener("abort", onExternalAbort);
    log({ kind: "workflow-end", behavior: options.behavior, terminal, outcome, reason });
    return {
      behavior: options.behavior,
      behaviorDigest: options.behaviorDigest,
      terminal,
      outcome,
      reason,
      steps: records,
      evidence,
      correlationId,
    };
  };

  const scope = (): ReferenceScope => ({
    event: options.event,
    steps: outputs,
    behavior: {
      name: options.behavior,
      digest: options.behaviorDigest,
      testCommand: options.testCommand,
    },
    workspace: { root: options.workspaceRoot },
  });

  let current: string | undefined = options.workflow.start;
  let transitions = 0;

  while (current) {
    if (controller.signal.aborted) return finish("cancelled", cancellationReason());

    transitions += 1;
    if (transitions > MAX_STEP_TRANSITIONS) {
      // A cyclic package is a package error, not a runtime one, but it must
      // terminate regardless of which. REQ-SAFE-007 forbids unbounded loops
      // without qualification.
      return finish("failed", `workflow exceeded ${MAX_STEP_TRANSITIONS} step transitions; refusing to continue`);
    }

    const step: WorkflowStep | undefined = steps.get(current);
    if (!step) return finish("failed", `step "${current}" is not declared`);

    const startedAt = now();
    log({ kind: "workflow-step", behavior: options.behavior, step: step.id, stepKind: step.kind });

    const stepTimeout = step.timeout ? (parseDuration(step.timeout) ?? DEFAULT_STEP_TIMEOUT_MS) : DEFAULT_STEP_TIMEOUT_MS;

    let transition: Transition;
    switch (step.kind) {
      case "agent":
        transition = await runAgentStep(step, {
          scope: scope(),
          port: options.agent,
          loadPrompt: options.loadPrompt,
          behavior: options.behavior,
          stepTimeout,
          signal: controller.signal,
        });
        break;
      case "command":
        transition = await runCommandStep(step, {
          scope: scope(),
          registry: options.registry,
          authority: options.authority,
          correlationId,
          signal: controller.signal,
        });
        break;
      case "condition":
        transition = runConditionStep(step, scope());
        break;
      case "approval":
        transition = await runApprovalStep(step, {
          scope: scope(),
          port: options.approval,
          signal: controller.signal,
        });
        break;
      case "outcome":
        transition = runOutcomeStep(step, scope());
        break;
    }

    records.push({
      stepId: step.id,
      kind: step.kind,
      status: transition.status,
      detail: transition.detail,
      startedAt,
      endedAt: now(),
      output: transition.output,
    });
    if (transition.output !== undefined) outputs[step.id] = transition.output;
    if (transition.evidence) evidence.push(...transition.evidence);

    if (transition.kind === "terminal") {
      return finish(transition.terminal, transition.detail, transition.outcome);
    }

    // A step that failed because the run was cancelled is a cancellation, not
    // a behavior failure, and the ports are *required* to honour the signal —
    // so without this check the port that obeys the contract is the one that
    // produces the dishonest terminal state. It also removed a split verdict:
    // the same Ctrl-C reported `cancelled` when the step happened to declare
    // `on_failure` (the loop re-checks at the top) and `failed` when it did
    // not, telling the operator the behavior had tried and lost.
    if (controller.signal.aborted) return finish("cancelled", cancellationReason());

    if (transition.kind === "failed") {
      if (step.on_failure) {
        current = step.on_failure;
        continue;
      }
      // No declared failure branch means the workflow stops here. Continuing
      // to the next step would run it with a missing binding and produce a
      // second, less informative failure.
      return finish("failed", `step "${step.id}" failed and declares no on_failure: ${transition.detail}`);
    }

    if (transition.next) {
      current = transition.next;
      continue;
    }

    const index = order.indexOf(step.id);
    current = index >= 0 && index + 1 < order.length ? order[index + 1] : undefined;
    if (!current) {
      return finish("failed", `step "${step.id}" completed but no step follows it and no outcome was reached`);
    }
  }

  return finish("failed", "workflow ended without reaching an outcome step");
}

type Transition =
  | { kind: "next"; status: StepStatus; detail: string; next?: string; output?: unknown; evidence?: string[] }
  | { kind: "failed"; status: "failed"; detail: string; output?: unknown; evidence?: string[] }
  | {
      kind: "terminal";
      status: StepStatus;
      terminal: TerminalState;
      outcome?: string;
      detail: string;
      output?: unknown;
      evidence?: string[];
    };

async function runAgentStep(
  step: AgentStep,
  deps: {
    scope: ReferenceScope;
    port: AgentPort;
    loadPrompt: PromptLoader;
    behavior: string;
    stepTimeout: number;
    signal: AbortSignal;
  },
): Promise<Transition> {
  // Loaded per invocation, not cached at activation: REQ-BEH-003 requires a
  // prompt edit to take effect without a rebuild, and a cache would make the
  // running text differ from the text on disk.
  const template = deps.loadPrompt(step.prompt);
  if (template === undefined) {
    return { kind: "failed", status: "failed", detail: `prompt file '${step.prompt}' is missing or unreadable` };
  }

  let prompt = template;
  for (const [key, value] of Object.entries(step.inputs ?? {})) {
    const resolved = resolveValue(deps.scope, value);
    if (!resolved.ok) {
      return { kind: "failed", status: "failed", detail: `input '${key}': ${resolved.reason}` };
    }
    const rendered = typeof resolved.value === "string" ? resolved.value : JSON.stringify(resolved.value);
    prompt = prompt.split(`{{${key}}}`).join(rendered);
  }

  const maxOutputBytes = step.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const attempts = step.attempts ?? 1;
  let lastReason = "no attempt was made";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (deps.signal.aborted) return { kind: "failed", status: "failed", detail: "cancelled" };

    const reply = await deps.port.invoke({
      prompt,
      tools: step.tools,
      expect: step.expect,
      maxOutputBytes,
      timeoutMs: deps.stepTimeout,
      signal: deps.signal,
      behavior: deps.behavior,
      stepId: step.id,
    });

    if (!reply.ok) {
      lastReason = reply.reason;
      continue;
    }
    if (Buffer.byteLength(reply.reply, "utf8") > maxOutputBytes) {
      lastReason = `reply exceeded max_output_bytes (${maxOutputBytes})`;
      continue;
    }

    if (step.expect === "text") {
      return { kind: "next", status: "completed", detail: `attempt ${attempt} returned text`, output: { text: reply.reply } };
    }

    const parsed = parseJsonReply(reply.reply);
    if (!parsed.ok) {
      // A reply that claims success in prose fails here, which is the point.
      // The step's contract is a structured result; prose is not a result.
      lastReason = parsed.reason;
      continue;
    }
    return {
      kind: "next",
      status: "completed",
      detail: `attempt ${attempt} returned a valid JSON reply`,
      output: parsed.value,
    };
  }

  return { kind: "failed", status: "failed", detail: `agent step exhausted ${attempts} attempt(s): ${lastReason}` };
}

function parseJsonReply(reply: string): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  const blocks: string[] = [];
  for (const match of reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) blocks.push(match[1]);
  if (blocks.length === 0) blocks.push(reply);

  for (const block of blocks) {
    try {
      const parsed: unknown = JSON.parse(block.trim());
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return { ok: true, value: parsed as Record<string, unknown> };
      }
    } catch {
      continue;
    }
  }
  return { ok: false, reason: "reply contained no JSON object satisfying the step's response contract" };
}

async function runCommandStep(
  step: CommandStep,
  deps: {
    scope: ReferenceScope;
    registry: CommandRegistry;
    authority: BehaviorAuthority;
    correlationId: string;
    signal: AbortSignal;
  },
): Promise<Transition> {
  const resolved = resolveValue(deps.scope, step.args ?? {});
  if (!resolved.ok) {
    return { kind: "failed", status: "failed", detail: `arguments could not be resolved: ${resolved.reason}` };
  }

  // The same `execute()` a Pi tool call reaches. There is no workflow-only
  // entry point, and adding one would recreate the split Phase 0 removed.
  const result: CommandResult = await deps.registry.execute({
    request: {
      command: step.command,
      args: resolved.value as Record<string, unknown>,
      via: "workflow-step",
      behavior: deps.authority.name,
      correlationId: deps.correlationId,
    },
    authority: deps.authority,
    signal: deps.signal,
  });

  const output = {
    status: result.status,
    result: (result as { result?: unknown }).result,
    reason: (result as { reason?: string }).reason,
    proposalRef: (result as { proposalRef?: string }).proposalRef,
    emitted: result.emitted,
  };
  const evidenceRefs = result.evidence.map((e) => `${e.kind}:${e.ref}`);

  if (result.status === "completed" || result.status === "accepted") {
    return {
      kind: "next",
      status: "completed",
      detail: `command ${step.command} -> ${result.status}`,
      output,
      evidence: evidenceRefs,
    };
  }

  // A denial is a real answer, and a workflow that declares an `on_failure`
  // branch is entitled to handle it. What it must not do is proceed as though
  // the command had succeeded, which is why `output.status` carries the real
  // status into any later condition.
  return {
    kind: "failed",
    status: "failed",
    detail: `command ${step.command} -> ${result.status}: ${(result as { reason?: string }).reason ?? ""}`,
    output,
    evidence: evidenceRefs,
  };
}

function runConditionStep(step: ConditionStep, scope: ReferenceScope): Transition {
  const left = resolveValue(scope, step.left);
  const exists = left.ok && left.value !== undefined && left.value !== null;

  let holds: boolean;
  switch (step.operator) {
    case "exists":
      holds = exists;
      break;
    case "not_exists":
      holds = !exists;
      break;
    case "equals":
      holds = exists && left.value === step.right;
      break;
    case "not_equals":
      holds = !exists || left.value !== step.right;
      break;
    case "in":
      holds = exists && Array.isArray(step.right) && step.right.includes(left.value);
      break;
    default:
      return { kind: "failed", status: "failed", detail: `unsupported operator "${String(step.operator)}"` };
  }

  // An unresolvable reference under a value-comparing operator is a package
  // bug, not a `false`. Reporting it as `false` would send the run down the
  // `otherwise` branch and hide the mistake behind plausible behaviour.
  if (!left.ok && step.operator !== "not_exists" && step.operator !== "exists") {
    return { kind: "failed", status: "failed", detail: `condition left-hand side: ${left.reason}` };
  }

  return {
    kind: "next",
    status: "completed",
    detail: `${step.left} ${step.operator} ${JSON.stringify(step.right)} -> ${holds}`,
    next: holds ? step.then : step.otherwise,
    output: { holds },
  };
}

async function runApprovalStep(
  step: ApprovalStep,
  deps: { scope: ReferenceScope; port?: ApprovalPort; signal: AbortSignal },
): Promise<Transition> {
  if (!deps.port) {
    return {
      kind: "next",
      status: "completed",
      detail: "no approval channel configured; treated as declined",
      next: step.on_declined,
      output: { approved: false, reason: "no approval channel configured" },
    };
  }

  const title = resolveValue(deps.scope, step.title);
  const message = resolveValue(deps.scope, step.message);
  if (!title.ok) return { kind: "failed", status: "failed", detail: `'title': ${title.reason}` };
  if (!message.ok) return { kind: "failed", status: "failed", detail: `'message': ${message.reason}` };

  const decision = await deps.port.request({
    title: String(title.value),
    message: String(message.value),
    signal: deps.signal,
  });

  // Both branches are real branches. A live run once recorded "declined by
  // user" for an approval the operator had granted, because the reply shape
  // did not match what the host read — so the accepted path is exercised by
  // tests here, not assumed to work because the denied one does.
  return {
    kind: "next",
    status: "completed",
    detail: decision.approved ? `approved: ${decision.reason}` : `declined: ${decision.reason}`,
    next: decision.approved ? step.on_approved : step.on_declined,
    output: { approved: decision.approved, reason: decision.reason },
  };
}

function runOutcomeStep(step: OutcomeStep, scope: ReferenceScope): Transition {
  const evidence: string[] = [];
  for (const ref of step.evidence ?? []) {
    const resolved = resolveValue(scope, ref);
    evidence.push(resolved.ok ? String(resolved.value) : `${ref} (unresolved: ${resolved.reason})`);
  }
  return {
    kind: "terminal",
    status: "completed",
    terminal: step.status,
    outcome: step.outcome,
    detail: `reached outcome "${step.outcome}" with status ${step.status}`,
    evidence,
    output: { outcome: step.outcome, status: step.status },
  };
}
