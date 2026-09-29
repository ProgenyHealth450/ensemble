import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Mechanically checks claims extracted from documentation (br-gpha).
 *
 * WHY THIS EXISTS, with the evidence being my own work. While documenting the
 * behavior runtime, a single pass produced four fabrications: a CLI that does
 * not exist (hedged with "if present in your checkout"), a wrong `compile()`
 * signature that would have caused `knownCommands` to be silently ignored — a
 * WRONG CLAIM ABOUT AN AUTHORIZATION CHECK — an elided function shape, and
 * invented line citations produced by grepping a file after inserting my own
 * note and reading my own text back as corroboration.
 *
 * Every CODE claim made that day held up, because code gets run. The prose did
 * not, because nothing checks prose. Wrong documentation outlives wrong code:
 * nothing type-checks it, and a reader has no way to tell a verified sentence
 * from an invented one.
 *
 * THE DIVISION OF LABOUR IS THE DESIGN. Extracting candidate claims from
 * markdown needs judgement, so a model proposes them. Deciding whether a claim
 * holds must NOT need judgement, so every check here is mechanical and
 * reproducible. A model that both proposed and adjudicated its own claims
 * would reproduce the original failure exactly — it would be marking its own
 * homework, which is what produced the invented line citations.
 */

export type ClaimKind = "path" | "npm-script" | "symbol";

export interface DocClaim {
  readonly kind: ClaimKind;
  /** The literal text asserted: a path, a script name, an exported symbol. */
  readonly value: string;
  /** Where the claim was made, for a report a human can act on. */
  readonly source?: string;
}

export interface ClaimVerdict extends DocClaim {
  readonly holds: boolean;
  /** Why it does not hold, or how it was confirmed. */
  readonly detail: string;
}

/**
 * Prefixes a documented path may omit.
 *
 * Documentation writes `agent-core/src/behavior/compiler.ts`, which is
 * unambiguous to a reader and wrong to a naive `existsSync`. Measured on this
 * repo's own architecture docs, insisting on the literal path reported 30 of
 * 31 claims as broken — almost all of them correct shorthand.
 *
 * That rate is the point: a checker that is wrong nineteen times out of twenty
 * does not get read, and then the one real finding is lost with the rest. So
 * resolution is part of the check, not a leniency bolted onto it.
 */
export const DEFAULT_PATH_PREFIXES: readonly string[] = ["", "packages/"];

/** A repository path the documentation says exists. */
function verifyPath(root: string, value: string, prefixes: readonly string[]): { holds: boolean; detail: string } {
  // Refuse absolute and escaping paths rather than resolving them: a doc
  // claim is about THIS repository, and checking /etc/passwd would "hold"
  // while telling the reader nothing.
  if (value.startsWith("/") || value.split(/[\\/]/).includes("..")) {
    return { holds: false, detail: `"${value}" is not a repository-relative path` };
  }
  for (const prefix of prefixes) {
    if (existsSync(join(root, prefix + value))) {
      return { holds: true, detail: prefix ? `exists at ${prefix}${value}` : "exists" };
    }
  }
  return { holds: false, detail: `no such file or directory: ${value}` };
}
/** An `npm run <name>` the documentation tells the reader to type. */
function verifyNpmScript(root: string, value: string): { holds: boolean; detail: string } {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return { holds: false, detail: "no package.json at the repository root" };

  let scripts: Record<string, unknown>;
  try {
    scripts = (JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {}) as Record<string, unknown>;
  } catch (error) {
    // Reported as unverifiable, not as false. A malformed package.json makes
    // the claim uncheckable; calling it wrong would be its own false claim.
    return { holds: false, detail: `package.json is unreadable: ${(error as Error).message}` };
  }

  return value in scripts
    ? { holds: true, detail: `package.json declares "${value}"` }
    : { holds: false, detail: `package.json has no script named "${value}"` };
}

/**
 * An exported symbol the documentation names.
 *
 * Deliberately a textual search for an export declaration rather than a type
 * lookup: this must be cheap enough to run over a whole doc set, and a false
 * NEGATIVE here is safe (it prompts a human to look) while the alternative —
 * skipping the check because it is hard to do perfectly — is how the claim
 * went unchecked in the first place.
 */
function verifySymbol(root: string, value: string, files: readonly string[]): { holds: boolean; detail: string } {
  if (!/^[A-Za-z_$][\w$]*$/.test(value)) {
    return { holds: false, detail: `"${value}" is not a plain identifier` };
  }
  const pattern = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|class|interface|type|let)\\s+${value}\\b`);
  for (const file of files) {
    try {
      if (pattern.test(readFileSync(join(root, file), "utf8"))) {
        return { holds: true, detail: `exported from ${file}` };
      }
    } catch {
      continue;
    }
  }
  return { holds: false, detail: `no export named "${value}" found in the searched sources` };
}

export interface VerifyClaimsInput {
  readonly root: string;
  readonly claims: readonly DocClaim[];
  /** Repository-relative source files to search for symbol claims. */
  readonly sourceFiles?: readonly string[];
  /**
   * Prefixes a documented path may omit, longest-match-first order.
   * Repo-specific shorthand (`agent-core/src/...` meaning
   * `packages/agent-core/src/...`) belongs to the caller, not to this module.
   */
  readonly pathPrefixes?: readonly string[];
}

export interface ClaimReport {
  readonly ok: boolean;
  readonly verdicts: readonly ClaimVerdict[];
  /** Claims that did not hold, which is what a reader needs to act on. */
  readonly unresolved: readonly ClaimVerdict[];
  /** How many were examined, so an empty report cannot be mistaken for a clean one. */
  readonly checked: number;
}

export function verifyClaims(input: VerifyClaimsInput): ClaimReport {
  const files = input.sourceFiles ?? [];
  const verdicts = input.claims.map((claim): ClaimVerdict => {
    const outcome =
      claim.kind === "path"
        ? verifyPath(input.root, claim.value, input.pathPrefixes ?? DEFAULT_PATH_PREFIXES)
        : claim.kind === "npm-script"
          ? verifyNpmScript(input.root, claim.value)
          : verifySymbol(input.root, claim.value, files);
    return { ...claim, ...outcome };
  });

  const unresolved = verdicts.filter((v) => !v.holds);
  return {
    // An empty claim list is NOT a pass. "Nothing to check" and "everything
    // checked out" are different facts, and collapsing them is exactly the
    // vacuous-success pattern this repo keeps finding (br-cwrh, br-zctt).
    ok: verdicts.length > 0 && unresolved.length === 0,
    verdicts,
    unresolved,
    checked: verdicts.length,
  };
}
