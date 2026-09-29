import {
  EVENT_DISPOSITIONS,
  catalogEventTypes,
  typesWithDisposition,
  isLaunchInput,
} from "../src/behavior/event-disposition";
import { triggerHasProducer } from "../src/behavior/trigger-producers";

/**
 * br-d7lm's acceptance criterion: the disposition map must cover the catalog
 * in BOTH directions.
 *
 * This is an assertion rather than a review checklist for a specific reason.
 * The dispositions were first written as family wildcards (`trd.*`, `prd.*`),
 * which read as complete coverage and were not: a later audit found only 23 of
 * 54 types named anywhere, 31 covered by wildcard alone. Two of the unnamed
 * ones — `constitution.proposed` and `test.failure.investigated` — were
 * ACTIVELY EMITTED, so anyone implementing "remove what is not listed" would
 * have deleted live events and broken the constitution-learning and
 * investigation flows.
 *
 * A wildcard reads like coverage. `trd.*` looks complete until you notice
 * `trd.implementation.*` is a separate three-type family a reader may or may
 * not fold in. Only a mechanical comparison catches that.
 */

describe("every catalog event has exactly one disposition", () => {
  it("classifies every type the catalog declares", () => {
    const unclassified = catalogEventTypes().filter((type) => !(type in EVENT_DISPOSITIONS));

    expect(unclassified).toEqual([]);
  });

  it("classifies nothing that is not in the catalog", () => {
    // The other direction, and the one that rots silently: a type renamed or
    // removed from the catalog leaves a stale entry here that looks
    // authoritative and describes nothing.
    const catalog = new Set(catalogEventTypes());
    const phantom = Object.keys(EVENT_DISPOSITIONS).filter((type) => !catalog.has(type));

    expect(phantom).toEqual([]);
  });

  it("covers the catalog exactly once, with no duplicates", () => {
    expect(Object.keys(EVENT_DISPOSITIONS)).toHaveLength(catalogEventTypes().length);
    expect(new Set(catalogEventTypes()).size).toBe(catalogEventTypes().length);
  });
});

describe("the dispositions describe the build as it actually is", () => {
  it("marks as `keep` exactly what this build emits", () => {
    // Binds the map to reality rather than to intent. If someone wires up a
    // new producer, or removes one, this fails until the map is updated —
    // which is the whole point: the catalog stopped being trustworthy
    // precisely because it drifted from what the code did.
    const emitted = catalogEventTypes().filter((type) => triggerHasProducer(type));
    const kept = typesWithDisposition("keep");

    expect([...kept].sort()).toEqual([...emitted].sort());
  });

  it("does not claim anything unemitted is `keep`", () => {
    for (const type of typesWithDisposition("keep")) {
      expect(triggerHasProducer(type)).toBe(true);
    }
  });

  it("marks nothing emitted as `remove`", () => {
    // The exact mistake the wildcard dispositions would have caused.
    for (const type of typesWithDisposition("remove")) {
      expect(triggerHasProducer(type)).toBe(false);
    }
  });
});

describe("launch input is a real delivery mechanism, not a synonym for inert", () => {
  it("covers the Foreman-owned families", () => {
    const families = ["prd.", "trd.", "implementation.", "review.", "release.", "pull_request."];
    const foremanOwned = catalogEventTypes().filter((t) => families.some((f) => t.startsWith(f)));

    for (const type of foremanOwned) {
      expect(isLaunchInput(type)).toBe(true);
    }
  });

  it("includes trd.implementation.*, the family a wildcard reader would miss", () => {
    // Named explicitly because `trd.*` looks like it covers this and a reader
    // may or may not fold it in. This is the concrete shape of the wildcard
    // failure, so it gets its own assertion.
    expect(isLaunchInput("trd.implementation.started")).toBe(true);
    expect(isLaunchInput("trd.implementation.progressed")).toBe(true);
    expect(isLaunchInput("trd.implementation.completed")).toBe(true);
  });

  it("is never something this build emits, since Foreman owns these facts", () => {
    for (const type of typesWithDisposition("launch-input")) {
      expect(triggerHasProducer(type)).toBe(false);
    }
  });
});
