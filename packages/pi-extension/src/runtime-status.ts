/**
 * The status report (Story 4.1 / REQ-RUN-003).
 *
 * The requirement is that status distinguish discovered, validated, matched,
 * invoked, pending, completed, failed and skipped — and that every skip reason
 * name the condition that actually fired.
 *
 * That last clause has a cost attached. A live diagnostic once reported
 * "not a git work tree" for a clean clone; the real cause was a single
 * untracked symlink `git hash-object` could not hash. Hours went into the
 * wrong question. A diagnostic that guesses is worse than one that says
 * nothing, so every reason rendered here is passed through from the code that
 * decided, never re-inferred here from what the state looks like.
 *
 * Secrets and prompt/tool contents are never rendered (REQ-RUN-003). Digests
 * and paths are, because "which package actually ran" is the question status
 * exists to answer: an installed bundle once ran three commits behind its
 * checkout and several runs tested code that did not contain the fix.
 */

import { BehaviorActivationResult } from "./behavior-activation";
import { DispatchRecord } from "./workflow-dispatch";

export interface StatusInput {
  readonly activation: BehaviorActivationResult | null;
  readonly eventsSeen: number;
  readonly records: readonly DispatchRecord[];
  readonly dispatchesInFlight: number;
  readonly commandIds: readonly string[];
  readonly approvalChannel: string;
  readonly agentContainment: string;
  readonly logPath?: string;
}

/** The lifecycle states REQ-RUN-003 requires status to distinguish. */
export interface StateCounts {
  readonly discovered: number;
  readonly validated: number;
  readonly matched: number;
  readonly invoked: number;
  readonly pending: number;
  readonly completed: number;
  readonly failed: number;
  readonly skipped: number;
}

export function countStates(input: StatusInput): StateCounts {
  const activation = input.activation;
  const runs = input.records.filter((r) => r.run);
  return {
    discovered: activation?.discovered ?? 0,
    validated: activation?.loaded.length ?? 0,
    // Every record exists because the matcher matched; the split below is what
    // happened afterwards.
    matched: input.records.length,
    invoked: runs.length,
    pending: input.dispatchesInFlight,
    completed: runs.filter((r) => r.run?.terminal === "succeeded").length,
    failed: runs.filter((r) => r.run?.terminal === "failed" || r.run?.terminal === "cancelled").length,
    // Skipped covers both activation-time skips and dispatch-time refusals.
    skipped: (activation?.skipped.length ?? 0) + input.records.filter((r) => r.skipped).length,
  };
}

export function renderStatusReport(input: StatusInput): string {
  const a = input.activation;
  const counts = countStates(input);
  const lines: string[] = ["ensemble behavior runtime"];

  lines.push(`  states           : discovered=${counts.discovered} validated=${counts.validated} ` +
    `matched=${counts.matched} invoked=${counts.invoked} pending=${counts.pending} ` +
    `completed=${counts.completed} failed=${counts.failed} skipped=${counts.skipped}`);

  if (!a) {
    lines.push("  activation       : NOT ACTIVATED");
    return lines.join("\n");
  }

  lines.push("  behaviors:");
  if (a.loaded.length === 0) lines.push("    (none loaded)");
  for (const name of a.loaded) {
    const compiled = a.compiled.find((c) => c.manifest.metadata.name === name);
    const dir = a.packageDirs?.get(name);
    lines.push(`    ${name}`);
    // The ACTIVE path and digest, together, are what make "which code ran"
    // answerable. Reporting one without the other is not enough: a stale
    // bundle has the right path and the wrong content.
    lines.push(`      active path  : ${dir ?? "(unknown)"}`);
    lines.push(`      manifest     : ${compiled?.digest ?? "(unknown)"}`);
    lines.push(`      package      : ${compiled?.manifest.metadata.packageDigest ?? "(not computed)"}`);
    lines.push(
      `      workflow     : ${
        compiled?.workflow
          ? `${compiled.workflow.steps.length} step(s), start=${compiled.workflow.start}`
          : "(none declared - this behavior cannot be dispatched)"
      }`,
    );
    lines.push(`      mode         : ${compiled?.manifest.policy.mode ?? "(unknown)"}`);
    lines.push(`      commands     : ${compiled?.commands.join(", ") || "(none declared)"}`);
  }

  if (a.skipped.length > 0) {
    lines.push("  skipped at activation:");
    for (const s of a.skipped) lines.push(`    ${s.behaviorId}: ${s.reason}`);
  }

  const skippedRuns = input.records.filter((r) => r.skipped);
  if (skippedRuns.length > 0) {
    lines.push("  skipped at dispatch:");
    for (const r of skippedRuns) lines.push(`    ${r.behavior} on ${r.event}: ${r.skipped}`);
  }

  const last = [...input.records].reverse().find((r) => r.run);
  if (last?.run) {
    lines.push(`  last run         : ${last.behavior} -> ${last.run.terminal}` +
      (last.run.outcome ? ` (${last.run.outcome})` : "") + `: ${last.run.reason}`);
    for (const step of last.run.steps) {
      lines.push(`      ${step.stepId} [${step.kind}] ${step.status}: ${step.detail}`);
    }
  }

  lines.push(`  events seen      : ${input.eventsSeen}`);
  lines.push(`  commands         : ${input.commandIds.join(", ") || "(none registered)"}`);
  lines.push(`  approval channel : ${input.approvalChannel}`);
  lines.push(`  agent containment: ${input.agentContainment}`);
  // Stated in full every time. "Local" is the only acceptance this runtime can
  // produce, and a reader who assumes otherwise assumes durable scheduling,
  // retries and recovery that do not exist here (REQ-CQRS-006).
  lines.push(
    "  acceptance       : local only - this session and its local evidence log. " +
      "No durable delivery, scheduling, retry, replay, recovery or production approval is implied.",
  );
  lines.push(
    `  log              : ${input.logPath ?? "(none - no behaviors here, so nothing is written to this repo)"}`,
  );

  return lines.join("\n");
}
