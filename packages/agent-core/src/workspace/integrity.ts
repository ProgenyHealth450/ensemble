import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Deterministic workspace integrity checks (br-c4ni).
 *
 * WHY THIS EXISTS, from a real incident. The root symlink
 * `node_modules/@sunstone-partners/ensemble-agent-core` pointed at
 * `/tmp/wt-guard/packages/agent-core` — a throwaway git worktree that had been
 * deleted. Tests passed anyway, because a nested symlink under
 * `packages/pi-extension/node_modules` shadowed it and resolved correctly. The
 * breakage was therefore INVISIBLE: every signal a developer normally trusts
 * said the workspace was fine. It would have surfaced on the next contributor's
 * machine, or in CI, as a confusing error a long way from its cause.
 *
 * A separate drift showed up in the same session: `npm install` rewrote 56
 * lines of `package-lock.json`, meaning the committed lockfile had diverged
 * from `package.json`.
 *
 * DESIGN. No model involvement and no network. Every finding is a fact
 * established by reading the filesystem, so this can run at session start
 * without cost or judgement. Checks report; they never repair — a fix here
 * means running `npm install`, which is the developer's call, and a runtime
 * that silently rewrote a dependency tree would be far worse than the problem.
 */

export type FindingKind = "dangling-symlink" | "shadowed-dangling-symlink" | "lockfile-drift";

export interface IntegrityFinding {
  readonly kind: FindingKind;
  /** Workspace-relative where possible, so findings are comparable across machines. */
  readonly path: string;
  /** What is wrong, in terms a reader can act on. */
  readonly detail: string;
}

export interface IntegrityReport {
  readonly ok: boolean;
  readonly findings: readonly IntegrityFinding[];
  /** What was actually examined, so an empty report is not mistaken for a skipped one. */
  readonly checked: { readonly linkCount: number; readonly lockfile: boolean };
}

function listEntries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Scoped and plain package links directly under a `node_modules` directory. */
function linksIn(nodeModules: string): string[] {
  const out: string[] = [];
  for (const entry of listEntries(nodeModules)) {
    const full = join(nodeModules, entry);
    if (entry.startsWith("@")) {
      for (const scoped of listEntries(full)) out.push(join(full, scoped));
    } else {
      out.push(full);
    }
  }
  return out;
}

/** Every `node_modules` worth checking: the root's, and each workspace package's. */
function nodeModulesDirs(root: string): string[] {
  const dirs = [join(root, "node_modules")];
  for (const pkg of listEntries(join(root, "packages"))) {
    dirs.push(join(root, "packages", pkg, "node_modules"));
  }
  return dirs.filter((dir) => existsSync(dir));
}

const relativeTo = (root: string, path: string): string =>
  path.startsWith(root + "/") ? path.slice(root.length + 1) : path;

/**
 * Finds symlinks that do not resolve.
 *
 * A link whose target is missing is reported even when something else shadows
 * it, because shadowing is exactly what made the original incident invisible —
 * and a shadowed break is strictly more dangerous than an obvious one, since
 * nothing in the normal workflow reveals it.
 */
export function findDanglingLinks(root: string): { findings: IntegrityFinding[]; linkCount: number } {
  const findings: IntegrityFinding[] = [];
  const dangling = new Map<string, string[]>();
  const resolved = new Set<string>();
  let linkCount = 0;

  for (const dir of nodeModulesDirs(root)) {
    for (const link of linksIn(dir)) {
      let target: string;
      try {
        if (!lstatSync(link).isSymbolicLink()) continue;
        target = readlinkSync(link);
      } catch {
        continue;
      }
      linkCount += 1;

      const absolute = isAbsolute(target) ? target : resolve(join(link, ".."), target);
      const name = packageNameOf(link);
      if (existsSync(absolute)) {
        resolved.add(name);
      } else {
        dangling.set(name, [...(dangling.get(name) ?? []), `${relativeTo(root, link)} -> ${target}`]);
      }
    }
  }

  for (const [name, links] of dangling) {
    // The distinction is the point of this check, not decoration: a plain
    // dangling link breaks loudly on next use, whereas a shadowed one lets
    // every local signal read "fine" while the workspace is already broken for
    // anyone whose layout differs.
    const shadowed = resolved.has(name);
    for (const link of links) {
      findings.push({
        kind: shadowed ? "shadowed-dangling-symlink" : "dangling-symlink",
        path: link,
        detail: shadowed
          ? `target is missing, but another link to ${name} resolves and hides it — tests can pass ` +
            `on this machine while the workspace is broken for anyone else`
          : `target is missing`,
      });
    }
  }

  return { findings, linkCount };
}

/** `@scope/name` or `name`, derived from the link's own path. */
function packageNameOf(link: string): string {
  const parts = link.split(/[\\/]/);
  const last = parts[parts.length - 1] ?? link;
  const parent = parts[parts.length - 2] ?? "";
  return parent.startsWith("@") ? `${parent}/${last}` : last;
}

/**
 * Compares the committed lockfile against `package.json`.
 *
 * Deliberately narrow: it reports ranges the lockfile does not record for the
 * root project, which is the drift that makes `npm ci` and `npm install`
 * disagree. It does not attempt to re-resolve the tree — that is npm's job,
 * and a partial reimplementation would produce false findings, which would
 * teach people to ignore this check.
 */
export function findLockfileDrift(root: string): { findings: IntegrityFinding[]; checked: boolean } {
  const pkgPath = join(root, "package.json");
  const lockPath = join(root, "package-lock.json");
  if (!existsSync(pkgPath) || !existsSync(lockPath)) return { findings: [], checked: false };

  let pkg: Record<string, Record<string, string> | undefined>;
  let lock: { packages?: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }> };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (error) {
    return {
      checked: true,
      findings: [{ kind: "lockfile-drift", path: "package-lock.json", detail: `unreadable: ${(error as Error).message}` }],
    };
  }

  const rootEntry = lock.packages?.[""];
  if (!rootEntry) return { findings: [], checked: false };

  const findings: IntegrityFinding[] = [];
  for (const field of ["dependencies", "devDependencies"] as const) {
    const declared = pkg[field] ?? {};
    const locked = rootEntry[field] ?? {};
    for (const [name, range] of Object.entries(declared)) {
      if (!(name in locked)) {
        findings.push({
          kind: "lockfile-drift",
          path: "package-lock.json",
          detail: `${field}.${name} is in package.json but not in the lockfile — run npm install`,
        });
      } else if (locked[name] !== range) {
        findings.push({
          kind: "lockfile-drift",
          path: "package-lock.json",
          detail: `${field}.${name} is "${range}" in package.json but "${locked[name]}" in the lockfile`,
        });
      }
    }
  }

  return { findings, checked: true };
}

/** Runs every check. Read-only; never repairs. */
export function checkWorkspaceIntegrity(root: string): IntegrityReport {
  const realRoot = existsSync(root) ? realpathSync(root) : root;
  const links = findDanglingLinks(realRoot);
  const lock = findLockfileDrift(realRoot);
  const findings = [...links.findings, ...lock.findings];

  return {
    ok: findings.length === 0,
    findings,
    // Reported so that "no findings" can be told apart from "nothing was
    // examined" — an empty result from a check that never ran is the most
    // reassuring possible lie.
    checked: { linkCount: links.linkCount, lockfile: lock.checked },
  };
}
