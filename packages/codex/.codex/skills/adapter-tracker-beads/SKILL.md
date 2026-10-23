---
name: adapter-tracker-beads
description: Default `tracker`+`work-graph` toolchain adapter for the `br`/`bv` beads issue tracker (TRD-2026-8d825f54 TRD-024, PRD REQ-006/REQ-020). Loaded by the toolchain resolver, not invoked directly by name.
user-invocable: true
---

# Beads Tracker Adapter

This is the DEFAULT adapter (`adapter: beads`) for the toolchain's `tracker` and
`work-graph` categories, matching `toolchain.default.yaml`'s `tracker: beads` /
`work-graph: auto` defaults. It is a skill directory, not a command: the toolchain
resolver (`packages/development/lib/toolchain/adapters.js#loadAdapter`) loads its
`adapter.yaml` manifest and runs its capabilities through
`packages/development/lib/toolchain/runner.js#runCapability`. Nothing in this repo
invokes `br`/`bv` directly through this skill's own prose; the manifest is the
contract (TRD interpretation B: "manifest plus runner").

Backing tools: [`br`](https://github.com/steveyegge/beads) (the issue tracker CLI,
SQLite + JSONL) and [`bv`](https://github.com/steveyegge/beads) (`bv`, the companion
robot-triage/planning viewer). Both run entirely against the local `.beads/` workspace;
neither needs network access or a credential.

## Vocabulary

- `tracker.show`: read a single beads issue by id (`br show <id> --json`)
- `tracker.list`: list beads issues (`br list --all --limit 0 --json`)
- `tracker.create`: create a new beads issue (`br create --title ... --type ... -d ...`)
- `tracker.update`: append free-form notes to an existing issue (`br update <id> --notes ...`)
- `tracker.close`: close a beads issue (`br close <id>`)
- `tracker.comment`: add a comment to an issue (`br comments add <id> <text>`)
- `tracker.comments`: list the comments on an issue (`br comments list <id>`)
- `tracker.dep-add`: add a dependency link (`br dep add <id> <dependsOnId> --type ...`)
- `tracker.dep-remove`: remove a dependency link (`br dep remove <id> <dependsOnId>`)
- `tracker.label`: add label(s) to issue(s) (`br label add <ids> -l <labels>`)
- `tracker.sync`: flush local tracker state to durable storage (`br sync --flush-only`)
- `work-graph.ready`: ready (unblocked) work, bv's own order (`bv --robot-plan --format json`)
- `work-graph.plan`: dependency-respecting execution plan (`bv --robot-plan --format json`)
- `work-graph.graph-health`: dependency-graph health signals, e.g. cycles (`bv --robot-insights --format json`)

Required environment variables (`env: []` in `adapter.yaml`): **none**. `br`/`bv` read
the repo-local `.beads/` directory directly; no credential or API token is needed.

## Manifest

`adapter.yaml` declares every capability's exact `run[]` argv template and `parse`
output-mapping block (see that file's own comments for the reasoning behind each
mapping, not repeated here). `binaries: [br, bv]` and a per-binary `allowlist[].sub`
(`validate.js#validateAllowlist`/`runner.js#denyRuntimeAllowlist`) are the only
commands the runner will ever execute for this adapter; the allowlist only
distinguishes by the FIRST subcommand word (e.g. `dep`, not `dep add`/`dep remove`
separately), matching `validate.js`'s own documented limit.

## Known limits

- **`tracker.list`/`tracker.comments`/`tracker.label`/`tracker.sync` declare no
  `parse` block.** `runner.js`'s `CATEGORY_NORMALIZED_SCHEMA` Ajv-validates a mapped
  `tracker.*` capability's output against the single-work-item schema
  (`work-item.json`, `required: ["id"]`) per CATEGORY, not per capability. Verified
  empirically: a `parse` block mapping `br list`'s wrapped output to `{items:[...]}`
  always fails that gate with `BAD_OUTPUT: missing required property 'id'`, since a
  list/labels/sync result structurally has no top-level `id`. These four capabilities
  therefore return their tool's raw JSON stdout as `data` (unparsed); a caller parses
  it directly, exactly as `packages/development/lib/trd-cli.js#getBeadCounts` already
  does for `br list` (`Array.isArray(parsed) ? parsed : parsed.issues || []`).
- **`tracker.list`'s "bare array vs `{issues:[...]}`" br-version variance is not, and
  cannot be, handled by this adapter's declarative mapping even if it DID declare a
  `parse` block.** The shared mapping engine's dotted-path grammar
  (`packages/development/lib/toolchain/mapping.js`) has no operator that branches on
  whether a value is an array or an object at the SAME path -- its documented `|`
  alternation only chooses between two property NAMES on an object (its own worked
  example is exactly this adapter's `tracker.list` key-name case, `$.issues|issue`),
  never between "treat the value as the list itself" and "look inside a wrapper
  property". `br list --all --json` on the currently pinned `br` (0.6.0) always wraps
  (`{issues:[...], total, limit, offset, has_more}`); `trd-cli.js#getBeadCounts`'s own
  defensive `Array.isArray(parsed) ? parsed : ...` check (plain JS, not this
  declarative engine) is what actually protects callers against an older br's bare
  array, same as it always has.
- **`work-graph.ready`/`work-graph.plan` surface only `bv`'s first execution track**
  (`plan.tracks[0].items`), not every actionable item across every track. `bv
  --robot-plan`'s JSON groups ready work into parallel tracks
  (`plan.tracks[].items[]`); the mapping engine has no flatten/concat operator to
  combine them into one ordered array, so this adapter surfaces `tracks[0]` (bv's own
  highest-impact track) rather than silently re-sorting or inventing a combined
  ordering. `bv`'s own `usage_hints` field documents the jq filter
  (`[.plan.tracks[].items[]]`) a caller needing the full set should use directly.
- **`work-graph.plan`'s `orderingSource`/`dependencyAware` fields are not populated.**
  `mapOutput`'s `map` values are always dotted paths resolved against the tool's real
  JSON, never literal constants, and `bv`'s JSON has no field directly answering "is
  this dependency-aware"; this adapter omits both rather than fabricate a value
  through a path that does not mean that (normalized-output fields are legitimately
  optional, and `work-graph` has no Ajv schema gate at all, unlike `tracker`).
- **`tracker.create`/`update`/`close`/`comment`/`dep-add`/`dep-remove`'s exact JSON
  shapes are inferred, not independently captured live.** These are mutating `br`
  commands this task may not invoke for real against a live workspace. `br schema
  commands` (a read-only, machine-readable envelope-shape command) documents every
  single-entity `br` command it does cover (`show`, `dep tree`, `label list`,
  `comments list`, `stale`, `ready`) as `shape: "array"`; `tracker.show`'s own `root:
  "$[0]"` is independently confirmed live. The mutating capabilities above reuse that
  same `root: "$[0]"` array-of-one convention by inference from this documented
  pattern, not a captured live sample.
