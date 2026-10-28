'use strict';

/**
 * Real-process fixture for scripts/tests/toolchain-mapping.test.js's "runCapability: two real
 * adapters, same category, both normalize through the real spawned-process path" describe
 * block (TRD-012-TEST, br-84tv, PRD REQ-002 AC-002-2, REQ-022 AC-022-2).
 *
 * Invoked for real (via `node show.js --id <id>`) by `runner.js#runCapability`, standing in for
 * a flat, simple-tracker tool: prints a flat raw JSON shape (`{id, title, status}` already at
 * the top level) -- deliberately a different raw shape than `jira-nested/show.js`'s nested one,
 * so the calling test proves two structurally different tools both normalize into the same
 * contract shape. The `--id` argv value is accepted but ignored, same rationale as the sibling
 * fixture.
 *
 * Exits without calling `process.exit()` (see `jira-nested/show.js`'s identical rationale).
 */

process.stdout.write(JSON.stringify({ id: 'FLAT-9', title: 'Fix the bug', status: 'open' }));
