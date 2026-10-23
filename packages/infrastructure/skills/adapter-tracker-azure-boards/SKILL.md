---
name: adapter-tracker-azure-boards
description: Azure Boards (Azure DevOps Services) `tracker` toolchain adapter (TRD-2026-8d825f54 TRD-033, PRD REQ-016). Loaded by the toolchain resolver, not invoked directly by name.
---

# Azure Boards Tracker Adapter

This is a `tracker`-only toolchain adapter (`adapter: azure-boards`) for Azure Boards,
selectable by setting `tracker: azure-boards` in `toolchain.yaml`, or auto-selected when the
repo's `origin` remote matches `dev.azure.com`/`visualstudio.com` (see "Manifest" below). It is
a skill directory, not a command: the toolchain resolver
(`packages/development/lib/toolchain/adapters.js#loadAdapter`) loads its `adapter.yaml`
manifest and runs its capabilities through
`packages/development/lib/toolchain/runner.js#runCapability`. Nothing in this repo invokes
`az` directly through this skill's own prose; the manifest is the contract (same "manifest plus
runner" interpretation `adapter-tracker-beads`/`adapter-tracker-jira` each document).

Backing tool: the `az` CLI with the `azure-devops` extension
(`az extension add --name azure-devops`), Microsoft's official CLI for Azure DevOps. This
adapter targets **Azure DevOps Services (cloud) only** -- the `azure-devops` CLI extension does
not support Azure DevOps Server (TRD-033's own explicit scope). It needs network access and an
authenticated `az` session (either an interactive/device-code/service-principal `az login`, or
the `AZURE_DEVOPS_EXT_PAT` environment variable the extension itself reads for non-interactive
auth), unlike the credential-free `beads` adapter.

## Vocabulary

- `tracker.show`: read a single work item by id (`az boards work-item show --id <id> --expand relations --query ... --output json`)
- `tracker.list`: query work items by WIQL (`az boards query --wiql <query> --output json`)
- `tracker.create`: create a new work item (`az boards work-item create --type ... --title ... --description ...`)
- `tracker.update`: transition a work item to a new Azure Boards state (`az boards work-item update --id <id> --state <fields>`)
- `tracker.close`: close a work item by transitioning it to the "Closed" state (`az boards work-item update --id <id> --state Closed`)
- `tracker.comment`: add a discussion comment to a work item (`az boards work-item update --id <id> --discussion <text>`)
- `tracker.dep-add`: add a dependency link to another work item (`az boards work-item relation add --id <id> --relation-type <type> --target-id <dependsOnId>`)

Azure Boards' documented vocabulary also includes area/iteration path management
(`az boards area`/`az boards iteration`), `az boards work-item relation remove`/`list-type`,
and `az boards work-item delete`; none of these map to a declared `tracker` capability in this
release, so this adapter does not implement them -- see "Manifest" below for which declared,
`required: false` capabilities are also intentionally unimplemented
(`tracker.comments`/`tracker.dep-remove`/`tracker.label`/`tracker.sync`/`tracker.stage-export`).

Required environment variable (`env:` in `adapter.yaml`): `AZURE_DEVOPS_EXT_PAT` -- name only,
OPTIONAL, because `az login` (interactive/device-code/service-principal) also authenticates the
ambient `az` session every capability and health check here shares; this adapter never invokes
`az login` itself. Organization and project are **not** environment variables at all (Microsoft's
own Azure DevOps CLI documentation defines none for either) -- they come from
`az devops configure --defaults organization=<url> project=<name>`, a one-time local CLI
configuration step outside this manifest's own concern.

## Manifest

`adapter.yaml` declares `categories: [tracker]` only, with `contract: {tracker: "1.0"}` --
**no** `work-graph` category. TRD-033's own verbatim text says only "Work-graph ready
capability omitted; links give the fallback", unlike TRD-032's Jira adapter (which DOES
declare `categories: [tracker, work-graph]` while implementing zero `work-graph.*`
capabilities, relying on `work-graph.yaml`'s own `required: false`/`fallback:
work-graph-links-fallback` for every one of its three capabilities). This adapter goes one
step further and does not declare `work-graph` at all: a caller resolving `work-graph` against
a repo where `azure-boards` is the selected `tracker` adapter gets whatever a SEPARATE
`work-graph` adapter (or the unresolved `auto` sentinel) provides, never a contract-version
mismatch or an empty capability set this manifest would otherwise have to carry for no reason.
`tracker.dep-add` IS declared (TRD-033 names it explicitly, using `dependencies[]` derived from
relations as REQ-017's documented fallback for ordered-work-graph needs); the other four
`required: false` `tracker.*` capabilities (`tracker.comments`, `tracker.dep-remove`,
`tracker.label`, `tracker.sync`, `tracker.stage-export`) are not implemented because Azure
Boards' CLI vocabulary this adapter targets has no bulk comment-list, link-remove,
label-replace, flush-to-storage or raw-export-text command this adapter's own capabilities
section maps a run template to -- each resolves `UNAVAILABLE` with its category contract's own
documented fallback rather than a fabricated mapping (same convention `adapter-tracker-jira`'s
own SKILL.md documents for its own unimplemented, `required: false` capabilities).

`detect: [{signal: remote_url_matches, pattern: "dev\\.azure\\.com|visualstudio\\.com"}]` --
`dev.azure.com` is the modern Azure DevOps org URL host, `visualstudio.com` the legacy
(pre-rename) one some organizations still use; either matches this adapter's own origin-remote
auto-selection signal (TRD interpretation I2).

`binaries: [az]` and a single `allowlist[].sub` entry list are the only commands the runner
will ever execute for this adapter. TRD-033 names a 7-entry, binary-plus-subcommand-level
allowlist (`"boards work-item show"`, `"boards work-item create"`, `"boards work-item
update"`, `"boards query"`, `"boards work-item relation add"`, `"devops configure"`, `"account
show"`) -- this is the multi-word `allowlist[].sub` support this wave's engine fix
(`validate.js`/`runner.js#matchesSubcommandWords`) exists to permit: each entry matches the
argv elements immediately after `az` POSITIONALLY, word-by-word (`az boards` alone never
matches a declared `"boards work-item show"` entry; only an argv that has `boards`,
`work-item`, `show` as its first three elements after the binary does). This manifest adds two
MORE entries beyond TRD-033's seven -- `"--version"` and `"extension show"` -- so its own
`az-installed`/`az-devops-extension-installed` health checks also pass
`validate.js#validateAllowlist` (that static validator checks every declared `health[]` entry's
`run`, not only capability `run[]` templates), mirroring `adapter-tracker-jira`'s own
analogous `"--version"` addition beyond its capability-only allowlist.

## Known limits

- **Dotted Azure field names AND relation reshaping vs. the engine -- a hybrid of `az`'s own
  `--query` (JMESPath) for scalars, plus a new `mapping.js` engine extension (`arrayMap`) for
  the one thing `--query` turned out unable to do at all.** `packages/development/lib/
  toolchain/mapping.js`'s dotted-path grammar supports only `$`, `$.a.b` (ONE path segment per
  `.`, literal nested-object traversal), `$[0]`, and `a|b` alternation -- there is no
  escaping/quoting syntax for a property name that itself contains a literal `.`. The real
  Azure DevOps REST API nests custom/system fields as `{"fields": {"System.Title": "...",
  "System.State": "Active", ...}}` -- `fields` has keys LITERALLY named
  `"System.Title"`/`"System.State"` (one key, containing a dot), never a nested
  `fields.System.Title` object `mapping.js`'s `$.fields.System.Title` path could walk into.
  `az`'s own `--query` flag (a real, documented `az` CLI feature, JMESPath) solves this for
  SCALAR fields: JMESPath supports quoted-identifier access for dotted keys
  (`fields."System.Title"`), and a JMESPath multi-select LIST (`[expr1, expr2, ...]`, square
  brackets) turns several such scalars into one flat JSON array BEFORE `mapping.js` ever sees
  the output, which its own `$[0]`/`$[1]`/... index paths then trivially pick apart. This
  adapter's `tracker.show`/`tracker.close` run templates use exactly this.
  **A JMESPath multi-select HASH (`{key: expr, ...}`), however, turned out to be categorically
  unusable in ANY `run[]` template, not just for dotted keys** -- confirmed empirically while
  building this adapter: `packages/development/lib/toolchain/runner.js#buildArgv`'s
  placeholder substitution (`PLACEHOLDER_REPLACE_PATTERN = /\{([^{}]+)\}/g`) scans every
  `run[]` argv element for BARE `{...}` text and unconditionally treats ANY match as an
  unresolved `{name}` placeholder needing substitution via `resolveArg(name, ...)` -- it does
  not distinguish "this came from this adapter's own `${name}` placeholder" from "this is a
  literal brace `az`'s query syntax needs", so it throws `INVALID_ARG` naming the hash's own
  text as an unknown argument. Even the simplest single-field `--query "{id: to_string(id)}"`
  fails this way (`INVALID_ARG: 'id: to_string(id)': no value supplied...`), independent of
  whether the hash ever needed to rename a dotted key. This made the original plan (use
  `--query` to both flatten AND reshape `relations[]` into `dependencies: [{id, type}, ...]`
  via `relations[?attributes.name=='Predecessor'].{id: url, type: attributes.name}`)
  impossible: there is no JSON-object construction in JMESPath that does not require `{}`
  somewhere, so no `--query` expression can ever build a renamed-key object through this
  engine. For the five `${id}`-only mutating capabilities (`tracker.create`/`update`/`close`
  [id half]/`comment`/`dep-add`), this adapter sidesteps the problem entirely by using a BARE
  JMESPath function call with no `{}`/`[]` at all (`--query "to_string(id)"`, printing a plain
  JSON string) and `parse.map: {id: "$"}` (`resolvePath`'s own documented "`$` alone resolves
  to the whole base value" rule) -- but `dependencies[]` genuinely needs a renamed-key object
  per kept relation, which no `--query` expression can produce. This adapter therefore falls
  back to extending `mapping.js` itself (TRD-033's own anticipated "Option 2", engine change):
  a new `parse.arrayMap` block (see that module's own header, "`arrayMap` per-item array
  filter + reshape") resolves `tracker.show`'s own `$[6]` (the RAW, unfiltered, unrenamed
  `relations` array `--query` passes through untouched -- a bare identifier reference, no
  `{}` needed), filters it down to the `Predecessor`-named relation(s), and reshapes each kept
  item into `{id, type}` -- entirely inside `mapOutput`, never inside a `run[]` template.
  Mutation-proven tests for this new engine behavior live in
  `scripts/tests/toolchain-mapping.test.js` (`describe('mapOutput: parse.arrayMap ...')` and
  `describe('mutation-restore proof: parse.arrayMap ...')`), separate from this adapter's own
  test suite.
- **`dependencies[].id` is a full relation `url`, not a short work-item id.** The real Azure
  DevOps REST API's relation object exposes only a full URL
  (`https://dev.azure.com/<org>/<project>/_apis/wit/workItems/456`), never a bare numeric id
  like `456` on the relation itself. Extracting just the trailing `456` requires string
  parsing (e.g. a `split`/regex-match operation) that plain JMESPath has no builtin function
  for (JMESPath's `ends_with`/`starts_with`/`contains` only ever return booleans, never extract
  a substring; there is no `split` function in JMESPath's builtin set at all). This adapter
  accepts the full relation `url` as `dependencies[].id` -- still a valid, non-empty string
  satisfying the normalized schema's `minLength: 1` requirement, just not a bare work-item id a
  caller could feed straight back into `tracker.show`'s own `${id}` placeholder without first
  parsing the trailing path segment itself.
- **`tracker.show`'s `priority` is the literal 4-character string `"null"` when a work item
  type has no `Microsoft.VSTS.Common.Priority` field.** `to_string(fields.
  "Microsoft.VSTS.Common.Priority")` converts Azure's numeric Priority field (e.g. `2`) to the
  string the normalized schema requires (e.g. `"2"`); JMESPath's `to_string()` function returns
  the JSON-encoded representation of its argument when that argument is not already a string,
  and the JSON encoding of `null` is the 4-character text `null` -- so an absent Priority field
  normalizes to the string `"null"`, not an actual missing/undefined `priority` property. This
  still satisfies the normalized schema (which only requires `priority`, when present, to be a
  `string`, with no further constraint), but a caller must treat this literal distinctly from a
  real priority value.
- **`tracker.show`'s `labels` is never populated.** Azure Boards' closest equivalent,
  `System.Tags`, is a single semicolon-separated STRING (e.g. `"tag1; tag2"`), not an array;
  the normalized schema's `labels` field wants a string ARRAY. Neither `az`'s `--query`
  (JMESPath has no `split` function) nor `mapping.js`'s own dotted-path grammar (no string
  operations at all) can turn one into the other, so this adapter omits `labels` entirely
  rather than fabricate a one-element array or a raw unsplit string in its place --
  normalized-output fields are legitimately optional (only `id` is required).
- **`tracker.show`/`tracker.close`'s `statusMap` only recognizes `New`/`Active`/`Closed`**
  (TRD-033's own verbatim three-state list). Real Azure Boards process templates commonly also
  use `Resolved`/`Removed` (Agile/Scrum/CMMI) or `To Do`/`Doing`/`Done` (Basic process); none of
  these are in this adapter's `statusMap`, so a work item in one of those states fails CLOSED
  with `BAD_OUTPUT` naming the unmapped raw value
  (`mapping.js#mapOutput`'s own documented "an unmapped value yields BAD_OUTPUT" behavior),
  rather than silently guessing a normalization.
- **`tracker.close` always requests the literal `"Closed"` state**, never `"Done"`. TRD-033's
  own phrasing, "tracker.close (state Closed/Done)", names both because Azure Boards' terminal
  state name varies by process template (Agile/Scrum/CMMI use "Closed"; the Basic process uses
  "Done" instead, and has no "Closed" state at all); the category contract's `tracker.close`
  declares only `[id]` as an input (no status value this run template's fixed argv could
  substitute), so one literal must be chosen. A caller on a Basic-process project needing
  "Done" instead must call `tracker.update` directly with `fields: "Done"` rather than
  `tracker.close`.
- **The `az-boards-reachable` health check's `--top 1` flag is not a real, documented `az
  boards query` option.** TRD-033's own verbatim text directs this exact argv (`az boards
  query --wiql "SELECT [System.Id] FROM WorkItems" --top 1`); the real `az boards query`
  command's documented options are only `--id`/`--org`/`--path`/`--project`/`--team`/`--wiql`
  -- no `--top`. This manifest keeps the TRD's literal text rather than silently substituting
  a corrected `SELECT TOP 1 [System.Id] FROM WorkItems` WIQL clause, since no real `az` binary
  is installed in this environment to confirm either form live; a live run of this health
  check would need that correction first.
- **`fixtures/az-boards-help.txt` is a synthetic reconstruction, not a captured live `az
  boards --help`/`az boards work-item --help`/`az boards query --help` run.** No `az` binary
  is installed in this environment. The fixture was built from TRD-033's own verbatim text
  together with this adapter's author's own independently-verifiable knowledge of the real,
  publicly-documented `az boards`/`az devops`/`az account`/`az extension` command surface
  (Microsoft's own Azure CLI reference), extended beyond the three `--help` invocations
  TRD-033 names so every `allowlist[].sub` entry (including the two health-check-only entries,
  `--version` and `extension show`, and the organization/project configuration commands,
  `devops configure` and `account show`) has something to be cross-checked against -- labeled
  synthetic throughout regardless, per TRD-033's own Implementation AC 4.
- **No `work-graph.*` capability is implemented.** See "Manifest" above -- this adapter does
  not even declare the `work-graph` category; a caller needing ordered/ready work against an
  Azure-Boards-tracked repo must resolve a different `work-graph` adapter.
- **No `tracker.comments`/`tracker.dep-remove`/`tracker.label`/`tracker.sync`/
  `tracker.stage-export` capability is implemented.** All five are `required: false`; the
  Azure Boards vocabulary this adapter targets has no bulk comment-list, link-remove,
  label-replace, flush-to-storage or raw-export-text command this adapter maps a run template
  to, so each resolves `UNAVAILABLE` with its category contract's own documented fallback.
- **`tracker.create`/`tracker.update`/`tracker.close`/`tracker.comment`/`tracker.dep-add`'s
  exact JSON shapes are inferred, not independently captured live.** No `az` binary is
  installed in this environment; these mutating commands' `--query`-flattened output shapes
  follow the same `to_string(id)` convention `tracker.show` is built from, by analogy, not a
  captured live sample.
