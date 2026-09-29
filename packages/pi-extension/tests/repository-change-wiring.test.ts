import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { InMemoryEventSink } from "@sunstone-partners/ensemble-agent-core";
import { wireSessionLifecycle } from "../src/session";

/**
 * br-gpha: proves `repository.changed` reaches the sink through the REAL
 * session wiring, not merely that the translator function works.
 *
 * Unit-correctness of a translator says nothing about whether anything calls
 * it. `translateRepositoryChange` is a second, separate translator, so
 * `session.ts` needs a second call site — and a missed call site would be
 * invisible: no error, no warning, just a behavior that never fires. That is
 * precisely the class of defect this behavior was built to catch, so it would
 * be a poor thing to ship with.
 */

function fakePi(): { pi: ExtensionAPI; fire: (name: string, event: unknown) => Promise<void> } {
  const handlers = new Map<string, (event: unknown) => Promise<void> | void>();
  const pi = { on: (name: string, handler: (e: unknown) => Promise<void> | void) => void handlers.set(name, handler) } as unknown as ExtensionAPI;
  return { pi, fire: async (name, event) => void (await handlers.get(name)?.(event)) };
}

async function typesAfterBash(command: string, isError = false): Promise<string[]> {
  const { pi, fire } = fakePi();
  const sink = new InMemoryEventSink();
  wireSessionLifecycle(pi, sink);

  // `tool_result`, NOT `tool_execution_end`. Both produce
  // `runtime.tool_call.completed`, but only `tool_result` exposes the tool's
  // input, so only it carries `command` (pi-events.ts). Firing the other one
  // produces a well-formed event with no command and translates to nothing —
  // which is exactly how this test failed on its first run, and a good
  // reminder that "the translator works" and "the translator is reachable"
  // are separate claims.
  await fire("tool_result", {
    type: "tool_result",
    toolCallId: "call-1",
    toolName: "bash",
    input: { command },
    content: [{ type: "text", text: "" }],
    isError,
  });

  return sink.drain().map((envelope) => envelope.event.type);
}

describe("repository.changed reaches the sink through the live wiring", () => {
  it("publishes it after a successful commit", async () => {
    const types = await typesAfterBash("git commit -m 'x'");

    expect(types).toContain("repository.changed");
  });

  it("publishes the raw tool call as well, not instead", async () => {
    // The derived event is additional. Replacing the raw event would break
    // every consumer that depends on the harness stream.
    const types = await typesAfterBash("git commit -m 'x'");

    expect(types).toContain("runtime.tool_call.completed");
  });

  it("publishes branch creation as its own type", async () => {
    const types = await typesAfterBash("git checkout -b feature/x");

    expect(types).toContain("repository.branch.created");
    expect(types).not.toContain("repository.changed");
  });

  it("publishes nothing extra for a read-only git command", async () => {
    const types = await typesAfterBash("git status");

    expect(types).toEqual(["runtime.tool_call.completed"]);
  });

  it("publishes nothing extra when the command failed", async () => {
    const types = await typesAfterBash("git commit -m 'x'", true);

    expect(types).not.toContain("repository.changed");
  });
});
