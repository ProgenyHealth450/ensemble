# adapter-tracker-beads sample captures

Read-only samples captured live from this workspace's real `.beads/` database
(TRD-2026-8d825f54 TRD-024), used only as reference for designing
`packages/development/skills/adapter-tracker-beads/adapter.yaml`'s `parse` blocks and
for comparing shapes in that adapter's test suite. These are NOT golden fixtures a test
asserts byte-for-byte equality against (they embed this machine's live bead ids, local
paths and timestamps, which are not reproducible elsewhere); the adapter's own tests use
the small, deterministic stub `br`/`bv` scripts in
`scripts/tests/fixtures/toolchain/adapter-tracker-beads-stub.js` instead.

Captured with (all read-only, no `.beads/` mutation):

- `br-show.sample.json`: `br show br-yqqu --json` (br 0.6.0)
- `br-list.sample.json`: `br list --all --limit 5 --json` (br 0.6.0)
- `br-schema-commands.sample.json`: `br schema commands` (br 0.6.0) — the per-command
  JSON output envelope-shape map `br` itself documents; used to infer the output shape
  of mutating commands (`create`/`update`/`close`/`comments add`/`dep add`/`dep remove`)
  this task may not invoke for real (see the adapter's `SKILL.md` "Known limits").
- `bv-robot-plan.sample.json`: `bv --robot-plan --format json` (bv v0.25.2)
- `bv-robot-insights.sample.json`: `bv --robot-insights --format json` (bv v0.25.2)
