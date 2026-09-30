import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  CompiledBehaviorArtifacts,
  CompiledBehaviorPackage,
  MutationGuard,
  ToolDescriptor,
  ToolRegistry,
  createMutationGuard,
} from "@sunstone-partners/ensemble-agent-core";
import { wireToolGrantEnforcement } from "./tool-grant-enforcement";

/**
 * Loads one compiled behavior's artifacts into a live Pi session
 * (TRD-014/AC-014-1):
 *
 * - `promptMarkdown` is exposed as a real Pi custom command
 *   (`pi.registerCommand`), whose handler sends it into the session via
 *   `pi.sendUserMessage` — the confirmed, documented way to deliver
 *   prompt content into a running session.
 * - `skillMarkdown` is exposed through the same command's `--skill`
 *   argument, returned verbatim without triggering a turn. Pi's own
 *   skill-directory auto-discovery (`.pi/agent/extensions/skills/`) is
 *   a filesystem convention, not an ExtensionAPI call, so this package
 *   does not fabricate a registration API that does not exist.
 * - governed tools (`artifacts.toolNames`, already filtered to ones
 *   with a real descriptor in `availableTools`) are registered via
 *   `pi.registerTool`, reusing the same ToolRegistry grant boundary
 *   established in TRD-005 (grant applies per session, per tool name).
 * - the compiled behavior's full `capabilities.tools` grant (including
 *   Pi's own native tools, not just governed custom ones) is enforced
 *   at the `tool_call` boundary via `wireToolGrantEnforcement`
 *   (TRD-018) — independent of `availableTools`/`artifacts.toolNames`,
 *   which only control what gets *registered*, not what Pi is allowed
 *   to *execute*.
 *
 * Reuses `packages/pi`'s existing generator output *shape* conceptually
 * (name/description/content) without importing from or modifying
 * `packages/pi` itself — this task's two target packages are
 * `agent-core` and `pi-extension` only (AC-014-2: packages/pi is
 * untouched, so its existing generated artifacts cannot regress).
 */
export function loadCompiledBehavior(
  pi: ExtensionAPI,
  compiled: CompiledBehaviorPackage,
  artifacts: CompiledBehaviorArtifacts,
  availableTools: readonly ToolDescriptor<Record<string, unknown>, unknown>[],
  guard: MutationGuard = createMutationGuard(compiled),
): void {
  // TRD-004 / AC-011-2: fail closed. A manifest asking for `auto`
  // (direct, unreviewed mutation authority) must never load into a
  // harness where mutation-class enforcement is not actually wired —
  // degrading silently to unenforced auto-apply is strictly worse
  // than refusing to load.
  if (compiled.manifest.policy.mode === "auto" && !guard.enforcementActive) {
    throw new Error(
      `refusing to load behavior "${compiled.manifest.metadata.name}": policy.mode is "auto" ` +
        `but mutation-class enforcement is not active in this harness. ` +
        `Unenforced auto-apply is not a supported degraded mode.`,
    );
  }

  // A declared tool that resolves to nothing is a capability the behavior
  // can never exercise. Filtering it out silently (the prior behavior) made
  // a misconfigured manifest indistinguishable from a correct one:
  // investigate-test-failure declared `bash.test`, got no test-running
  // ability at all, and reported nothing. Warn loudly; do not refuse,
  // since a behavior may legitimately run with a reduced toolset.
  if (artifacts.unresolvedTools.length > 0) {
    const message =
      `behavior "${compiled.manifest.metadata.name}" declares tool(s) that resolve to nothing: ` +
      `[${artifacts.unresolvedTools.join(", ")}]. They are neither registered ToolDescriptors nor ` +
      `known native host tools, so the behavior cannot use them and will run without those ` +
      `capabilities.`;
    console.warn(`[ensemble] ${message}`);
  }

  wireToolGrantEnforcement(pi, compiled);

  // `/behavior-name` DESCRIBES the behavior; it does not run it (br-p7gr).
  //
  // This used to call `pi.sendUserMessage(artifacts.promptMarkdown)`, which
  // pasted the behavior's prompt into the conversation as a follow-up. That
  // gave a behavior two routes to the model with very different properties:
  //
  //   automatic: event -> trigger -> interpreter -> command registry -> guard
  //   manual:    /name -> prompt in the conversation, none of the above
  //
  // The manual route was not a safety hole in the way the old continuation
  // path was — it is user-initiated, so attribution is unambiguous and any
  // tool use is the user's own session under its normal rules. It was
  // something subtler: a behavior authored as a bounded workflow (steps,
  // timeouts, conditions, approval gates, declared commands) silently
  // degraded to unstructured prose, and the person invoking it had no signal
  // that the version they got was not the version that was tested.
  //
  // Running the interpreter here instead was considered and rejected. These
  // behaviors are event-triggered: their workflows reference
  // `${event.payload...}`, and a manual invocation has no triggering event,
  // so the run would fail on reference resolution. "Manually run an
  // event-driven behavior" is not a well-defined request, and inventing an
  // empty event to satisfy it would be a third execution shape rather than a
  // fix. Section 7 of the CQRS requirements is precisely about not
  // maintaining several ways to run a behavior.
  pi.registerCommand(artifacts.commandName, {
    description: `Describe behavior: ${artifacts.behaviorName} (does not run it)`,
    async handler(args, ctx) {
      if (args.trim() === "--skill") {
        ctx.ui.setStatus?.(artifacts.commandName, artifacts.skillMarkdown);
        return;
      }
      const trigger = compiled.manifest.trigger.event_type;
      const mode = compiled.manifest.policy.mode;
      const commands = compiled.commands.join(", ") || "(none)";
      ctx.ui.setStatus?.(
        artifacts.commandName,
        [
          `# ${artifacts.behaviorName}`,
          "",
          `This behavior runs when \`${trigger}\` occurs. It cannot be run by hand:`,
          `its workflow reads the triggering event, and there is no event here.`,
          "",
          `- **mode**: ${mode}`,
          `- **commands**: ${commands}`,
          "",
          `Use \`${artifacts.commandName} --skill\` for the full description.`,
        ].join("\n"),
      );
    },
  });

  const registry = new ToolRegistry();
  const byName = new Map(availableTools.map((tool) => [tool.name, tool]));

  // All available descriptors are registered so the registry's
  // authorization check is not structurally unreachable. Stated
  // honestly: this alone does NOT create a reachable denial path for
  // ungranted tools, because `pi.registerTool` below is only called
  // for `artifacts.toolNames` — Pi can never dispatch to a tool it was
  // never told about. It is defence-in-depth for direct registry use,
  // not the enforcement boundary.
  //
  // The two mechanisms that actually keep an ungranted tool
  // unreachable in production are:
  //   1. exposure — `artifacts.toolNames` derives from
  //      `capabilities.tools`, so an ungranted tool is never
  //      registered with Pi at all; and
  //   2. `wireToolGrantEnforcement` above, which blocks ungranted
  //      *native* tools (bash/read/write) at the `tool_call` boundary.
  for (const descriptor of availableTools) {
    registry.register(descriptor);
  }

  for (const toolName of artifacts.toolNames) {
    const descriptor = byName.get(toolName);
    if (!descriptor) continue;

    // TRD-003: the grant is derived from the compiled manifest rather
    // than issued unconditionally at call time, as it previously was.
    const grantedByManifest = compiled.hasTool(descriptor.name);

    pi.registerTool({
      name: descriptor.name,
      label: descriptor.name,
      description: descriptor.description,
      parameters: Type.Record(Type.String(), Type.Unknown()),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        if (signal?.aborted) {
          throw new Error("cancelled");
        }
        const sessionId = ctx.sessionManager.getSessionId() ?? "pi-session";
        if (grantedByManifest) {
          registry.grant({ toolName: descriptor.name, grantedTo: sessionId });
        }
        const result = await registry.invoke({
          toolName: descriptor.name,
          args: params,
          requestedBy: sessionId,
        });
        if (result.status === "unauthorized") {
          throw new Error(`unauthorized: ${result.reason}`);
        }
        if (result.status === "error") {
          throw new Error(result.error);
        }
        return { content: [{ type: "text", text: JSON.stringify(result.result) }], details: result.result };
      },
    });
  }
}
