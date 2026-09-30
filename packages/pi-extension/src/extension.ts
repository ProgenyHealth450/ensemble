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
  isAlwaysProtectedPath,
  eventCwd,
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
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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

    // --- BEHAVIOR EXECUTION WINDOW ----------------------------------------
    //
    // Tool grants AND the write boundary widen only while a behavior is
    // executing, and on this runtime that is the dispatch below: grants were
    // already scoped to it (beginBehaviorScope/endBehaviorScope), and the
    // boundary now shares the same window rather than keeping a second one.
    //
    // The boundary is split by REASON, not by timing (br-vjm5; the resolution
    // chosen on dev in c6b93dd). Guardrail sources, the constitution and the
    // conformance fixtures are never ordinary working material, so they are
    // protected for the whole session. Test files and build configuration
    // are the user's working material, so they are protected only inside a
    // window. Arming everything for the whole session, as this file used to,
    // reverted the user's own test edits in every repository the extension
    // loads in -- and once build configuration became protected (br-afik) it
    // would have reverted their package.json and tsconfig edits as well.
    //
    // The baseline for the widened set is taken when the window OPENS, so
    // the user's own changes up to that point (a just-written failing test,
    // a pull) are the state being protected rather than something to revert.
    let windowOpen = false;

    const trackedAndUntracked = (root: string): string[] => {
      // Tracked AND untracked. `git ls-files` alone misses exactly the
      // realistic case: a failing test file that was just written and never
      // committed. An uncaptured protected path cannot be reverted, so it
      // would be logged and silently left modified.
      const listed = (args: string[]): string[] =>
        execFileSync("git", args, { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
      return [...listed(["ls-files"]), ...listed(["ls-files", "--others", "--exclude-standard"])];
    };

    const openBehaviorWindow = (behaviors: readonly string[]): void => {
      beginBehaviorScope(pi, behaviors);
      // A second dispatch can start while the window is already open. Keep
      // the existing baseline: re-arming now would bless whatever the first
      // run's window let land on disk.
      if (windowOpen) return;
      windowOpen = true;
      // The SAME monitor is widened, never replaced. A fresh one would
      // re-baseline every guardrail to its current contents, so a tamper
      // made while the boundary was narrow would be adopted as pristine at
      // window open -- laundering, performed by the boundary itself.
      monitor?.setScope(() => true);
      try {
        monitor?.protectAll(trackedAndUntracked(repoRoot));
      } catch {
        // Not a git repo: stays as narrow as it was.
      }
    };

    // Idempotent, and called on every exit path: a window left open strands
    // the user in a narrowed session with a live write boundary.
    const closeBehaviorWindow = (): void => {
      endBehaviorScope(pi);
      windowOpen = false;
      // Narrowed, NOT disarmed. The user's own files are theirs again the
      // moment the run ends; the guardrails never are. Narrowing in place
      // keeps each guardrail's baseline from activation rather than blessing
      // whatever landed while the window was open.
      monitor?.setScope(isAlwaysProtectedPath);
    };

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
          // The behaviors' grants and the widened write boundary apply for
          // the duration of their own work and are released in `finally` — a
          // crashed run must never strand the user in a narrowed session.
          openBehaviorWindow(matched);
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
            closeBehaviorWindow();
          }
        })();

        pendingDispatches.add(run);
        void run.finally(() => pendingDispatches.delete(run));
      },
    };

    // Fail-safe: a crashed or aborted run must never strand the user in a
    // narrowed session.
    pi.on("agent_end", async () => {
      closeBehaviorWindow();
      return undefined;
    });
    pi.on("session_shutdown", async () => {
      closeBehaviorWindow();
      return undefined;
    });

    // Effect-based write boundary. Defence in depth, explicitly NOT a sandbox
    // (REQ-SAFE-004): it detects and reverts changes to protected paths after
    // a tool call has already made them. It cannot prevent a write, and
    // nothing here should be read as claiming otherwise.
    //
    // Armed NARROW for the whole session (see the window above) and widened
    // in place only while a behavior executes.
    monitor = new WriteBoundaryMonitor(repoRoot, isAlwaysProtectedPath);
    try {
      monitor.protectAll(trackedAndUntracked(repoRoot));
    } catch {
      // Not a git repo: the monitor degrades to detecting nothing rather than
      // pretending to protect.
    }

    // Reverted-but-recoverable protected writes, awaiting an out-of-band
    // decision. In memory only, and never written to disk: a file holding a
    // ready-to-apply guardrail patch is itself an attack surface, and it must
    // not survive the session that produced it.
    //
    // Outlives the window ON PURPOSE. The write is reverted while the boundary
    // is live, but the human answers later, often after the turn has ended --
    // so the entry cannot be scoped to the monitor.
    const quarantine = new Map<string, { path: string; reason: string; contents?: string }>();
    let quarantineSeq = 0;

    pi.on("tool_result", async () => {
      if (!monitor) return undefined;

      // Detect without reverting, so there is still something to ask about.
      // check() reverts as it detects, which made consent impossible: by the
      // time a violation existed, the edit was already gone.
      const found = monitor.pending();
      if (found.length === 0) return undefined;

      // NOTHING is awaited here, deliberately. This is a tool_result handler,
      // and the host kills those at 30_000ms (br-9hv6). A human deciding
      // whether to change a guardrail routinely takes longer, and a handler
      // killed mid-await leaves the file modified but neither approved nor
      // reverted: the one state with no owner. So the write is ALWAYS
      // reverted, immediately, and consent is collected out of band via
      // /ensemble-approve. Fail-closed costs one extra command; awaiting a
      // human costs the guarantee.
      //
      // Every entry is offered. Nothing on this runtime writes into the
      // user's session on a behavior's behalf -- automatic work runs in a
      // contained agent and lands as a proposal -- so a reverted write here
      // came from an ordinary turn, and reverting the maintainer's own edit
      // with no way to reinstate it is a lockout, not protection (br-uavb).
      const offered: string[] = [];
      for (const v of found) {
        let attempted: string | undefined;
        try {
          attempted = readFileSync(resolve(repoRoot, v.path), "utf8");
        } catch {
          // Deleted or unreadable: recorded with no content so
          // /ensemble-approve reports that it cannot reapply the change,
          // rather than writing garbage into a guardrail file.
          attempted = undefined;
        }
        const id = String(++quarantineSeq);
        quarantine.set(id, { path: v.path, reason: v.reason, contents: attempted });
        offered.push(id);
      }

      const result = monitor.check();
      for (const v of result.violations) {
        logRuntime(repoRoot, { kind: "error", violation: v });
      }
      if (result.violations.length === 0) return undefined;

      const offers = offered
        .map((id) => {
          const q = quarantine.get(id)!;
          return q.contents === undefined
            ? ` (${q.path}: the change could not be captured and cannot be re-applied.)`
            : ` To keep the change to ${q.path}, the USER -- not you -- can run: /ensemble-approve ${id}`;
        })
        .join("");

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
              ". Protected paths are reverted by default. " +
              "Fix the source under test instead." +
              offers,
          },
        ],
      };
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

    // Cancellation for everything the dispatcher starts (br-vrzv).
    //
    // Observed in headless runs: the host exited, and the `omp -p` child the
    // governed dispatch had spawned kept running, reparented to PID 1, its
    // result never consumed. Read-only tools, so nothing was written — but it
    // was unowned model spend, and an unowned process is a bad default
    // whatever its grants.
    //
    // Draining alone could not fix it: joining a run waits for a child that
    // has no reason to stop, and the host's handler timeout (2s observed)
    // expires long before it does. The child has to be TOLD to stop, which
    // `execFile`'s `signal` already does — it was simply never wired.
    const shutdown = new AbortController();

    const dispatcher = createWorkflowDispatcher({
      rootDir: repoRoot,
      // br-x36p: a governed run acts on the repository the FAILING COMMAND
      // ran in, not the host's. Observed on dev: failures in
      // /private/tmp/wt-autofix-fix sent fix-agent children into the
      // maintainer's main checkout. A relative cwd is the session's, and an
      // event that names no cwd keeps the host repository.
      rootFor: (event) => {
        const cwd = eventCwd(event);
        return cwd ? resolveRepoRoot(resolve(process.cwd(), cwd)) : repoRoot;
      },
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
      signal: shutdown.signal,
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
    //
    // ABORT BEFORE DRAINING, and the order is the whole point (br-vrzv).
    // Draining first waits on children that have no reason to stop, the
    // handler times out, and they are orphaned to PID 1 exactly as before.
    // Cancelling first gives them a reason, so the join has something to
    // join. A run that ignores the signal is still bounded by the host
    // timeout, but it is no longer the expected case.
    pi.on("session_shutdown", async () => {
      // br-mr22: record BOTH edges -- entering the hook, and the drain
      // actually finishing. Measured on dev, a headless host kills the
      // process about two seconds into the drain, so the second record is
      // missing whenever a governed run was still in flight at shutdown;
      // its absence is the signal.
      logRuntime(repoRoot, { kind: "shutdown-hook-entered", pending: pendingDispatches.size });
      shutdown.abort();
      await drainDispatches();
      logRuntime(repoRoot, { kind: "shutdown-drain-complete" });
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

    // Out-of-band consent for a reverted protected write.
    //
    // A COMMAND, not a prompt, because the decision cannot be awaited where
    // the violation is detected: tool_result handlers are killed at 30s
    // (br-9hv6) and a human reading a guardrail diff takes longer than that.
    // A command is invoked by the user directly and carries no deadline.
    //
    // It is also not reachable by the model, which is load-bearing: it is why
    // the model cannot approve the edit it was just reverted for. Pi
    // dispatches an extension command only from text that reaches
    // prompt() with expandPromptTemplates on (host 0.87.1). This extension
    // never sends text into the session at all -- the autofix continuation
    // was deleted (Phase 0) and `/behavior` describes rather than sends
    // (br-p7gr) -- so nothing it assembles, test output included, can become
    // a command. Quarantine also lives in this process's memory, so a shell
    // escape (`omp -p "/ensemble-approve 1"`) starts a session whose map is
    // empty.
    pi.registerCommand("ensemble-approve", {
      description: "Re-apply a protected-path change that was reverted by the write boundary",
      handler: async (args, ctx) => {
        uiBridge.capture(ctx as never);
        const say = (text: string) => {
          if (ctx.hasUI && ctx.ui?.notify) ctx.ui.notify(text);
          else console.log(text);
        };

        const id = String(args ?? "").trim();
        if (!id) {
          const listing = [...quarantine.entries()].map(([k, q]) => `  ${k}  ${q.path} (${q.reason})`).join("\n");
          say(
            listing
              ? `Reverted protected changes awaiting approval:\n${listing}\n\nRe-apply one with: /ensemble-approve <id>`
              : "No reverted protected changes are awaiting approval.",
          );
          return;
        }

        const entry = quarantine.get(id);
        if (!entry) {
          say(`No quarantined change with id ${id}.`);
          return;
        }
        if (entry.contents === undefined) {
          say(
            `Change ${id} to ${entry.path} was not captured (the file was deleted or unreadable) and cannot be re-applied.`,
          );
          return;
        }

        // Order matters: accept() re-baselines the monitor to the state on
        // disk, so the write has to land first. Re-baselining an unwritten
        // path would bless whatever happened to be there.
        try {
          writeFileSync(resolve(repoRoot, entry.path), entry.contents);
          monitor?.accept(entry.path);
          // Consumed, so one approval cannot be replayed to re-apply the same
          // change after a later revert.
          quarantine.delete(id);
          logRuntime(repoRoot, {
            kind: "approval",
            path: entry.path,
            reason: entry.reason,
            approved: true,
            detail: `re-applied via /ensemble-approve ${id}`,
          });
          say(`Re-applied ${entry.path}. It is now the protected baseline; a further change to it needs its own approval.`);
        } catch (error) {
          say(`Could not re-apply ${entry.path}: ${(error as Error).message}`);
        }
      },
    });

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
      // Why this repo is or is not armed (br-fvmq). Without it, an unarmed
      // repo reports `discovered: 0` and is indistinguishable from a broken
      // one — and "nothing happened" is the hardest failure to diagnose.
      consent: lastActivation.consent?.reason,
    });
  };

  return { activate, sink, lastActivation: () => lastActivation, runRecords };
}

const activate: (pi: ExtensionAPI) => void = createActivate().activate;

export default activate;
