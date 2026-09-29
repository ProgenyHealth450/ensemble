

/**
 * Which trigger event types anything actually emits (`br-jgxo`).
 *
 * `event-catalog.ts` lists around 45 ingress types — `prd.*`, `trd.*`,
 * `review.*`, `pull_request.*` and more. Almost none are produced by
 * anything. A behavior triggering on one compiles, validates, loads, and then
 * never fires: no error, no warning, just a package that looks installed and
 * is inert.
 *
 * That is the same defect TRD-2026-15aa5acd recorded as REQ-009/010/011 (an
 * example behavior whose trigger was unsatisfiable), returning as a catalog
 * promising far more than the runtime delivers. This module is the
 * mechanical answer: a behavior that cannot fire says so at load time.
 *
 * Deliberately conservative. It reports "nothing known emits this", never
 * "this is invalid" — an adapter may legitimately publish a type this build
 * does not know about, so the finding is a warning and never a rejection.
 */

/**
 * Types the translator derives from raw runtime events.
 *
 * Hand-maintained and deliberately short, because it is a claim about
 * `event-translator.ts`'s behavior rather than a restatement of a list. Keep
 * it in step with `translateEvent`.
 */
export const TRANSLATED_EVENT_TYPES: readonly string[] = [
  "test.failure.observed",
  // Narrow: emitted ONLY for a run that reported it executed nothing.
  // A healthy suite still produces no event.
  "test.passed",
];

/**
 * Types the registered command catalog declares it emits.
 *
 * NOT derived from `eventTypes()`. That returns 61 entries — the whole
 * domain vocabulary, each with a payload schema — and a schema entry is a
 * description of an event's SHAPE, not evidence that anything produces one.
 * `prd.created` has a schema and no producer. Conflating the two made this
 * check report every trigger as fine, which is the failure it exists to
 * catch.
 *
 * Hand-maintained and pinned by `tests/trigger-producers.test.ts`, which
 * compares it against the real catalog's `emits` and fails on drift.
 */
export const COMMAND_EMITTED_EVENT_TYPES: readonly string[] = [
  "test.failure.investigated",
  "fix.proposed",
  "fix.verified",
  "fix.applied",
  "fix.rejected",
  "constitution.proposed",
  "constitution.applied",
  "constitution.declined",
];

/**
 * Types the REGISTRY emits directly, not declared by any descriptor.
 *
 * Separate because the drift test compares `COMMAND_EMITTED_EVENT_TYPES`
 * against the catalog's `emits` lists, and these would look like drift
 * forever. `command.rejected` is published by `CommandRegistry` when a
 * command is denied — no descriptor declares it because no descriptor
 * chooses it.
 */
export const REGISTRY_EMITTED_EVENT_TYPES: readonly string[] = ["command.rejected"];

/**
 * Raw harness events the Pi adapter publishes.
 *
 * These are NOT translated — they are the runtime's own telemetry, and a
 * behavior may legitimately trigger on one. Omitting them from this module
 * made it warn that `runtime.session.started` would never fire, which is
 * false and exactly the kind of wrong warning that teaches people to ignore
 * warnings.
 *
 * Verified against `packages/pi-extension/src` rather than assumed from the
 * catalog: four catalogued `runtime.*` types (`message.emitted`,
 * `session.failed`, `session.cancelled`, `session.timed_out`) are NOT among
 * them and remain genuinely inert.
 */
export const HARNESS_EMITTED_EVENT_TYPES: readonly string[] = [
  "runtime.session.started",
  "runtime.session.completed",
  "runtime.prompt.submitted",
  "runtime.tool_call.started",
  "runtime.tool_call.completed",
  "runtime.tool.completed",
  "runtime.tool.failed",
  "runtime.process.exited",
];

export interface TriggerProducer {
  readonly eventType: string;
  /** How this type comes to exist. */
  readonly producedBy: "translator" | "command" | "harness";
}

/** Every trigger type this build can actually produce, with its source. */
export function producibleTriggers(): readonly TriggerProducer[] {
  const out: TriggerProducer[] = TRANSLATED_EVENT_TYPES.map((eventType) => ({
    eventType,
    producedBy: "translator" as const,
  }));
  // Command-emitted lifecycle events are genuinely produced, so a behavior
  // may chain off another behavior's command output.
  for (const eventType of [...COMMAND_EMITTED_EVENT_TYPES, ...REGISTRY_EMITTED_EVENT_TYPES]) {
    if (!out.some((entry) => entry.eventType === eventType)) {
      out.push({ eventType, producedBy: "command" });
    }
  }
  for (const eventType of HARNESS_EMITTED_EVENT_TYPES) {
    if (!out.some((entry) => entry.eventType === eventType)) {
      out.push({ eventType, producedBy: "harness" });
    }
  }
  return out;
}

/** True when something in this build emits `eventType`. */
export function triggerHasProducer(eventType: string): boolean {
  return producibleTriggers().some((entry) => entry.eventType === eventType);
}

/**
 * A human-readable explanation for an inert trigger, or undefined when the
 * trigger is fine. The message names alternatives, because "this will never
 * fire" without "here is what does" sends the reader back to the catalog that
 * misled them.
 */
export function explainInertTrigger(eventType: string): string | undefined {
  if (triggerHasProducer(eventType)) return undefined;
  const translated = TRANSLATED_EVENT_TYPES.join(", ");
  return (
    `trigger "${eventType}" is in the ingress catalog but nothing in this build emits it, ` +
    `so this behavior will never fire. Types the runtime derives from tool calls: ${translated}. ` +
    `Command-emitted lifecycle events (fix.proposed, fix.verified, constitution.proposed, ...) ` +
    `also fire and can chain one behavior off another. See br-jgxo.`
  );
}
