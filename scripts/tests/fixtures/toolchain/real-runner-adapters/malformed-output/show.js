'use strict';

/**
 * Real-process fixture for scripts/tests/toolchain-mapping.test.js's "runCapability: two real
 * adapters, same category, both normalize through the real spawned-process path" describe
 * block (TRD-012-TEST, br-84tv, PRD REQ-002 AC-002-2, REQ-022 AC-022-2).
 *
 * Invoked for real (via `node show.js --id <id>`) by `runner.js#runCapability`, standing in for
 * a tool that never reports a work item id: prints a raw JSON object missing the `id` field the
 * normalized work-item schema requires
 * (`packages/development/toolchain/schemas/normalized/work-item.json`, `required: ["id"]`) --
 * this is TRD-012's own Implementation AC line 286 example ("tool stdout missing required field
 * id"), proven here through a real spawned process rather than a direct `mapOutput`/
 * `runCapability` call against canned in-memory stdout.
 *
 * Exits without calling `process.exit()` (see `jira-nested/show.js`'s identical rationale).
 */

process.stdout.write(JSON.stringify({ title: 'No id anywhere in this output' }));
