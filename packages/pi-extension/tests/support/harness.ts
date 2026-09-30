import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AgentPort } from "@sunstone-partners/ensemble-agent-core";
import { drainDispatches } from "../../src/extension";

/**
 * Shared scaffolding for the end-to-end gates.
 *
 * Exit gate 3 requires the reference flow to be reproducible "from fixtures,
 * in CI" and calls out what does not count: the previous proof depended on a
 * bespoke driver script on one machine. So everything here builds a real git
 * repository in a temp directory, wires the real `activate()`, and drives it
 * through Pi's real event shapes. The only fake is the Pi event surface
 * itself, because Pi is the host and cannot be run inside a unit test.
 */

const created: string[] = [];
let originalCwd: string | undefined;

export function cleanupSandboxes(): void {
  if (originalCwd) process.chdir(originalCwd);
  originalCwd = undefined;
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
  created.length = 0;
}

export interface SandboxFile {
  readonly path: string;
  readonly contents: string;
}

/**
 * A real git repository.
 *
 * Git is not incidental: isolated verification and the contained agent port
 * both create worktrees, and a fixture that is not a repository would silently
 * exercise their unavailable-isolation branches instead of the real ones.
 */
export function sandbox(files: readonly SandboxFile[]): string {
  const root = mkdtempSync(join(tmpdir(), "ensemble-e2e-"));
  created.push(root);

  // Every sandbox consents to being armed unless the test supplies its own
  // marker (br-fvmq). Arming is an explicit act in production, so a fixture
  // must perform it too — but an e2e test is about what the runtime does
  // ONCE armed, and making each one restate consent would bury the thing it
  // actually tests. A test that wants to exercise refusal overrides the path.
  const consented = files.some((f) => f.path === ".ensemble/config.yaml");
  const all = consented ? files : [...files, { path: ".ensemble/config.yaml", contents: "behaviors:\n  armed: true\n" }];

  for (const file of all) {
    const abs = join(root, file.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.contents);
  }

  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  };
  git("init", "--initial-branch=main");
  git("config", "user.email", "e2e@example.test");
  git("config", "user.name", "e2e");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-m", "fixture");

  return root;
}

export function enterSandbox(root: string): void {
  originalCwd ??= process.cwd();
  process.chdir(root);
}

export interface FakePi {
  readonly pi: ExtensionAPI;
  /** Fires a host lifecycle event and drains out-of-band dispatch. */
  fire(name: string, event: unknown): Promise<unknown>;
  readonly commands: Map<string, (args: string, ctx: unknown) => Promise<void>>;
  /** Anything the runtime tried to push into the session. Must stay empty. */
  readonly userMessages: string[];
}

export function fakePi(): FakePi {
  const handlers = new Map<string, (e: unknown) => Promise<void> | void>();
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const userMessages: string[] = [];

  const pi = {
    registerCommand: (name: string, spec: { handler: (a: string, c: unknown) => Promise<void> }) => {
      commands.set(name, spec.handler);
    },
    registerTool: () => undefined,
    registerFlag: () => undefined,
    getFlag: () => false,
    // Recorded rather than ignored. The continuation path worked by calling
    // this, so a test that merely asserted "the tree is unchanged" could pass
    // while the runtime quietly queued the mutation for the next turn.
    sendUserMessage: (message: string) => {
      userMessages.push(message);
      return undefined;
    },
    sendMessage: (message: string) => {
      userMessages.push(message);
      return undefined;
    },
    on: (name: string, handler: (e: unknown) => Promise<void> | void) => {
      const existing = handlers.get(name);
      handlers.set(
        name,
        existing
          ? async (e) => {
              const first = await existing(e);
              const second = await handler(e);
              return second ?? first;
            }
          : handler,
      );
      return () => undefined;
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    commands,
    userMessages,
    async fire(name, event) {
      const result = await handlers.get(name)?.(event);
      await drainDispatches();
      return result;
    },
  };
}

/** The Pi `tool_result` shape a failing test command produces. */
export function failingToolResult(command: string, output: string, id = "tr-1"): Record<string, unknown> {
  return {
    type: "tool_result",
    toolCallId: id,
    toolName: "bash",
    input: { command },
    content: [{ type: "text", text: output }],
    isError: true,
  };
}

/** Runs a command in the sandbox and returns what a host would have captured. */
export function runInSandbox(root: string, command: string): { code: number; output: string } {
  const r = spawnSync("bash", ["-lc", command], { cwd: root, encoding: "utf8" });
  return { code: r.status ?? 1, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/**
 * An `AgentPort` that returns a scripted reply without spawning anything.
 *
 * Used where the test is about what the RUNTIME does with a reply. Where the
 * test is about containment, the real port is used instead — a fake cannot
 * escape, so it cannot prove escape is prevented.
 */
export function scriptedAgent(replies: Record<string, string> | string): AgentPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async invoke(request) {
      calls.push(request.stepId);
      const reply = typeof replies === "string" ? replies : replies[request.stepId];
      if (reply === undefined) {
        return { ok: false, reason: `no scripted reply for step "${request.stepId}"` };
      }
      return { ok: true, reply };
    },
  };
}
