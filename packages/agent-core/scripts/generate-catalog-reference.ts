/**
 * Generates `docs/architecture/behavior-command-event-reference.md` from the
 * command catalog and the event authority.
 *
 * A reference table maintained by hand is a reference table that is wrong six
 * weeks later, and wrong documentation about an authorization boundary is
 * worse than none: it tells an author a command needs approval when it does
 * not. So the catalog is the source and the document is the artifact.
 *
 * `tests/catalog-reference.test.ts` regenerates and compares, so drift fails
 * the build rather than surviving to a reader.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCommandCatalog } from "../src/cqrs/commands";
import { ProposalStore } from "../src/cqrs/proposal-store";
import { eventTypes, lookupEvent, ACCEPTANCE_GUARANTEES, AUTHORITATIVE_AUTHORITIES } from "../src/cqrs/event-authority";
import type { FieldSchema } from "../src/cqrs/field-schema";

function fields(schema: FieldSchema | undefined): string {
  if (!schema || schema.type !== "object" || !schema.fields) return "—";
  const names = Object.entries(schema.fields).map(([name, f]) => {
    const optional = (f as { optional?: boolean }).optional ? "?" : "";
    return `\`${name}${optional}: ${(f as { type: string }).type}\``;
  });
  return names.length ? names.join(", ") : "—";
}

export function renderReference(): string {
  // The root is irrelevant: nothing is read or written, the descriptors are
  // only being inspected.
  const catalog = createCommandCatalog({
    workspaceRoot: "/nonexistent",
    store: new ProposalStore("/nonexistent"),
  });

  const lines: string[] = [];
  lines.push("# Behavior command and event reference");
  lines.push("");
  lines.push("- **Status:** Generated. Do not edit by hand.");
  lines.push("- **Source:** `packages/agent-core/src/cqrs/commands.ts`, `packages/agent-core/src/cqrs/event-authority.ts`");
  lines.push("- **Generator:** `packages/agent-core/scripts/generate-catalog-reference.ts`");
  lines.push("- **Drift check:** `packages/agent-core/tests/catalog-reference.test.ts`");
  lines.push("");
  lines.push("Regenerate with `npx ts-node packages/agent-core/scripts/generate-catalog-reference.ts`.");
  lines.push("");

  lines.push("## Commands");
  lines.push("");
  lines.push(
    "Every command runs through one registry. Authorization is checked in a fixed order — capability, " +
      "input schema, mutation class, policy mode, approval — before any handler runs, and the same code " +
      "decides for a direct tool call and a workflow step. A behavior may only invoke a command it lists " +
      "in `capabilities.commands`.",
  );
  lines.push("");
  lines.push("| Command | Capability | Mutates | Approval | Emits |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const d of catalog) {
    const mutates = d.mutation ? `\`${d.mutation.class}\` (${d.mutation.kind})` : "no";
    const approval = d.requiresApproval ? "**required**" : "no";
    const emits = d.emits.length ? d.emits.map((e) => `\`${e}\``).join(", ") : "—";
    lines.push(`| \`${d.id}\` | \`${d.requiredCapability}\` | ${mutates} | ${approval} | ${emits} |`);
  }
  lines.push("");

  for (const d of catalog) {
    lines.push(`### \`${d.id}\` v${d.version}`);
    lines.push("");
    lines.push(d.description);
    lines.push("");
    lines.push(`- **Input:** ${fields(d.input)}`);
    lines.push(`- **Result:** ${fields(d.result)}`);
    lines.push("");
  }

  lines.push("## Events");
  lines.push("");
  lines.push(
    "The catalog is closed: a command may not emit an event that is not listed here, and registration " +
      "fails at build time if a descriptor declares one. `producer` distinguishes events the runtime " +
      "stamps from events a handler returns.",
  );
  lines.push("");
  lines.push(
    "Authority is the claim strength of the event. " +
      `Only ${AUTHORITATIVE_AUTHORITIES.map((a) => `\`${a}\``).join(" and ")} are authoritative — ` +
      "the registry withholds those from a handler that only reported `accepted`, so a proposal cannot " +
      "describe itself as an applied change.",
  );
  lines.push("");
  lines.push("| Event | Schema | Authority | Producer | Payload |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const type of eventTypes()) {
    const e = lookupEvent(type);
    if (!e) continue;
    lines.push(
      `| \`${e.type}\` | ${e.schemaVersion} | \`${e.authority}\` | ${e.producer} | ${fields(e.payload)} |`,
    );
  }
  lines.push("");

  lines.push("## Acceptance scopes");
  lines.push("");
  lines.push(
    "What it means for an event to be accepted. There is deliberately no `foreman` scope: Ensemble " +
      "cannot make a durable-delivery claim it has no mechanism to honour, so the claim is not expressible.",
  );
  lines.push("");
  lines.push("| Scope | Guarantee |");
  lines.push("| --- | --- |");
  for (const [scope, guarantee] of Object.entries(ACCEPTANCE_GUARANTEES)) {
    lines.push(`| \`${scope}\` | ${guarantee} |`);
  }
  lines.push("");

  return lines.join("\n");
}

export const REFERENCE_PATH = join(__dirname, "..", "..", "..", "docs", "architecture", "behavior-command-event-reference.md");

if (require.main === module) {
  writeFileSync(REFERENCE_PATH, renderReference(), "utf8");
  process.stdout.write(`wrote ${REFERENCE_PATH}\n`);
}
