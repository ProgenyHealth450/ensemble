import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";

/**
 * Whether a repository has consented to being acted on (br-fvmq).
 *
 * THE PROBLEM THIS SOLVES. The extension activates in EVERY omp session on
 * the machine, but *arming* — discovering behaviors and wiring a matcher — was
 * a side effect of dependency layout. A repo armed because it happened to
 * contain a `behaviors/` directory, or because something it depended on
 * shipped one. Nobody chose that.
 *
 * Install was accepted as consent for HAVING the runtime. It is not consent
 * for a given repository to be acted on: the user who installs is not
 * necessarily the user, or the moment, whose repo arms.
 *
 * THE RULE. Arming requires an explicit marker in the repository:
 *
 *     # .ensemble/config.yaml
 *     behaviors:
 *       armed: true
 *
 * Deliberately NOT mere presence of the file. `.ensemble/` already holds
 * behavior packages, so a repo can have that directory without anyone having
 * decided anything; presence would re-create the accident this bead is about.
 * An explicit key is an act, and it can be set to `false` to disarm without
 * deleting work.
 *
 * Deliberately NOT distinguishing behaviors the repo OWNS from ones that
 * ARRIVED via a dependency (considered, not selected). One rule: consent is
 * required either way.
 */

/** Why a repository is or is not armed, in words fit to show a user. */
export interface RepoConsent {
  readonly armed: boolean;
  readonly reason: string;
}

export const CONSENT_FILE = join(".ensemble", "config.yaml");

const ABSENT = (detail: string): RepoConsent => ({
  armed: false,
  reason:
    `${CONSENT_FILE} ${detail}. Behaviors are discovered but not armed: no repository ` +
    `should be acted on because of how its dependencies are laid out. To arm it, add:\n` +
    `  behaviors:\n    armed: true`,
});

/**
 * Reads the marker. Never throws: an unreadable or malformed file means "not
 * armed", which is the safe resolution — a repo whose consent cannot be
 * established has not given it. This is the one place where failing closed
 * costs nothing, because the fallback is simply that the runtime observes
 * without acting.
 */
export function readRepoConsent(rootDir: string): RepoConsent {
  let raw: string;
  try {
    raw = readFileSync(join(rootDir, CONSENT_FILE), "utf8");
  } catch {
    return ABSENT("is absent");
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (error) {
    return ABSENT(`could not be parsed (${(error as Error).message})`);
  }

  if (!parsed || typeof parsed !== "object") return ABSENT("is empty");

  const behaviors = (parsed as { behaviors?: unknown }).behaviors;
  if (!behaviors || typeof behaviors !== "object") {
    return ABSENT("has no `behaviors:` section");
  }

  const armed = (behaviors as { armed?: unknown }).armed;
  if (armed === true) {
    return { armed: true, reason: `armed by ${CONSENT_FILE}` };
  }
  if (armed === false) {
    // An explicit opt-out is reported differently from a missing one. Telling
    // someone "add this marker" when they deliberately set it to false is
    // noise, and noise is how a consent channel loses its meaning.
    return { armed: false, reason: `disarmed by ${CONSENT_FILE} (behaviors.armed: false)` };
  }

  return ABSENT("has no `behaviors.armed: true`");
}
