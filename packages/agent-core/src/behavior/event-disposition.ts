import { HARNESS_EVENT_TYPES, SEMANTIC_EVENT_TYPES } from "./event-catalog";

/**
 * What each catalog event type is FOR (br-d7lm).
 *
 * THE PROBLEM. The catalog lists 54 trigger types; 10 were emitted. A catalog
 * is a promise, and 81% unfulfilled makes the other 19% untrustworthy too,
 * because nothing distinguishes them. Authors wrote behaviors that could never
 * fire, which is why the load-time inert warning had to exist at all.
 *
 * WHY FOUR CATEGORIES AND NOT TWO. The obvious split — "we emit it" vs
 * "delete it" — is wrong for the Foreman-owned families, and getting this
 * right took two passes:
 *
 *  - Ensemble has NO inbound event path. Verified, not assumed: exactly two
 *    things reach the dispatching sink, and `event-sinks.ts` states outright
 *    that Foreman owns durable event ingestion. Nothing can arrive mid-session.
 *  - But Foreman DOES emit prd/trd/review/release/pull_request facts, and
 *    plans to emit more. The resolution is that Foreman launches a session in
 *    response to such a fact, and the event is that session's LAUNCH INPUT.
 *
 * So `trd.approved` is a legitimate trigger reachable by a real mechanism that
 * exists today — just not one the session waits on. Deleting those types would
 * have been wrong; describing them as "consumed by Ensemble" over some ingress
 * transport would also have been wrong. `LAUNCH_INPUT` is the honest third
 * thing, and it needs no transport work.
 *
 * THIS MAP IS AUTHORITATIVE. It lives next to the catalog so a test can
 * compare the two mechanically. Prose cannot hold this: the bead that
 * originated the work expressed dispositions as family wildcards (`trd.*`),
 * which read as complete coverage but left 31 of 54 types unnamed — and two of
 * the unnamed ones were ACTIVELY EMITTED, so an implementer following "remove
 * what is not listed" would have deleted live events.
 */
export type Disposition =
  /** Emitted in-session by this build today. */
  | "keep"
  /** Ensemble knows this fact in-session and should publish it; not yet wired. */
  | "emit"
  /** Foreman's to emit. Reachable as the launch input of a session, never awaited mid-session. */
  | "launch-input"
  /** No producer, no delivery path, and no concept behind it. */
  | "remove";

export const EVENT_DISPOSITIONS: Readonly<Record<string, Disposition>> = {
  // ---- KEEP: emitted today ------------------------------------------------
  "runtime.session.started": "keep",
  "runtime.prompt.submitted": "keep",
  "runtime.tool_call.started": "keep",
  "runtime.tool_call.completed": "keep",
  "runtime.session.completed": "keep",
  "runtime.process.exited": "keep",
  "test.failure.observed": "keep",
  "test.passed": "keep",
  "constitution.proposed": "keep",
  "test.failure.investigated": "keep",
  // Emitted by workflow-dispatch since br-j46q, so behaviors can chain.
  "behavior.completed": "keep",
  "behavior.blocked": "keep",
  "behavior.abandoned": "keep",
  "behavior.outcome.recorded": "keep",

  // ---- EMIT: knowable in-session, not yet wired ---------------------------
  "runtime.message.emitted": "emit",
  "runtime.session.failed": "emit",
  "runtime.session.cancelled": "emit",
  "runtime.session.timed_out": "emit",
  // The registry already calls the approval channel; "a human was asked" is an
  // auditable fact the session holds.
  "approval.requested": "emit",
  // Needs cross-run memory; session-scoped only. The most work in this group.
  "test.regression_detected": "emit",
  "repository.changed": "emit",
  "repository.branch.created": "emit",
  // Deliberately unemitted for now: one event per run is the rule, and a
  // per-observation event has no identified consumer. Kept as `emit` rather
  // than `remove` because the concept is real and the decision is reversible.
  "behavior.observation.recorded": "emit",

  // ---- LAUNCH-INPUT: Foreman's vocabulary ---------------------------------
  // Retained in the catalog and matchable when a session is launched with one
  // of these as its triggering fact. NOT awaited mid-session: building
  // something that waits is the durable ingestion REQ-RUN-002 forbids here.
  "prd.created": "launch-input",
  "prd.refined": "launch-input",
  "prd.approved": "launch-input",
  "prd.deprecated": "launch-input",
  "trd.created": "launch-input",
  "trd.refined": "launch-input",
  "trd.approved": "launch-input",
  "trd.deprecated": "launch-input",
  "implementation.started": "launch-input",
  "implementation.progressed": "launch-input",
  "implementation.blocked": "launch-input",
  "implementation.completed": "launch-input",
  "implementation.abandoned": "launch-input",
  "trd.implementation.started": "launch-input",
  "trd.implementation.progressed": "launch-input",
  "trd.implementation.completed": "launch-input",
  "review.requested": "launch-input",
  "review.completed": "launch-input",
  "review.changes_requested": "launch-input",
  "release.proposed": "launch-input",
  "release.approved": "launch-input",
  "release.completed": "launch-input",
  "pull_request.proposed": "launch-input",
  "pull_request.opened": "launch-input",
  "pull_request.updated": "launch-input",

  // ---- REMOVE: redundant, or no concept behind them -----------------------
  /** Redundant with fix.verified. */
  "validation.requested": "remove",
  "validation.completed": "remove",
  /** Redundant with fix.proposed. */
  "change.proposed": "remove",
  /** No child-behavior step kind exists; adding one is a far larger decision. */
  "child_behavior.requested": "remove",
  /** Overlaps br-u5o / br-pyg; that pair owns the learning corpus. */
  "learning.observation.recorded": "remove",
  /** A session-scoped interpreter has no block-and-resume to unblock from. */
  "behavior.unblocked": "remove",
};

/** Every type the catalog declares, harness and semantic together. */
export function catalogEventTypes(): readonly string[] {
  return [...HARNESS_EVENT_TYPES, ...SEMANTIC_EVENT_TYPES];
}

/** Types carrying a given disposition. */
export function typesWithDisposition(disposition: Disposition): readonly string[] {
  return Object.entries(EVENT_DISPOSITIONS)
    .filter(([, value]) => value === disposition)
    .map(([type]) => type);
}

/**
 * True when a behavior may legitimately trigger on this type even though
 * nothing in this build emits it — because Foreman supplies it at launch.
 */
export function isLaunchInput(eventType: string): boolean {
  return EVENT_DISPOSITIONS[eventType] === "launch-input";
}
