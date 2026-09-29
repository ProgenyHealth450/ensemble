import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  ToolRegistry,
  InMemoryEventSink,
  echoTool,
  EventSink,
  ApprovalGate,
  ApprovalHost,
  BashApprovalPolicy,
  createEnsembleBashTool,
  BASH_APPROVAL_CHOICES,
  answerFromChoice,
  AgentPort,
  BUILTIN_COMMAND_CAPABILITIES,
  WriteBoundaryMonitor,
  createCommandCatalog,
} from "@sunstone-partners/ensemble-agent-core";
import { wireSessionLifecycle } from "./session";
import { handleEchoToolCall } from "./echo-tool-handler";
import { activateBehaviorPipeline, resolveRepoRoot, BehaviorActivationResult } from "./behavior-activation";
import { createWorkflowDispatcher, DispatchRecord } from "./workflow-dispatch";
import { createAgentPort } from "./agent-port";
import { logRuntime, runtimeLogPath, setRuntimeLoggingArmed, isRuntimeLoggingArmed } from "./runtime-log";
import { SessionUiBridge } from "./session-ui";
import { renderStatusReport } from "./runtime-status";
import { execFileSync } from "node:child_process";
import { beginBehaviorScope, endBehaviorScope } from "./tool-grant-enforcement";
import { InvocationBudget } from "./invocation-budget";

/**
 * Capability check for AC-004-2: this extension only depends on `pi.on`
 * (lifecycle subscription), `pi.registerTool` (tool registration), and
 * per-call `AbortSignal` (cancellation), all present in
 * @earendil-works/pi-coding-agent's ExtensionAPI as of the pinned peer range
 * (>=0.87.0). If a future Pi version drops one, this throws instead of
 * silently degrading, so the gap is visible rather than papered over with a
 * fork.
 */
function assertRequiredCapabilities(pi: ExtensionAPI): void {
  if (typeof pi.registerTool !== "function") {
    throw new Error(
      "BLOCKING GAP: pi.registerTool is unavailable in this Pi version; " +
        "the behavior runtime cannot register governed tools without it. " +
        "Do not fork Pi to add it — escalate for an explicitly approved, " +
        "minimal upstreamable change instead.",
    );
  }
  if (typeof pi.on !== "function") {
    throw new Error(
      "BLOCKING GAP: pi.on (lifecycle subscription) is unavailable in this " +
        "Pi version; escalate rather than forking Pi's agent loop.",
    );
  }
}

/**
 * Builds one extension activation instance with its own event sink, exposed
 * for scripted end-to-end proofs and tests. Pi itself only ever calls the
 * default-exported `activate` below.
 */
export interface ActivateOptions {
  /**
   * Approval host. Absent means no UI, and ApprovalGate fails closed, so an
   * approval-requiring command is declined rather than auto-applied.
   */
  approvalHost?: ApprovalHost;
  /**
   * The model port a workflow's `agent` steps invoke. Defaults to a contained
   * subprocess (see agent-port.ts); injectable so tests need not spawn.
   */
  agent?: AgentPort;
  /** Overrides the command catalog; tests supply deterministic handlers. */
  catalog?: ReturnType<typeof createCommandCatalog>;
  /** Caps behavior invocations per issue and per session. */
  budget?: InvocationBudget;
  now?: () => string;
}

/**
 * Waits for out-of-band dispatches to settle.
 *
 * Dispatch cannot be awaited inside the event handler (Pi kills handlers at
 * 30s), so tests and shutdown need an explicit join point. Loops because a
 * settling dispatch can enqueue another.
 */
export async function drainDispatches(): Promise<void> {
  while (trackedDispatches && trackedDispatches.size > 0) {
    await Promise.allSettled([...trackedDispatches]);
  }
}

let trackedDispatches: Set<Promise<void>> | undefined;
let monitor: WriteBoundaryMonitor | undefined;

export function createActivate(options: ActivateOptions = {}): {
  activate: (pi: ExtensionAPI) => void;
  sink: InMemoryEventSink;
  lastActivation: () => BehaviorActivationResult | null;
  runRecords: DispatchRecord[];
} {
  const runRecords: DispatchRecord[] = [];
  const uiBridge = new SessionUiBridge();
  const sink = new InMemoryEventSink();
  let lastActivation: BehaviorActivationResult | null = null;

  const activate = (pi: ExtensionAPI): void => {
    assertRequiredCapabilities(pi);

    const repoRoot = resolveRepoRoot(process.cwd());
    const sessionId = `pi-${Date.now()}`;
    const executionId = `exec-${Date.now()}`;

    // --- ONE DISPATCH PATH ------------------------------------------------
    //
    // Every published event is forwarded to the sink and then offered to the
    // matcher, which runs the matched behavior's declared workflow. That is
    // the whole of dispatch.
    //
    // What used to sit beside it, and no longer does: a continuation queue
    // that called `pi.sendUserMessage` so the USER'S OWN agent performed the
    // repair. It bypassed MutationGuard entirely, because no write passed
    // through it. Both paths ran for the same event, and the outcome was
    // observed live — the governed path logged
    //   rejected: behavior "fix-failing-test" runs in mode: propose
    // while the continuation repaired the same file in the same run. Because
    // the continuation always "worked", the governed path being dead for three
    // days was invisible.
    //
    // It also rolled back by whole-tree `git checkout -- .` plus a re-applied
    // snapshot patch, which is how it destroyed concurrent edits (REQ-SAFE-005).
    //
    // §7 forbids keeping both behind a flag, so the continuation is gone
    // rather than defaulted off. A behavior that wants a model now gets one
    // through a workflow `agent` step, whose invocation is contained and whose
    // output is a candidate, not an edit.
    const pendingDispatches = new Set<Promise<void>>();
    trackedDispatches = pendingDispatches;

    const dispatchingSink: EventSink = {
      async publish(envelope) {
        await sink.publish(envelope);
        logRuntime(repoRoot, {
          kind: "event",
          type: envelope.event.type,
          payload: envelope.event.payload,
        });
        const matcher = lastActivation?.matcher;
        if (!matcher) return;

        // NOT awaited. The host stops waiting on a handler after 30s and
        // blocks the tool as a fail-safe; the handler keeps running, so a slow
        // dispatch would cost the user their tool call. Tracked rather than
        // fire-and-forget so the run is visible in status, its outcome is
        // always logged, and a rejection cannot become an unhandled one.
        const run = (async () => {
          const matched = matcher.matchNames(envelope.event);
          if (matched.length === 0) return;
          // The behaviors' grants apply for the duration of their own work and
          // are released in `finally` — a crashed run must never strand the
          // user in a narrowed session.
          beginBehaviorScope(pi, matched);
          try {
            const invoked = await matcher.onEvent(envelope.event);
            if (invoked.length > 0) {
              logRuntime(repoRoot, { kind: "dispatch", type: envelope.event.type, invoked });
            }
          } catch (error) {
            // A behavior invocation must never break the event pipeline.
            lastActivation?.invocationErrors.push({
              behavior: "(dispatch)",
              reason: (error as Error).message,
            });
            logRuntime(repoRoot, { kind: "error", dispatchError: (error as Error).message });
          } finally {
            endBehaviorScope(pi);
          }
        })();

        pendingDispatches.add(run);
        void run.finally(() => pendingDispatches.delete(run));
      },
    };

    // Fail-safe: a crashed or aborted run must never strand the user in a
    // narrowed session.
    pi.on("agent_end", async () => {
      endBehaviorScope(pi);
      return undefined;
    });
    pi.on("session_shutdown", async () => {
      endBehaviorScope(pi);
      return undefined;
    });

    // Effect-based write boundary. Defence in depth, explicitly NOT a sandbox
    // (REQ-SAFE-004): it detects and reverts changes to protected paths after
    // a tool call has already made them. It cannot prevent a write, and
    // nothing here should be read as claiming otherwise.
    monitor = new WriteBoundaryMonitor(repoRoot);
    try {
      // Tracked AND untracked. `git ls-files` alone misses exactly the
      // realistic case: a failing test file that was just written and never
      // committed. An uncaptured protected path cannot be reverted, so it
      // would be logged and silently left modified.
      const listed = (args: string[]): string[] =>
        execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).split("\n").filter(Boolean);
      monitor.protectAll([...listed(["ls-files"]), ...listed(["ls-files", "--others", "--exclude-standard"])]);
    } catch {
      // Not a git repo: the monitor degrades to detecting nothing rather than
      // pretending to protect.
    }

    pi.on("tool_result", async () => {
      if (!monitor) return;
      const result = monitor.check();
      for (const v of result.violations) {
        logRuntime(repoRoot, { kind: "error", violation: v });
      }
      if (result.violations.length > 0) {
        // Rewrites the tool result the model sees, so the revert is visible to
        // it rather than silently undone behind its back.
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                "Write boundary violation: " +
                result.violations
                  .map((v: { path: string; reason: string; restored: boolean }) =>
                    v.restored
                      ? `${v.path} (${v.reason}) was reverted`
                      : `${v.path} (${v.reason}) was modified and could NOT be reverted (no pristine copy)`,
                  )
                  .join("; ") +
                ". Protected paths cannot be modified by any means, including shell redirects. " +
                "Fix the source under test instead.",
            },
          ],
        };
      }
      return undefined;
    });

    wireSessionLifecycle(pi, dispatchingSink, {
      onContext: (ctx) => uiBridge.capture(ctx as never),
      testCommand: () =>
        lastActivation?.compiled
          .map((c) => c.manifest.execution.test_command)
          .find((c): c is string => Boolean(c)),
    });

    // agent-core's ToolRegistry is the enforced grant-denial boundary. The
    // grant source is a registered CLI flag (`--ensemble-tool-grant`), set only
    // at Pi startup outside the LLM's control — not something the agent's own
    // tool-call arguments or prompt content can flip at call time.
    pi.registerFlag("ensemble-tool-grant", {
      description: "Grant the ensemble-managed governed tools for this session",
      type: "boolean",
      default: false,
    });

    const registry = new ToolRegistry();
    registry.register(echoTool);

    pi.registerTool({
      name: echoTool.name,
      label: "Ensemble Echo",
      description: echoTool.description,
      parameters: Type.Object({ message: Type.String({ description: "Message to echo back" }) }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        if (signal?.aborted) throw new Error("cancelled");
        const callSessionId = ctx.sessionManager.getSessionId() ?? "pi-session";
        const granted = pi.getFlag("ensemble-tool-grant") === true;
        return handleEchoToolCall(registry, callSessionId, granted, params.message ?? "");
      },
    });

    const approval = new ApprovalGate(options.approvalHost ?? uiBridge);

    // The default model port. Contained at the OS level — throwaway HOME,
    // isolated worktree — because the tool allowlist provably does not contain
    // it (br-33co).
    const agent =
      options.agent ??
      createAgentPort({
        repoRoot,
        log: (entry) => logRuntime(repoRoot, entry),
      });

    const dispatcher = createWorkflowDispatcher({
      rootDir: repoRoot,
      sessionId,
      executionId,
      compiled: () => lastActivation?.compiled ?? [],
      packageDirFor: (name) => lastActivation?.packageDirs?.get(name),
      agent,
      approval,
      // Handler-emitted facts re-enter the same sink the host's own events
      // use, so a behavior can react to `fix.verified` rather than guessing
      // from `test.failure.observed`. Bounded by InvocationBudget: composition
      // is wanted, recursion is not.
      publish: async (event, acceptance) => {
        logRuntime(repoRoot, { kind: "emit", type: event.type, acceptance: acceptance.scope });
        await dispatchingSink.publish({
          event,
          receivedAt: new Date().toISOString(),
          metadata: { acceptance: acceptance.scope, guarantees: acceptance.guarantees },
        });
      },
      catalog: options.catalog,
      budget: options.budget,
      now: options.now,
      records: runRecords,
      log: (entry) => logRuntime(repoRoot, entry),
    });

    // `ensemble.bash` is offered alongside echo. It only constrains anything
    // for a behavior that omits native `bash` from capabilities.tools — grant
    // enforcement is what removes the alternative.
    //
    // The four answers come from Pi's `ui.select`, not `ui.confirm`: confirm is
    // boolean and would silently collapse allow-always and deny-always into
    // nothing. A dismissed dialog returns undefined and is treated as
    // deny-once — never as a default yes.
    const bashPolicy = new BashApprovalPolicy(
      uiBridge.canSelect
        ? async (command: string) => {
            const answer = await uiBridge.select(`Run shell command?\n${command}`, [
              BASH_APPROVAL_CHOICES["allow-once"],
              BASH_APPROVAL_CHOICES["allow-always"],
              BASH_APPROVAL_CHOICES["deny-once"],
              BASH_APPROVAL_CHOICES["deny-always"],
            ]);
            return answerFromChoice(answer);
          }
        : undefined,
    );

    // A one-shot `omp -p` exits as soon as the turn ends, which would kill an
    // in-flight dispatch. Join at shutdown so background work is not silently
    // discarded. Still bounded by the host's handler timeout.
    pi.on("session_shutdown", async () => {
      await drainDispatches();
    });

    lastActivation = activateBehaviorPipeline(
      pi,
      repoRoot,
      [echoTool, createEnsembleBashTool({ cwd: repoRoot, policy: bashPolicy })],
      undefined,
      dispatcher.invoke,
      {
        knownCommands: dispatcher.commandIds,
        commandCapability: (id) => BUILTIN_COMMAND_CAPABILITIES[id],
      },
    );

    // An operator must be able to ask whether any of this is alive. Without
    // it, a silent fail-closed runtime is indistinguishable from one that
    // never loaded.
    pi.registerCommand("ensemble-status", {
      description: "Report ensemble behavior-runtime status for this session",
      handler: async (_args, ctx) => {
        uiBridge.capture(ctx as never);
        const text = renderStatusReport({
          activation: lastActivation,
          eventsSeen: sink.peek().length,
          records: runRecords,
          dispatchesInFlight: pendingDispatches.size,
          commandIds: dispatcher.commandIds,
          approvalChannel: uiBridge.hasUI
            ? "live (ui.confirm)"
            : "unavailable - approval-gated commands fail closed",
          agentContainment:
            "describeContainment" in agent
              ? (agent as { describeContainment(): string }).describeContainment()
              : "custom agent port (containment unknown)",
          logPath: isRuntimeLoggingArmed() ? runtimeLogPath(repoRoot) : undefined,
        });
        if (ctx.hasUI && ctx.ui?.notify) ctx.ui.notify(text);
        else console.log(text);
      },
    });

    // Arm logging only once behaviours exist here. The extension loads in
    // every session, so an unconditional write created a stray
    // .ensemble/runtime-log.jsonl in any directory the user visited.
    setRuntimeLoggingArmed(lastActivation.discovered > 0);
    logRuntime(repoRoot, {
      kind: "activation",
      discovered: lastActivation.discovered,
      loaded: lastActivation.loaded,
      skipped: lastActivation.skipped,
      commands: dispatcher.commandIds,
      hasApprovalHost: Boolean(options.approvalHost),
    });
  };

  return { activate, sink, lastActivation: () => lastActivation, runRecords };
}

const activate: (pi: ExtensionAPI) => void = createActivate().activate;

export default activate;
