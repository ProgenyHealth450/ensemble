/**
 * The Pi/OMP `AgentPort` adapter: a bounded, contained model invocation.
 *
 * WHY A SUBPROCESS
 *
 * Pi's `ExtensionAPI` has no completion primitive. An extension can register
 * tools and commands and push messages into the session, but it cannot ask the
 * model a question and receive an answer. The rejected alternative was
 * `sendUserMessage`, which gets an answer by making the *user's own agent* do
 * the work — with the user's tools, outside every boundary the runtime exists
 * to impose. That was the second dispatch path, and Phase 0 removed it.
 *
 * WHAT ACTUALLY CONTAINS THIS CHILD (br-33co)
 *
 * The tool allowlist does not. Measured three times against the real binary:
 *
 *     omp -p --no-session --no-extensions --tools=read,grep,glob --cwd=<dir>
 *     child reports: _read _grep _glob _manage_skill _learn _write
 *
 * `--no-tools --no-skills` changed nothing. A probe child was asked to use
 * them and created
 * `~/.omp/agent/managed-skills/containment-probe-delete-me/SKILL.md` — a real
 * file in the operator's HOME, which loads as a skill in every future session
 * in every repository. The prompt that child receives is built from test
 * output, which is attacker-influenceable in principle, so this is a path from
 * hostile text to indefinite persistence.
 *
 * Three boundaries are applied here, and only two of them are real:
 *
 *   1. A THROWAWAY HOME. `HOME`, `XDG_*` and the OMP/Pi config roots point
 *      into a temporary directory that is deleted when the call returns. This
 *      is what actually contains `_manage_skill` and `_learn`: they still
 *      work, and what they write dies with the run. Enforced by the operating
 *      system's view of the filesystem, not by the agent's cooperation.
 *   2. AN ISOLATED CWD. The child runs in a throwaway git worktree, so a
 *      `_write` or `edit` that lands reaches a disposable checkout rather than
 *      the user's tree. Also OS-enforced.
 *   3. `--tools`. Retained, and explicitly NOT credited: it is a hint that
 *      narrows what a cooperative model reaches for. Do not describe it as
 *      containment — the measurement above says it is not.
 *
 * Neither (1) nor (2) is a general sandbox. The child can still read anything
 * the user can read, reach the network, and run whatever its own tooling
 * permits inside its cwd. §REQ-SAFE-004 requires saying exactly that rather
 * than calling a partial boundary an isolation guarantee.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentPort, createIsolatedWorkspace, IsolatedWorkspace } from "@sunstone-partners/ensemble-agent-core";
import { captureTreeBaseline, treeChangesSinceBaseline } from "./tree-baseline";

export interface AgentPortOptions {
  readonly repoRoot: string;
  /** Agent executable. Default `omp`. */
  readonly command?: string;
  /**
   * Overrides process execution; tests supply a fake instead of spawning.
   * Receives the contained environment so a test can assert on it.
   */
  readonly run?: (input: {
    readonly prompt: string;
    readonly tools: readonly string[];
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
  }) => Promise<string>;
  /** Supplies the isolated cwd. Defaults to a git worktree of the repo root. */
  readonly isolate?: typeof createIsolatedWorkspace;
  /**
   * Runs the child in the live repository instead of an isolated worktree.
   * Exists only so a non-git workspace can still be investigated read-only;
   * it is reported, never silent.
   */
  readonly allowUnisolated?: boolean;
  readonly log?: (entry: Record<string, unknown>) => void;
}

/**
 * Environment variables that decide where an agent persists things.
 *
 * Pointed at a throwaway directory rather than unset: unsetting `HOME` makes
 * many tools fall back to the passwd entry, which is the real home again.
 * Redirecting is containment; deleting is an invitation to rediscover.
 */
export function containedEnvironment(home: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    OMP_HOME: join(home, ".omp"),
    OMP_CONFIG_DIR: join(home, ".omp"),
    PI_HOME: join(home, ".pi"),
    PI_CONFIG_DIR: join(home, ".pi"),
  };
}

export function agentArgs(cwd: string, tools: readonly string[], prompt: string): string[] {
  return [
    "-p",
    "--no-session",
    // Without this the child loads this extension and recurses into its own
    // dispatch.
    "--no-extensions",
    // Defence in depth ONLY. See the file docstring: this does not contain.
    `--tools=${tools.join(",")}`,
    `--cwd=${cwd}`,
    prompt,
  ];
}

export function createAgentPort(options: AgentPortOptions): AgentPort & { describeContainment(): string } {
  const log = options.log ?? (() => undefined);
  const isolate = options.isolate ?? createIsolatedWorkspace;

  const runAgent =
    options.run ??
    ((input: {
      prompt: string;
      tools: readonly string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
      timeoutMs: number;
      signal: AbortSignal;
    }) =>
      new Promise<string>((resolve, reject) => {
        const child = execFile(
          options.command ?? "omp",
          agentArgs(input.cwd, input.tools, input.prompt),
          {
            cwd: input.cwd,
            env: input.env,
            signal: input.signal,
            timeout: input.timeoutMs,
            maxBuffer: 32 * 1024 * 1024,
          },
          (error, stdout) => {
            // A non-zero exit still often carries a usable reply on stdout;
            // only treat it as failure when nothing came back.
            if (error && !stdout) reject(error);
            else resolve(stdout);
          },
        );
        // execFile hands the child a pipe for stdin and never closes it. A
        // non-TTY stdin makes the agent conclude a prompt is being piped in,
        // so it blocks waiting for EOF and never reads argv — the call hangs
        // to its timeout and looks like a model failure when it is entirely
        // ours. Closing stdin is what makes the argv prompt take effect.
        child.stdin?.end();
      }));

  return {
    describeContainment() {
      return [
        "throwaway HOME/XDG/OMP config roots (contains _manage_skill and _learn; OS-enforced)",
        "isolated git worktree as cwd (contains writes to project source; OS-enforced)",
        "--tools allowlist (advisory only; measured not to restrict _write/_learn/_manage_skill)",
      ].join("; ");
    },

    async invoke(request) {
      const home = mkdtempSync(join(tmpdir(), "ensemble-agent-home-"));
      let workspace: IsolatedWorkspace | undefined;
      let cwd = options.repoRoot;
      let isolationNote = "live repository (unisolated)";

      try {
        const isolation = isolate(options.repoRoot, "agent");
        if (isolation.ok) {
          workspace = isolation.workspace;
          cwd = workspace.root;
          isolationNote = "isolated worktree";
        } else if (!options.allowUnisolated) {
          // Fail closed. Running the child in the live tree because isolation
          // was unavailable is precisely how an ungoverned write happens, and
          // "we could not isolate" must never resolve to "therefore proceed".
          return {
            ok: false,
            reason:
              `refusing to invoke the agent: ${isolation.reason}. ` +
              `An uncontained child is not a supported degraded mode.`,
          };
        }

        log({
          kind: "agent-invoke",
          behavior: request.behavior,
          step: request.stepId,
          isolation: isolationNote,
          tools: request.tools,
        });

        // Defence in depth, and named as such: this is a before/after check on
        // the LIVE tree, not a sandbox. The two OS-level boundaries above stop
        // a child that writes relative paths. They cannot stop one that writes
        // an ABSOLUTE path back into the user's repository, and pretending
        // otherwise is the "post-tool monitor described as isolation" that
        // REQ-SAFE-004 forbids. So the residual case is detected instead.
        const baseline = captureTreeBaseline(options.repoRoot);

        const reply = await runAgent({
          prompt: request.prompt,
          tools: request.tools,
          cwd,
          env: containedEnvironment(home),
          timeoutMs: request.timeoutMs,
          signal: request.signal,
        });

        const drift = baseline ? treeChangesSinceBaseline(baseline) : undefined;
        if (drift && drift.length > 0) {
          // Refused, NOT reverted. The change cannot be attributed: a
          // concurrent save by the user looks identical to a write by the
          // child, and REQ-SAFE-005 is explicit that a user's concurrent edit
          // must never be silently overwritten. Discarding the reply is the
          // move that is safe under both readings — the user keeps their work,
          // and a provider that wrote has broken its contract, so whatever it
          // returned cannot be trusted as a read-only observation.
          const listed = drift.slice(0, 10).join(", ") + (drift.length > 10 ? ` (+${drift.length - 10} more)` : "");
          log({ kind: "agent-invoke-drift", behavior: request.behavior, step: request.stepId, drift });
          return {
            ok: false,
            reason:
              `the working tree changed while the agent ran (${listed}). A read-only agent step must ` +
              `not write, and a concurrent user edit cannot be told apart from one, so the reply is ` +
              `discarded and nothing was reverted.`,
          };
        }
        if (baseline && drift === undefined) {
          log({ kind: "agent-invoke-drift-unavailable", behavior: request.behavior, step: request.stepId });
        }

        return { ok: true, reply };
      } catch (error) {
        const reason = request.signal.aborted
          ? "agent invocation was cancelled"
          : `agent invocation failed: ${(error as Error).message}`;
        log({ kind: "agent-invoke-failed", behavior: request.behavior, step: request.stepId, reason });
        return { ok: false, reason };
      } finally {
        // Both cleanups run regardless of outcome, including cancellation.
        // A throwaway HOME that outlives the run is not a throwaway HOME.
        workspace?.dispose();
        rmSync(home, { recursive: true, force: true });
      }
    },
  };
}
