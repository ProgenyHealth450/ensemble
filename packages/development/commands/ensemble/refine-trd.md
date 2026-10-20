---
name: "ensemble:refine-trd"
description: "Refine and enhance existing TRD with stakeholder feedback and additional detail"
version: "2.7.0"
category: "planning"
last-updated: "2026-08-22"
model: "opus"
---
<!-- DO NOT EDIT - Generated from refine-trd.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Refine an existing TRD from stakeholder feedback, research, or identified gaps, preserving version history, traceability, and Design Readiness scoring.

## Arguments

- **`collab`** (boolean, optional, default: `false`): Browser-based collaborative refinement (sidebar questions, anchor-linked comments) replacing the terminal interview. The session artifact feeds the Enhancement phase. Details: docs/guides/refinement-review-collab.md.
- **`tunnel`** (string, optional, default: `""`): `quick` exposes the review server over a Cloudflare Quick Tunnel (`*.trycloudflare.com`) so reviewers on other networks can reach it. Requires `cloudflared` on PATH (or CLOUDFLARED_PATH). Empty: local only.
- **`reviewers`** (integer, optional, default: `1`): Number of independent single-use reviewer share URLs to mint (1 = the original URL; N > 1 adds N-1 via `server.createShareUrl()`).
- **`long-lived`** (boolean, optional, default: `false`): One reusable invite URL with a TTL (default 6h) that any number of reviewers can open; implies `--tunnel=quick`; mutually exclusive with `--reviewers`.
- **`ttl`** (string, optional, default: `"6h"`): Long-lived session lifetime (`6h`, `12h`, `1d`); minimum and default `6h`. Only used with `--long-lived`.
- **`foreman`** (boolean, optional, default: `false`): Foreman-native non-interactive mode: skip Synthesis selection and Interview, auto-apply every finding with a best-effort default (or an inline `[NEEDS CLARIFICATION: ...]` marker), and log each choice. Requires an explicit TRD path argument (`--list` is not allowed). Mutually exclusive with --collab/--long-lived. When --foreman is present and FOREMAN_ARTIFACT_PATH is set and non-empty, write the phase report to that exact path (creating parent directories) in addition to any repo-local report. Never invent or alter the path; an unset FOREMAN_ARTIFACT_PATH is not an error.

## Workflow

### Phase 1: Collaborative Review

**1. Session Bootstrap**
   Write a Node bootstrap script under the logs cache (gitignored; `getLogsPath()` or equivalent) and run it in the foreground. The full flag semantics, auth model, and API contracts are in docs/guides/refinement-review-collab.md; the contract you must implement:

1. TRD path = first non-flag token of $ARGUMENTS. Generate 5-10 refinement questions from the TRD: `{ id: 'q-<kebab>', prompt, context (cite the TRD), targetAnchor: { lineStart, lineEnd } (smallest 1-based range; frontmatter questions use {1, first heading + 1}), options: 2-5 mutually exclusive { id, label, description } with a final "Skip — leave as-is" option, recommendedOptionId (what you would apply on an immediate Save) }`. Add one question per `[NEEDS CLARIFICATION]` marker (quote it verbatim in `context`) and a "top gaps" question from the Design Readiness summary.
2. Import core through the installed PI package, not bare `require` (the script lives outside its node_modules): `piRequire = createRequire(require.resolve('@sunstone-partners/ensemble-pi/package.json', { paths: [process.env.ENSEMBLE_PI_INSTALL_ROOT, path.join(os.homedir(), '.omp', 'plugins'), process.cwd()].filter(Boolean) }))`, then `const { refinementReview } = piRequire('@sunstone-partners/ensemble-core')`.
3. `refinementReview.session.migrateOrCreate({ sessionPath, kind: 'trd', sourcePath, questions, reopen: true })` returns `{ session, token }` synchronously (reopens a completed session, keeping prior answers and comments).
4. `uiDir` = `lib/refinement-review/ui` inside the resolved ensemble-core package. `shouldOpen = !$ARGUMENTS.contains('--no-open') && process.env.CI !== 'true'` (never gate on isTTY). Call `refinementReview.server.startServer({ sessionPath, token, uiDir, port: 0, log, logError, open: shouldOpen && tunnel !== 'quick' })`.
5. `--long-lived`: abort if `--reviewers` is also present, force `tunnel = 'quick'`, parse `--ttl` (reject < 6h), and call startServer with `longLived: true, ttlMs, open: false`.
6. `tunnel === 'quick'`: `const t = new refinementReview.tunnel.QuickTunnel({ targetUrl: server.url }); await t.start(); server.setTunnelUrl(t.url)`, then if `shouldOpen`, `refinementReview.opener.openUrl(server.reviewUrl, {})`.
7. Print URLs once: `Local:`/`Public:` headers when tunneled; `URL: <reviewUrl>`. With `--reviewers N` (strictly an integer in [1, 50], else abort) call `server.createShareUrl()` N-1 times and print `URL #1` ... `URL #N`. Long-lived prints the single invite URL and never calls `createShareUrl()`.
8. Foreground `await server.completed` (resolves `{ artifactPath, session }` when the reviewer hits Complete), inside `try { ... } finally { await server.stop(); if (tunnel) await tunnel.stop(); }`. Do not background the server.
9. Read the artifact; initialize `SELECTED_ITEMS` as every answered question plus every comment with a non-null anchor (each comment becomes a finding against its anchor's section). Print answered count, comment count, artifact path. Synthesis, Interview, and Feedback Integration then use this artifact instead of asking.


### Phase 2: TRD Review

**1. Current TRD Analysis**
   Read the TRD and extract structural metadata

- Read the TRD at the $ARGUMENTS path. Note frontmatter Document ID, Version (to bump later), PRD reference and Design Readiness Score; task, test-task and hour counts; the [depends: TRD-NNN] graph; whether the traceability matrix exists.
- PR format detection: PR_FORMAT=true when '### PR ' followed by a digit appears inside the '## Master Task List' section (up to the next '##' heading), else false (legacy phase/sprint). If true, record MISSING_SHIPPABLE[N] for any `### PR N:` heading not immediately followed by a `**Shippable State:**` line and INFRA_ONLY_SHIPPABLE[N] for any whose text describes only infrastructure with no user-observable capability.
- Snapshot `tasksById` with `node "$TRD_CLI" parse <trd>` (resolve TRD_CLI per the tool-path-resolution skill for packages/development/lib/trd-cli.js) for the Validation step.

**2. Synthesis (skip when --collab or --long-lived in $ARGUMENTS)**
   Skipped with --collab/--long-lived (SELECTED_ITEMS already populated). Otherwise list real findings, numbered, with NO edits yet. Look for: tasks missing `[satisfies REQ-NNN]` or citing nonexistent REQs; user-facing tasks without a paired TRD-NNN-TEST; wrong `Validates PRD ACs:` fields; underspecified details, error handling, non-functional targets, integration contracts, or unjustified architecture decisions; tasks >= 8h; dependency chains of 3+ hops or cycles; missing/stale Architecture Decision, traceability matrix, or Design Readiness scorecard; tasks without hour estimates; stale references to files/APIs that no longer exist. (PR_FORMAT=true) PR sections missing or with infrastructure-only Shippable State, and forward dependencies on a later PR. (PR_FORMAT=false) legacy Phase/Sprint headings: offer conversion to `### PR N:` as a low-priority suggestion.

Present findings through AskUserQuestion: "Based on my review of <TRD filename>, here are the areas I suggest improving: 1. ... N. ... Which would you like to address? Reply with: all, a comma-separated list of numbers, or skip to exit without changes." Store the reply as SELECTED_ITEMS; `skip` exits with no changes. If there are no real findings, say so and go to the closing step.

--foreman: still produce the list, skip the question, select every finding, and log "Foreman mode: auto-applying <N> findings:" with the list.


**3. Interview (skip when --collab or --long-lived in $ARGUMENTS)**
   Skipped with --collab/--long-lived. Otherwise interview ONLY about SELECTED_ITEMS, one AskUserQuestion at a time, asking targeted questions (which REQ a task satisfies, which ACs a test task validates, desired behavior or targets, split boundaries for oversized tasks, parallelism for long chains, what a user gains when a PR merges, whether to move a task across a forward dependency, whether to convert legacy headings to `### PR N:`).

--foreman: skip the interview. For each selected finding apply a best-effort default inferred from the TRD context; where none can be inferred insert an inline `[NEEDS CLARIFICATION: <question>]` marker at the relevant location. Log one line per finding ("Foreman default applied: <finding> -> <default>" or "Foreman: inserted [NEEDS CLARIFICATION: ...] for <finding>").


**4. Feedback Integration (artifact when --collab or --long-lived in $ARGUMENTS)**
   Source answers from the collab artifact, the foreman defaults/markers, or the interview. Apply them to SELECTED_ITEMS only, assign the next sequential TRD-NNN to new tasks, keep the original `[satisfies]` annotations on split children, update the dependency graph checking for new cycles, and compile a change plan.


### Phase 3: Enhancement

**1. List Available TRDs**
   If --list is passed (not with --foreman), pick the TRD interactively

- If $ARGUMENTS contains '--list': resolve TRD_CLI per the tool-path-resolution skill (packages/development/skills/tool-path-resolution/SKILL.md) for packages/development/lib/trd-cli.js. If none of the 4 tiers resolve OR 'which node' fails: print 'ERROR: Node.js and the TRD CLI (lib/trd-cli.js) are required. Ensure Node.js is installed and the ensemble-development or ensemble-pi plugin bundle is present.' and HALT.
- Run node "$TRD_CLI" list --type trd and parse {ok,type,items}; on failure print the error and HALT. Show a table (ID/Name, Status, Score, Last Modified) and ask the user via AskUserQuestion (id 'trd_select') which TRD to refine. Map the slug to docs/TRD/<file>.md (HALT 'ERROR: Could not resolve path for slug <TRD_SLUG>' if missing) and continue with it as the TRD path.

**2. Content Refinement**
   Apply changes ONLY for SELECTED_ITEMS; leave unselected sections alone. Fix what the findings identified: missing `[satisfies]`/TRD-NNN-TEST tasks, AC references, unclear details, error handling, targets, architecture justification, integration contracts, oversized tasks, dependency chains, stale references. (PR_FORMAT=true) insert missing `**Shippable State:**` lines, rewrite infrastructure-only ones with a user-observable capability, move tasks to resolve forward dependencies, and place new tasks inside the correct `### PR N:` section. (PR_FORMAT=false, conversion confirmed) convert Phase/Sprint headings in the Master Task List to `### PR N:` with Shippable State lines; leave `## Sprint Planning` unchanged.


**3. Validation**
   Verify structural integrity before writing

- Run `node "$TRD_CLI" parse <refined trd>` and diff `tasksById` against the Current TRD Analysis snapshot: fail if any task disappeared or a task line lost its checkbox prefix, and fix before writing. Also verify TRD-NNN IDs are unique, `[satisfies]`/`[depends]` annotations resolve, no cycles were introduced, user-facing tasks have paired TRD-NNN-TEST tasks, and counts match the Master Task List summary.
- If PR_FORMAT=true: every `### PR N:` has a Shippable State line, no task depends on a later PR, and the Master Task List contains only `### PR N:` headings.

### Phase 4: Design Readiness Gate Re-Score

**1. Re-Score Readiness Dimensions**
   Re-evaluate after refinement

- Score 1-5: architecture completeness, task coverage (REQ -> implementation + test tasks), dependency clarity, estimate confidence; overall = average.
- Read the previous score from frontmatter and print 'Design Readiness: X.X -> Y.Y (improved/declined/unchanged)'; if it dropped, say which dimensions declined; if none existed, this is the first score.
- If the task count changed by more than 20%, suggest '/ensemble:configure-team <trd-path>'. Update the readiness score in frontmatter.

### Phase 5: Output Management

**1. TRD Update**
   Write the refined TRD with version history and changelog

- Bump the patch version in frontmatter. Preserve the Document ID and Label unchanged -- never regenerate them on refine (beads and PRD/TRD correlation depend on the stable micro UUID id).
- Refresh the Acceptance Criteria Traceability matrix from current task annotations, add a changelog entry at the bottom (date, version, changes), and overwrite the same file path.
- Print summary: changes made, new version, task count delta, hour estimate delta. If the task count changed by more than 20%, include a line recommending /ensemble:configure-team be re-run. This is the only place that recommendation is emitted; expectedOutput declares it, so it has to come from somewhere.

**2. Implementation Go / No-Go**
   Close the refinement with an explicit go/no-go decision on implementing the TRD

- This step ALWAYS runs, and it is the last thing this command does. The run does not end on a printed summary.
- Before asking, confirm the TRD's source PRD is locked: read the PRD at this TRD's `prd_reference` and check its frontmatter `status`. If it is not Locked, say so in the question body -- implementing against an unlocked PRD means the requirements can still move underneath the build.
- If the source PRD's `version` is higher than the version this TRD was refined against, do NOT offer implementation at all. Report that the PRD moved and that the correct action is /ensemble:create-trd to re-create this TRD from the current PRD. A TRD refined against a PRD that has since changed is a refined copy of the wrong document.
- Present the close-out through AskUserQuestion, not prose. Put the design readiness score, its delta, the task count and the hour estimate in the question body, plus any genuine open question the refinement could not settle. A few lines: the person answering has not read the TRD and is not going to.
- Option 1, and the recommendation: GO. Print the next step as '/ensemble:implement-trd-beads <trd path>'. Option 2: another refine pass (offer first when the score fell). Option 3: NO-GO, stop here.
- Do NOT print any implement command before this question is answered, and print it only on the GO branch.
- Prefer implement-trd-beads over implement-trd. They are separate commands, not a flag: implement-trd makes no beads calls and tracks progress in the TRD's own checkboxes, so it cannot resume across sessions. Name plain implement-trd only when the whole TRD lands as one PR in one sitting.
- Ask genuine open questions ONLY. Anything the TRD or the constitution already contains a rule for is a finding, and findings were applied during Synthesis, not asked about here.
- If --foreman is set, skip the question, record GO, and log the decision.

## Expected Output

**Format:** Refined Technical Requirements Document (TRD)

**Structure:**
- **Updated TRD**: Enhanced TRD with feedback incorporated
- **Version History**: Changelog of updates and refinements
- **Acceptance Criteria Traceability**: Updated matrix linking PRD requirements to TRD implementation and test tasks
- **Design Readiness Scorecard**: Re-scored readiness dimensions with delta comparison (if applicable)
- **Changelog Entry**: Dated version entry listing all changes made during refinement
- **Configure-Team Suggestion**: Recommendation to re-run /ensemble:configure-team if task changes exceed 20% delta

## Usage

```
/ensemble:refine-trd
```
