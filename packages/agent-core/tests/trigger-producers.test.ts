import { ProposalStore } from "../src/cqrs/proposal-store";
import { createCommandCatalog } from "../src/cqrs/commands";
import {
  COMMAND_EMITTED_EVENT_TYPES,
  TRANSLATED_EVENT_TYPES,
  explainInertTrigger,
  producibleTriggers,
  triggerHasProducer,
} from "../src/behavior/trigger-producers";
import { SEMANTIC_EVENT_TYPES } from "../src/behavior/event-catalog";

/**
 * `br-jgxo`: a behavior that can never fire should say so.
 *
 * The defect is not that the catalog is large. It is that an oversized
 * catalog fails SILENTLY: the behavior compiles, validates, loads, and then
 * waits forever on an event nothing emits. Nothing distinguishes it from a
 * working behavior that simply has not been triggered yet.
 */
describe("knowing which triggers anything actually emits", () => {
  it("reports the two types the translator derives", () => {
    expect(triggerHasProducer("test.failure.observed")).toBe(true);
    expect(triggerHasProducer("test.passed")).toBe(true);
  });

  it("reports command-emitted lifecycle events, so behaviors can chain", () => {
    expect(triggerHasProducer("fix.verified")).toBe(true);
    expect(triggerHasProducer("constitution.proposed")).toBe(true);
  });

  it("reports catalogued-but-unproduced types as inert", () => {
    for (const type of ["prd.created", "trd.refined", "pull_request.proposed", "review.completed"]) {
      expect(triggerHasProducer(type)).toBe(false);
    }
  });

  it("explains an inert trigger instead of merely denying it", () => {
    const message = explainInertTrigger("prd.created");
    expect(message).toContain("prd.created");
    expect(message).toContain("never fire");
    // Names what DOES work — otherwise the reader goes back to the catalog
    // that misled them.
    expect(message).toContain("test.failure.observed");
  });

  it("says nothing about a trigger that works", () => {
    expect(explainInertTrigger("test.failure.observed")).toBeUndefined();
  });

  it("stays conservative: unknown types are inert, never rejected", () => {
    // A type no build knows about is still only a warning. An adapter may
    // legitimately publish it.
    expect(explainInertTrigger("some.adapter.event")).toContain("never fire");
  });

  it("documents a real gap: most of the ingress catalog is unproduced", () => {
    const produced = SEMANTIC_EVENT_TYPES.filter((t) => triggerHasProducer(t));
    // Not an aspiration — a measurement. If this ratio improves, the number
    // below should be updated deliberately, with the emitter that caused it.
    expect(produced.length).toBeLessThan(SEMANTIC_EVENT_TYPES.length / 2);
    expect(TRANSLATED_EVENT_TYPES.length).toBe(2);
  });

  it("lists every producible trigger with how it is produced", () => {
    const entries = producibleTriggers();
    expect(entries.find((e) => e.eventType === "test.passed")?.producedBy).toBe("translator");
    expect(entries.find((e) => e.eventType === "fix.verified")?.producedBy).toBe("command");
  });
  it("keeps the hand-maintained command list in step with the real catalog", () => {
    // The list is hand-maintained so this module stays dependency-light. That
    // is only safe if drift fails the build: a command added with a new
    // `emits` entry would otherwise leave this check reporting a live
    // trigger as inert.
    const catalog = createCommandCatalog({
      workspaceRoot: "/nonexistent",
      store: new ProposalStore("/nonexistent"),
    });
    const actual = [...new Set(catalog.flatMap((d) => d.emits))].sort();
    expect([...COMMAND_EMITTED_EVENT_TYPES].sort()).toEqual(actual);
  });

  it("does not mistake a schema entry for a producer", () => {
    // The bug this module shipped with for ten minutes: `eventTypes()`
    // returns 61 entries describing event SHAPES, and `prd.created` has a
    // shape but no producer. Deriving from it reported every trigger as
    // fine — a check that always passes.
    expect(triggerHasProducer("prd.created")).toBe(false);
  });
  it("does not warn about raw harness events the adapter really publishes", () => {
    // Regression: the first version omitted runtime.* entirely and warned
    // that `runtime.session.started` would never fire. A warning that is
    // wrong is worse than no warning — it teaches people to ignore the
    // channel.
    for (const type of [
      "runtime.session.started",
      "runtime.prompt.submitted",
      "runtime.tool_call.completed",
    ]) {
      expect(triggerHasProducer(type)).toBe(true);
    }
  });

  it("still reports catalogued runtime types the adapter does not publish", () => {
    // Verified against packages/pi-extension/src, not inferred from the
    // catalog: these four are genuinely absent.
    for (const type of [
      "runtime.message.emitted",
      "runtime.session.failed",
      "runtime.session.cancelled",
      "runtime.session.timed_out",
    ]) {
      expect(triggerHasProducer(type)).toBe(false);
    }
  });
});
