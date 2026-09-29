import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { platform } from "node:os";

/**
 * OS-enforced write confinement for the fix-provider child (br-r3om).
 *
 * WHY THIS EXISTS. The isolated worktree stops a child writing RELATIVE paths,
 * because relative paths resolve against its cwd. It does nothing about
 * ABSOLUTE paths. That was documented as an acknowledged residual until a live
 * probe settled it: a real model, given real tools and told to write
 * `/Users/.../ensemble/CANARY-ABS.txt`, did so on the first attempt with no
 * adversarial prompting. The file landed in the operator's checkout. Detection
 * caught it afterwards and correctly refused to revert -- it cannot tell a
 * child's write from a concurrent human edit -- so the escape persisted.
 *
 * Detection after the fact is not prevention, and REQ-SAFE-004 forbids
 * describing one as the other. This module is the prevention.
 *
 * WHAT IT DOES NOT DO. It confines WRITES only. A child can still read
 * anything the user can read; confidentiality is not claimed here and should
 * not be inferred. Network is untouched -- the child needs it to reach a model.
 */

/** Where a confined child is permitted to write. Everything else is denied. */
export interface SandboxGrant {
  /** The child's cwd -- normally an isolated git worktree. */
  readonly workspace: string;
  /** Throwaway HOME/XDG/OMP root, which the agent legitimately writes to. */
  readonly home: string;
  /** Temp roots the runtime itself needs. */
  readonly temp: readonly string[];
}

export type SandboxSupport =
  | { readonly supported: true; readonly mechanism: string }
  | { readonly supported: false; readonly reason: string };

/**
 * Whether this host can enforce write confinement.
 *
 * Deliberately a probe of the actual binary rather than a platform string:
 * `sandbox-exec` is present on stock macOS but a hardened or minimal image may
 * lack it, and assuming from `process.platform` would claim a boundary that is
 * not there -- the exact failure this module exists to remove.
 */
export function sandboxSupport(): SandboxSupport {
  if (platform() !== "darwin") {
    return {
      supported: false,
      reason: `no write-confinement mechanism is implemented for platform "${platform()}"`,
    };
  }
  try {
    // `-n` with a trivial profile: exercises the binary without running work.
    execFileSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], {
      stdio: "ignore",
    });
    return { supported: true, mechanism: "sandbox-exec (Seatbelt) write confinement" };
  } catch (error) {
    return {
      supported: false,
      reason: `sandbox-exec is not usable on this host (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

/**
 * Resolves symlinks in a path for use in a Seatbelt `subpath`.
 *
 * Non-optional. Seatbelt matches the RESOLVED path, so a profile granting
 * `/tmp/x` grants nothing on macOS, where `/tmp` is a symlink to `/private/tmp`
 * -- the child is then denied its own workspace and every write fails, which
 * looks like a working sandbox and is actually a broken one. Discovered the
 * hard way while prototyping this.
 */
function resolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Escapes a path for a Seatbelt string literal. */
function quote(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Builds the Seatbelt profile.
 *
 * `(allow default)` then `(deny file-write*)` then re-allow the grant: start
 * permissive for everything that is not a write, because the child is a full
 * agent that needs to exec, resolve DNS and open sockets, and enumerating that
 * surface would be a much larger and more fragile commitment than confining
 * the one operation that caused the incident.
 */
export function sandboxProfile(grant: SandboxGrant): string {
  const writable = [grant.workspace, grant.home, ...grant.temp].map(resolved);
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    ...writable.map((path) => `(allow file-write* (subpath "${quote(path)}"))`),
    // Without these the child cannot open a terminal, write to stdout through
    // a pty, or use /dev/null, and every invocation fails for reasons that
    // look nothing like a sandbox problem.
    '(allow file-write* (subpath "/dev"))',
    '(allow file-write* (literal "/dev/null"))',
  ].join("\n");
}

/**
 * Rewrites a command so the OS confines its writes.
 *
 * Returns the original command unchanged when confinement is unsupported: the
 * CALLER decides whether that is acceptable, because only the caller knows
 * whether a weaker control is standing behind it. Silently returning an
 * unconfined command as though it were confined is the failure mode this whole
 * module is a response to.
 */
export function confineWrites(
  command: string,
  args: readonly string[],
  grant: SandboxGrant,
): { readonly command: string; readonly args: readonly string[]; readonly confined: boolean } {
  const support = sandboxSupport();
  if (!support.supported) return { command, args, confined: false };
  return {
    command: "/usr/bin/sandbox-exec",
    args: ["-p", sandboxProfile(grant), command, ...args],
    confined: true,
  };
}
