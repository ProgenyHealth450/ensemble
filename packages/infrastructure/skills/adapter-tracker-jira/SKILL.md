---
name: adapter-tracker-jira
description: Jira Cloud `tracker` toolchain adapter (TRD-2026-8d825f54 TRD-032, PRD REQ-016). Loaded by the toolchain resolver, not invoked directly by name.
---

# Jira Cloud Tracker Adapter

This is a `tracker`+`work-graph` toolchain adapter (`adapter: jira`) for Jira Cloud,
selectable by setting `tracker: jira` in `toolchain.yaml` (Jira has no repo-local detection
signal, so it is never auto-selected -- see "Manifest" below). It is a skill directory, not a
command: the toolchain resolver (`packages/development/lib/toolchain/adapters.js#loadAdapter`)
loads its `adapter.yaml` manifest and runs its capabilities through
`packages/development/lib/toolchain/runner.js#runCapability`. Nothing in this repo invokes
`jira` directly through this skill's own prose; the manifest is the contract (same "manifest
plus runner" interpretation `adapter-tracker-beads`'s own `SKILL.md` documents).

Backing tool: the `jira` CLI (`packages/infrastructure/skills/jira/SKILL.md`), a thin wrapper
over the Jira Cloud REST API. This adapter targets **Jira Cloud only** (PRD REQ-016's
first-release scope), authenticated via the three environment variables below -- it needs
network access and a live Atlassian API token, unlike the credential-free `beads` adapter.

## Vocabulary

- `tracker.show`: read a single Jira issue by key (`jira issues read <KEY>`)
- `tracker.list`: list Jira issues (`jira issues list`)
- `tracker.create`: create a new Jira issue (`jira issues create <title> --type ... --description ...`)
- `tracker.update`: transition an existing issue to a new status (`jira issues update <KEY> --status <fields>`)
- `tracker.close`: close an issue by transitioning it to the "Done" status (`jira issues update <KEY> --status Done`)
- `tracker.comment`: add a comment to an issue (`jira comments create <KEY> --body <text>`)
- `tracker.comments`: list the comments on an issue (`jira comments list <KEY>`)

Jira's documented vocabulary also includes issue `transitions` (`jira issues transitions
<KEY>`), issue `search`/`fetch`, sprint/project/user metadata queries, and hierarchy `fetch`
with linked Confluence pages (`packages/infrastructure/skills/jira/SKILL.md`); none of these
map to a declared `tracker`/`work-graph` capability in this release, so this adapter does not
implement them.

Required environment variables (`env:` in `adapter.yaml`): `ATLASSIAN_CLOUD_ID`,
`ATLASSIAN_AUTH_TOKEN`, `ATLASSIAN_SITE_URL` -- names only, as PRD REQ-022 requires; the
literal values live in the `jira` CLI's own `~/utils/atlassian/.env`
(`packages/infrastructure/skills/jira/SKILL.md` lines 42-44), never in this manifest.

## Manifest

`adapter.yaml` declares `categories: [tracker, work-graph]` with `contract: {tracker: "1.0",
work-graph: "2.0"}`, matching the two category contracts' own declared versions, but this
adapter implements **zero** `work-graph.*` capabilities: every `work-graph` capability
(`work-graph.ready`, `work-graph.plan`, `work-graph.graph-health`) is `required: false` with
`fallback: work-graph-links-fallback` in `packages/development/toolchain/categories/
work-graph.yaml`, and the documented Jira vocabulary this adapter is built from has no
issue-link/dependency-graph command at all -- so the category's own fallback applies, exactly
as TRD-032 directs, rather than fabricating work-graph behavior Jira's CLI does not expose.
The same reasoning is why `tracker.dep-add`/`tracker.dep-remove`/`tracker.label`/`tracker.sync`/
`tracker.stage-export` are also not implemented: they are all `required: false` in
`packages/development/toolchain/categories/tracker.yaml`, and the Jira vocabulary this adapter
targets has no corresponding command.

`detect: []` -- Jira Cloud has no repo-local signal (no file, directory or git remote pattern
identifies "this repo uses Jira"); selection is by explicit `toolchain.yaml` configuration
only (TRD interpretation I2).

`binaries: [jira]` and a single `allowlist[].sub: [issues, comments, "--version"]` entry are
the only commands the runner will ever execute for this adapter; the allowlist only
distinguishes by the FIRST subcommand word (`issues`, not `issues read`/`issues list`/`issues
create`/`issues update` separately), matching `validate.js`'s own documented limit. `--version`
is listed solely so the `jira-installed` health check (`jira --version`) passes the allowlist,
the same convention `adapter-tracker-beads`'s own `br --version`/`bv --version` health checks
use.

## Known limits

- **This adapter's allowlist-conformance fixture (`fixtures/jira-help.txt`) is a synthetic
  reconstruction, not a captured live `jira --help` run.** No `jira` binary is installed in
  this environment, and no live `--help` output for it exists anywhere in this repo. The
  fixture was built strictly from `packages/infrastructure/skills/jira/SKILL.md`'s own
  documented command list (its "Quick Command Reference" and "Comments" sections). This is a
  known, accepted risk per TRD-032's own risk register: the real CLI's subcommand names are
  therefore unverified against the live tool, pending a future capture of real `--help`
  output.
- **`tracker.update`'s `fields` input means "the literal Jira status name to transition to,"
  not a JSON patch of arbitrary fields.** The `tracker` category contract's `tracker.update`
  declares one opaque `fields` input substituted into exactly one CLI argument slot (no JSON
  parsing inside a run template is possible -- `packages/development/lib/toolchain/runner.js
  #buildArgv` substitutes named placeholders into a static argv template, it cannot expand one
  input into a variable set of flags). TRD-032 explicitly directs this adapter's
  interpretation as `--status ${fields}`. This is a DELIBERATE, adapter-specific choice,
  exactly as `adapter-tracker-beads`'s own `SKILL.md` documents its own, different
  interpretation of the identical contract slot (`--notes ${fields}`, free-form notes text) --
  a caller moving between the two adapters must pass a different shape of value for `fields`;
  this cross-adapter inconsistency is inherited from the TRD's own category contract design
  (one opaque placeholder, no per-adapter field schema), not something either adapter can
  paper over.
- **`tracker.create`/`tracker.update`/`tracker.comment`'s exact JSON shapes are inferred, not
  independently captured live.** `packages/infrastructure/skills/jira/SKILL.md`'s own jq
  examples only directly document `tracker.show`'s flat-object shape (`.key`, `.summary`,
  `.status`); the mutating commands' output shapes are inferred by analogy (the "Get created
  issue key" example, `jira issues create "Title" --project VA | jq -r '.key'`, confirms
  `tracker.create` at least carries `.key`; `tracker.comment`'s `.id` follows the Jira Cloud
  REST API's own documented comment-object convention, a comment id distinct from the parent
  issue's key).
- **No `work-graph.*` capability is implemented.** See "Manifest" above -- the category's own
  `work-graph-links-fallback` applies; a caller needing ordered/ready work against a
  Jira-tracked repo must resolve a different `work-graph` adapter (or `auto`, once that
  resolver work lands) rather than this one.
- **No `tracker.dep-add`/`tracker.dep-remove`/`tracker.label`/`tracker.sync`/
  `tracker.stage-export` capability is implemented.** All five are `required: false`; the
  documented Jira vocabulary this adapter targets (`packages/infrastructure/skills/jira/
  SKILL.md`) has no issue-link, label-replace, flush-to-storage or raw-export-text command, so
  each resolves `UNAVAILABLE` with its category contract's own documented fallback rather than
  a fabricated mapping.
