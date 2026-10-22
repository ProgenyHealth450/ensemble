'use strict';

/**
 * Real-process fixture for scripts/tests/toolchain-mapping.test.js's "runCapability: two real
 * adapters, same category, both normalize through the real spawned-process path" describe
 * block (TRD-012-TEST, br-84tv, PRD REQ-002 AC-002-2, REQ-022 AC-022-2).
 *
 * Invoked for real (via `node show.js --id <id>`) by `runner.js#runCapability`, standing in for
 * a Jira-like tracker tool: prints a nested raw JSON shape (`issues[0].fields.*`) that the
 * calling test's `parse.map` dotted paths project into the normalized `{id, title, status}`
 * work-item shape. The `--id` argv value is accepted (so the real `runCapability` runtime
 * allowlist/argv-substitution path is exercised) but ignored: the canned output below is fixed
 * so the test's expectations stay deterministic.
 *
 * Exits without calling `process.exit()`: letting the process complete naturally avoids Node's
 * documented async-pipe-write-then-forced-exit race that can truncate a piped stdout write
 * (`real-ledger-steps/succeed.js`'s own documented rationale).
 */

process.stdout.write(
  JSON.stringify({
    issues: [
      {
        key: 'JIRA-1',
        fields: { summary: 'Fix the bug', status: 'In Progress' }
      }
    ]
  })
);
