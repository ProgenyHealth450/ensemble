/**
 * `${...}` reference resolution over a closed scope.
 *
 * Substitution only. There is no expression grammar here on purpose: a
 * manifest that can compute is a manifest that can surprise, and §7 rules out
 * an unrestricted workflow DSL. The grammar is a dotted path and nothing else.
 */

export interface ReferenceScope {
  /** The triggering event. */
  readonly event?: unknown;
  /** Results of completed steps, keyed by step ID. */
  readonly steps?: Record<string, unknown>;
  /** Behavior identity. */
  readonly behavior?: unknown;
  /** Workspace facts (root, etc). */
  readonly workspace?: unknown;
}

export const REFERENCE_ROOTS = ["event", "steps", "behavior", "workspace"] as const;

const REFERENCE = /\$\{([A-Za-z0-9_.\[\]-]+)\}/g;
const WHOLE_REFERENCE = /^\$\{([A-Za-z0-9_.\[\]-]+)\}$/;

export type Resolution =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string };

function walk(scope: ReferenceScope, path: string): Resolution {
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) return { ok: false, reason: `empty reference` };
  const root = segments[0];
  if (!(REFERENCE_ROOTS as readonly string[]).includes(root)) {
    return {
      ok: false,
      reason: `reference root "${root}" is not one of [${REFERENCE_ROOTS.join(", ")}]`,
    };
  }

  let current: unknown = (scope as Record<string, unknown>)[root];
  for (let i = 1; i < segments.length; i += 1) {
    if (current === null || current === undefined) {
      return { ok: false, reason: `"${segments.slice(0, i).join(".")}" is ${String(current)}` };
    }
    if (typeof current !== "object") {
      return { ok: false, reason: `"${segments.slice(0, i).join(".")}" is not an object` };
    }
    const key = segments[i];
    const container = current as Record<string, unknown>;
    if (!(key in container)) {
      return { ok: false, reason: `"${segments.slice(0, i + 1).join(".")}" does not exist` };
    }
    current = container[key];
  }
  return { ok: true, value: current };
}

/** Resolves one reference path against the scope. */
export function resolveReference(scope: ReferenceScope, path: string): Resolution {
  return walk(scope, path);
}

/**
 * Resolves a value that may be a reference, a string containing references, or
 * a structure containing either.
 *
 * A string that is *entirely* one reference yields the referenced value with
 * its type intact — `${steps.verify.result.verdict}` used as a command
 * argument must arrive as the value, not as its `String()` rendering, or a
 * boolean result would silently become the truthy string `"false"`.
 */
export function resolveValue(scope: ReferenceScope, value: unknown): Resolution {
  if (typeof value === "string") {
    const whole = WHOLE_REFERENCE.exec(value);
    if (whole) return walk(scope, whole[1]);

    let failure: string | undefined;
    const substituted = value.replace(REFERENCE, (_match, path: string) => {
      const resolved = walk(scope, path);
      if (!resolved.ok) {
        failure ??= `${path}: ${resolved.reason}`;
        return "";
      }
      return typeof resolved.value === "string" ? resolved.value : JSON.stringify(resolved.value);
    });
    return failure ? { ok: false, reason: failure } : { ok: true, value: substituted };
  }

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const resolved = resolveValue(scope, item);
      if (!resolved.ok) return resolved;
      out.push(resolved.value);
    }
    return { ok: true, value: out };
  }

  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const resolved = resolveValue(scope, item);
      if (!resolved.ok) return resolved;
      out[key] = resolved.value;
    }
    return { ok: true, value: out };
  }

  return { ok: true, value };
}

/** Every reference path appearing anywhere in a value. Used by static validation. */
export function collectReferences(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(REFERENCE)) into.add(match[1]);
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, into);
    return into;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectReferences(item, into);
  }
  return into;
}
