import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ToolDescriptor,
  CompileOptions,
  compile,
  compileBehaviorToArtifacts,
  discoverBehaviorPackages,
  explainInertTrigger,
  loadPackageAssets,
  readPackageAsset,
  LocalEventMatcher,
  BehaviorInvoker,
  CompiledBehaviorPackage,
  ACTIVATION_SEARCH_ROOTS,
} from "@sunstone-partners/ensemble-agent-core";
import { existsSync } from "node:fs";
import { readRepoConsent, RepoConsent } from "./repo-consent";
import { dirname, join } from "node:path";
import { loadCompiledBehavior } from "./behavior-loader";

/**
 * Resolves the repository root by walking up from `startDir` to the
 * nearest ancestor containing a `.git` entry.
 *
 * Pi's `ExtensionAPI` exposes no workspace-root accessor at activation
 * time (`cwd` lives on the per-call `ExtensionContext`), so activation
 * would otherwise trust the process launch directory. If Pi were
 * launched from a subdirectory, discovery would silently find zero
 * packages and every governance guarantee would quietly stop applying
 * — structurally present but unreachable, the exact failure this
 * package exists to eliminate. Failing to find a root falls back to
 * `startDir` rather than throwing, so a non-git checkout still
 * activates.
 *
 * TRD-013 (PR 2) makes the search root explicitly configurable.
 */
export function resolveRepoRoot(startDir: string): string {
  let current = startDir;
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return startDir;
    current = parent;
  }
}

export interface BehaviorActivationResult {
  discovered: number;
  loaded: string[];
  skipped: { behaviorId: string; reason: string }[];
  /** Loaded, but nothing in this build emits their trigger (br-jgxo). */
  inertTriggers: { behaviorId: string; reason: string }[];
  /**
   * Dispatches matching events to loaded behaviors for this session
   * only. Always present, even when nothing was discovered.
   */
  matcher?: LocalEventMatcher;
  /**
   * behavior name -> directory holding its package files. Taken from the
   * discovered manifest path rather than a conventional guess, so a behavior
   * ships its own prompt/skill files wherever it actually lives.
   */
  packageDirs?: Map<string, string>;
  /**
   * Whether this repository consented to being acted on, and why (br-fvmq).
   * Always populated, including when arming was refused — a caller that wants
   * to tell the user why nothing ran needs the reason, not just `discovered: 0`.
   */
  consent?: RepoConsent;
  /** Invoker failures; one behavior's failure never hides its siblings. */
  invocationErrors: { behavior: string; reason: string }[];
  /** Successfully loaded compiled packages, for late-bound consumers. */
  compiled: CompiledBehaviorPackage[];
}

/**
 * Activates the behavior pipeline for a live Pi session (TRD-005).
 *
 * This closes the gap that made every other governance guarantee in
 * this package unreachable: `discoverBehaviorPackages`,
 * `compileBehaviorToArtifacts` and `loadCompiledBehavior` previously
 * had no call sites outside tests. Because `wireToolGrantEnforcement`
 * is invoked from inside `loadCompiledBehavior`, the manifest-driven
 * blocking of native tools (bash/read/write) never ran in a real
 * session — it was unit-tested code that production never executed.
 *
 * Activation is deliberately non-fatal per package: one malformed
 * behavior must not prevent a session from starting (AC-009-3), but
 * every skipped package is reported so the failure is visible rather
 * than silent.
 */

export function activateBehaviorPipeline(
  pi: ExtensionAPI,
  rootDir: string,
  availableTools: readonly ToolDescriptor<Record<string, unknown>, unknown>[] = [],
  searchRoots: string[] = [...ACTIVATION_SEARCH_ROOTS],
  invoke?: BehaviorInvoker,
  compileOptions: CompileOptions = {},
): BehaviorActivationResult {
  const live: CompiledBehaviorPackage[] = [];
  const packageDirs = new Map<string, string>();
  const result: BehaviorActivationResult = { discovered: 0, loaded: [], skipped: [], inertTriggers: [], invocationErrors: [], compiled: live, packageDirs };

  // Consent is checked BEFORE discovery, not after (br-fvmq). Arming must be
  // something the repository's owner did, not a consequence of what its
  // dependency tree happens to contain. An unarmed repo still activates the
  // extension and still returns a matcher, so nothing downstream has to
  // null-check — it simply has no behaviors to dispatch to.
  const consent = readRepoConsent(rootDir);
  result.consent = consent;
  if (!consent.armed) {
    result.matcher = new LocalEventMatcher([], { invoke: invoke ?? (() => undefined) });
    return result;
  }

  let discovered;
  try {
    discovered = discoverBehaviorPackages(rootDir, { searchRoots });
  } catch {
    // A repo with no discoverable layout at all is not an error —
    // the extension must still activate normally (AC-009-3). A matcher
    // over zero behaviors is still returned so callers never have to
    // null-check it.
    result.matcher = new LocalEventMatcher([], { invoke: invoke ?? (() => undefined) });
    return result;
  }

  result.discovered = discovered.length;

  for (const pkg of discovered) {
    if (!pkg.manifest) {
      result.skipped.push({ behaviorId: pkg.behaviorId, reason: pkg.parseError ?? "no manifest" });
      continue;
    }
    if (pkg.validationErrors && pkg.validationErrors.length > 0) {
      result.skipped.push({ behaviorId: pkg.behaviorId, reason: pkg.validationErrors.join("; ") });
      continue;
    }

    const packageDir = dirname(pkg.manifestPath);
    // Prompt files are resolved against THIS package's directory, so a
    // workflow referencing a missing prompt fails at activation with a
    // diagnostic rather than at invocation with "no candidate offered"
    // (REQ-BEH-003, REQ-BEH-004).
    const compileResult = compile(
      { behaviors: [pkg.manifest] },
      { ...compileOptions, readPrompt: (_name, relative) => readPackageAsset(packageDir, relative) },
    );
    if (compileResult.errors.length > 0 || compileResult.compiled.length === 0) {
      result.skipped.push({
        behaviorId: pkg.behaviorId,
        reason: compileResult.errors.map((e) => e.message).join("; ") || "compile produced no output",
      });
      continue;
    }

    // A behavior whose trigger nothing emits will load cleanly and then sit
    // there forever, looking installed (br-jgxo). Report it at activation
    // rather than letting the silence be discovered later, or never.
    //
    // A WARNING, not a skip: an adapter may legitimately publish a type this
    // build does not know about, and refusing to load would turn an
    // unknown-producer guess into a hard failure.
    for (const compiled of compileResult.compiled) {
      const inert = explainInertTrigger(compiled.manifest.trigger.event_type);
      if (inert) {
        result.inertTriggers.push({ behaviorId: pkg.behaviorId, reason: inert });
        console.warn(`[ensemble] ${pkg.behaviorId}: ${inert}`);
      }
    }

    for (const compiled of compileResult.compiled) {
      try {
        const artifacts = compileBehaviorToArtifacts(compiled, availableTools);
        loadCompiledBehavior(pi, compiled, artifacts, availableTools);
        // Computed here, from the files actually on disk right now. A
        // manifest digest alone cannot distinguish two runs whose prompts
        // differ, and prompts are editable by design (REQ-BEH-003).
        compiled.manifest.metadata.packageDigest = loadPackageAssets(packageDir, compiled.manifest).packageDigest;
        result.loaded.push(compiled.manifest.metadata.name);
        packageDirs.set(compiled.manifest.metadata.name, packageDir);
        live.push(compiled);
      } catch (error) {
        // Includes the TRD-004 fail-closed refusal for an unenforced
        // `mode: auto` manifest — surfaced, never swallowed into a
        // silently degraded session.
        result.skipped.push({
          behaviorId: pkg.behaviorId,
          reason: (error as Error).message,
        });
      }
    }
  }

  // Dispatch (TRD-015 / REQ-003). Without this, behaviors are
  // discovered, compiled and loaded, and a matching event still invokes
  // nothing — validation rather than dispatch. The matcher holds no
  // durable state: the correlation lives only in this session object
  // (TRD-016).
  result.matcher = new LocalEventMatcher(live, {
    invoke: invoke ?? (() => undefined),
    onError: (error, invocation) => {
      result.invocationErrors.push({
        behavior: invocation.behavior.metadata.name,
        reason: error.message,
      });
    },
  });

  return result;
}
