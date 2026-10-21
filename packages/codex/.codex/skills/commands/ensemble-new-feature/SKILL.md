---
name: ensemble-new-feature
description: Resumable, checkpointed workflow from an idea through PRD, TRD, bead planning, and approved implementation, with an optional PR. (Codex skill for /ensemble:new-feature)
user-invocable: true
model: gpt-5.1-codex
---

# Ensemble Command: /ensemble:new-feature

This Codex skill mirrors the Ensemble slash command `/ensemble:new-feature`.
Follow the workflow below, adapt to the current repository, and keep outputs structured.

<!-- DO NOT EDIT - Generated from new-feature.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Chain create-prd, refine-prd, create-trd, refine-trd and bead planning
(implement-trd-beads --plan) into one resumable run. Each stage's skill
executes in-session, never as a subprocess; RunIndexStore records the stage,
its outcome, and the artifacts each stage produced. implementation_approval
and pr_approval are human checkpoints: nothing past them runs without a
recorded approval timestamp.

## Arguments

- **`idea`** (string, optional): Free-text description of the feature to build. Starts a new run at stage prd_create. Mutually exclusive with `path`; omit both to resume the project's active run or show its status.
- **`path`** (string, optional): An indexed PRD or TRD artifact path to resume from (resolved via RunIndexStore.resolveByArtifact; never globbed). An unindexed but readable PRD (frontmatter `document_id` matching `PRD-*`) is adopted as a new run's source via RunIndexStore.createRunFromArtifact, entering at prd_refine; any other unindexed path is rejected.
- **`status`** (boolean, optional, default: `false`): Show the active/most-recent run's stage, outcome, and references without advancing it.
- **`abandon`** (string, optional): Terminate the project's active/paused run after explicit confirmation; any given text is an optional reason recorded in the terminal history. If `idea` or `path` is also given, that takes precedence; omit `idea`/`path`/`status` for `abandon` to take effect.
- **`foreman`** (boolean, optional, default: `false`): Foreman-native non-interactive mode. Forwards `--foreman` to every stage skill and replaces this command's own prompts (retry, implementation approval, PR approval, abandon) with recorded decisions. Hard stops are unchanged. Without this flag nothing changes.

## Workflow

### Phase 1: Entry Point Resolution

**1. Reject Unsupported Flags Before Any Stage Runs**
   --skip-refine and equivalents are rejected before any RunIndexStore call.

- Invocation arguments: $ARGUMENTS -- read `idea`, `path`, `status` and flags such as `--foreman` from it.
- If the invocation includes `--skip-refine` or any equivalent flag that would bypass prd_refine or trd_refine: reject with 'Both PRD and TRD refinement are mandatory in new-feature's fixed stage order; to skip orchestration but not refinement, run the standalone /ensemble:refine-prd or /ensemble:refine-trd commands (unmodified by new-feature).' and HALT. No run is created or mutated.
- This workflow is the internal implementation behind the canonical front door `/ensemble:feature` (keywords `new`/`resume`/`status`/`abandon`); direct invocation behaves identically.
- Foreman mode: FOREMAN = true when `--foreman` is present, else false. `--foreman` is a supported flag, never a `--skip-refine` equivalent (it bypasses no refinement stage). Nothing infers FOREMAN from the environment.

**2. Idea Input -- Start a New Run**
   An `idea` starts a fresh run at prd_create.

- If `idea` is provided (and `path` is not): call RunIndexStore.createRun(projectRoot, idea).
- If it throws RUN_ALREADY_ACTIVE, print 'A run is already active for this project: <existingRunId>. Resume it with no arguments (or --status), or abandon it before starting a new one.' and stop -- no new run is created.
- Otherwise print the new run's identifier (runId) and that it starts at stage prd_create; set ACTIVE_RUN and proceed to Stage Resolution.

**3. Artifact-Path Input -- Resume an Indexed Run, or Adopt an Unindexed PRD**
   Resume the run that indexed `path`, or adopt an unindexed PRD at prd_refine.

- If `path` is provided: call RunIndexStore.resolveByArtifact(projectRoot, path).
- Found: print the matched artifact reference (type, documentId, version, producingStage) and the run's recorded stage; set ACTIVE_RUN; proceed to Stage Resolution.
- Not found, and `path` does not exist or cannot be read: reject with 'No indexed run references <path>, and no file exists at that path to adopt as a new run's source.' Create no run; advance nothing.
- Not found, `path` is readable but its frontmatter has no `document_id` matching `PRD-*` (a TRD, an unrelated file, or malformed frontmatter): reject with 'No indexed run references <path>. Only artifact paths recorded by a prior new-feature run can be resumed, and <path> is not a PRD document -- use the standalone /ensemble:refine-prd or /ensemble:refine-trd command instead.' Create no run; advance nothing.
- Not found, `path` is readable and has a `document_id` matching `PRD-*`: adopt it. Read `document_id` and `version` from its frontmatter and call RunIndexStore.createRunFromArtifact(projectRoot, <the PRD's H1 title, falling back to its document_id>, { type: 'prd', path, documentId, version, producingStage: 'prd_create' }, 'prd_refine'). It enters at prd_refine, not prd_create (the PRD already exists). Print the new run's identifier and that it starts at prd_refine; set ACTIVE_RUN; proceed to Stage Resolution.
- RunIndexStore.createRunFromArtifact() enforces the same single-active-run exclusivity as createRun(): on RUN_ALREADY_ACTIVE print the same message and stop.

**4. No Arguments -- Resume Active or Show Status**
   Resume the active/paused run, or (--status) report it read-only. A failure-parked run is never auto-re-executed.

- If `status` is true: this is a read-only report -- never a resume. No stage executes and no mutate() call is made regardless of what is found. Call RunIndexStore.findActive(projectRoot) for STATUS_RUN; if none, read the run files under .ensemble/new-feature/ (excluding active.lock) and take the one with the latest updatedAt (undefined if none).
- status=true, STATUS_RUN undefined: print 'No runs found for this project. Start one with --idea "<description>".' Stop here.
- status=true, STATUS_RUN found: print the run identifier, current stage, last stageOutcome.kind (with detail for a pending decision or failure), and every recorded artifacts[] and beadRefs[] reference; state a "completed"/"abandoned" status explicitly. Claim a PR exists only if STATUS_RUN.prApprovedAt is non-null AND a beadRefs[] entry has the "pr:" prefix; otherwise state plainly that no PR exists. Stop here -- status is always read-only and never proceeds to Stage Resolution.
- If `status` is false, `abandon` is not provided, and neither `idea` nor `path` is provided: call RunIndexStore.findActive(projectRoot).
- status=false, not found: print that no active run exists and how to start one (`--idea "<description>"`). Stop.
- status=false, found, and ACTIVE_RUN.stageOutcome.kind is "failure": the run is paused by failure. Print the parked stage and failure detail and ask the user (AskUserQuestion) 'Retry <stage>? [yes/no]' -- do NOT proceed to Stage Resolution on a bare invocation alone. Only an explicit 'yes' proceeds; otherwise stop with the run unchanged -- no mutate() call is made merely by viewing this prompt.
- Foreman mode: when FOREMAN == true and the outcome is "failure", do not ask (no question, no prompt). The invocation is the explicit retry: proceed to Stage Resolution, which retries the parked stage once; a second failure is recorded and the run ends.
- status=false, found, any other stageOutcome.kind ("approval_wait", "decline", or a fresh run): set ACTIVE_RUN and proceed to Stage Resolution; re-running these on resume is normal.

**5. Event-Triggered Entry (Opt-In)**
   Applies only to invocations from a configured event delivery (.ensemble/new-feature/event-mapping.json); absent that file it never fires.

- Call EventMappingConfig.loadEventMapping(projectRoot) (packages/agent-core/src/new-feature/event-mapping.ts). If it returns null: default-deny -- no run starts and nothing under RunIndexStore is touched. Stop; this is the normal state for a project that has not opted in.
- Otherwise call validateEventPayload(mapping, event) BEFORE any RunIndexStore call. Rejected (`ok: false`): create no PRD, advance no run, report the exact `reason` as the pending step, and stop.
- Accepted: present the event source and full payload to the user via AskUserQuestion for explicit review BEFORE any PRD-stage work (the payload's `summary` only seeds the normal PRD elicitation). On decline create no PRD, advance no run, and stop. On approval proceed as Step 2 with `event.summary` as the `idea`.
- Foreman mode: when FOREMAN == true an accepted payload is NOT auto-approved (untrusted input, no reviewer): create no PRD and no run, and report the pending step as 'human review of the event payload is required; --foreman cannot approve an untrusted event payload'. Stop.

**6. Abandon Confirmation Gate**
   Checked before Step 4; when `abandon` is provided, Step 4's resume/status branches never apply.

- If `abandon` is provided (empty string counts; only an omitted parameter skips this step): call RunIndexStore.findActive(projectRoot).
- Not found: print 'No active run exists for this project; nothing to abandon.' and stop -- no mutate()/abandon() call is made, no state is touched.
- Found: ask the user for explicit confirmation (AskUserQuestion), naming the run's identifier and current stage, before calling RunIndexStore.abandon(). Declined or no response: make no mutate()/abandon() call; the run is left untouched.
- Foreman mode: when FOREMAN == true do not ask for confirmation (no question, no prompt) -- `--abandon` with `--foreman` is the explicit instruction: call RunIndexStore.abandon(projectRoot, runId, reason) directly and print the run's identifier and the stage it was abandoned at.
- On explicit confirmation: call RunIndexStore.abandon(projectRoot, runId, reason), where `reason` is the `abandon` parameter's text (empty string if none). This sets status to "abandoned" and releases active.lock; artifacts and history are retained for a later `--status`.

### Phase 2: Stage Resolution

**1. Load Current Checkpoint**
   Read the run's stage and stageOutcome from RunIndexStore.

- Read ACTIVE_RUN.stage and ACTIVE_RUN.stageOutcome.kind.
- If ACTIVE_RUN.stageOutcome.kind === "success": ELIGIBLE_STAGE is the next entry in STAGE_ORDER (types.ts) after ACTIVE_RUN.stage; "done" has no successor, so a run at "done" has nothing left to run.
- Else ("approval_wait", "decline", or "failure"): ELIGIBLE_STAGE is ACTIVE_RUN.stage itself -- the current stage has not completed, so it (and only it) is what runs next, regardless of what files already exist on disk with plausible names for a later stage.
- Never consult the filesystem (glob, ls) to decide ELIGIBLE_STAGE; the only input is RunIndexStore.
- Plan-change staleness check: if ELIGIBLE_STAGE is "implementation" and ACTIVE_RUN.implementationApprovedAt is non-null, compare it with the recordedAt of every artifacts[] entry whose producingStage is "trd_refine" or "beads_plan". If any is later, the approved plan has changed since approval: call RunIndexStore.mutate() setting implementationApprovedAt = null and stage = "implementation_approval" in one call, then re-run this step, so ELIGIBLE_STAGE becomes "implementation_approval", never "implementation" on a stale approval. Otherwise approval is still current.
- Foreman mode: when FOREMAN == true and the staleness check returns to "implementation_approval", Execute Stage step 5 re-grants approval through its recorded --foreman path, so the run record shows the new grant.

**2. Dispatch to the Eligible Stage**
   Route execution to exactly the one stage ELIGIBLE_STAGE names.

- Dispatch on ELIGIBLE_STAGE (exact match, no fallthrough): prd_create -> Execute Stage: PRD Creation; prd_refine -> Execute Stage: PRD Refinement; trd_create -> Execute Stage: TRD Creation; trd_refine -> Execute Stage: TRD Refinement; beads_plan -> Execute Stage: Bead Planning; implementation_approval -> Implementation Approval Checkpoint; implementation -> not driven by this command (see next action); pr_approval -> PR Approval Checkpoint; pr_create -> Execute Stage: PR Creation; done -> print terminal status; nothing to run.
- The "implementation" stage is not wired: once approval is granted `stage` advances to "implementation", and reaching it here prints 'ERROR: stage implementation is not yet implemented in this build -- run /ensemble-implement-trd-beads --execute against the approved bead plan, then resume this run' and halts with no mutate() call. Nothing here advances `stage` past "implementation"; pr_approval/pr_create work against whatever RunIndexStore state they find. Anything that drives "implementation" must read the stored implementationApprovedAt immediately before acting and deny on null.

### Phase 3: Execute Stage

**1. Load and Execute the Stage's Existing Skill Body**
   Each document-producing stage wraps an unmodified standalone skill.

- Dispatch ELIGIBLE_STAGE to its skill in-session, as it runs standalone: prd_create -> ensemble-create-prd, input = the run's `idea`; prd_refine -> ensemble-refine-prd, input = the PRD artifacts[] entry `prd_create` (or the latest `prd_refine`) recorded; trd_create -> ensemble-create-trd, input = the PRD artifacts[] entry `prd_refine` recorded; trd_refine -> ensemble-refine-trd, input = the TRD artifacts[] entry `trd_create` recorded; beads_plan -> ensemble-implement-trd-beads --plan, input = the TRD artifacts[] entry `trd_refine` recorded.
- Always pass the exact `path` from the named artifacts[] entry, never a globbed or recalled path. `--plan` is load-bearing: it stops after the beads-build Scaffold phase, since implementation is not yet approved.
- Foreman mode: when FOREMAN == true, append `--foreman` to the dispatched skill: ensemble-create-prd --foreman, ensemble-refine-prd --foreman, ensemble-create-trd --foreman, ensemble-refine-trd --foreman, ensemble-implement-trd-beads --plan --foreman. This command does not set or reinterpret FOREMAN_* environment variables (FOREMAN_TASK_TITLE, FOREMAN_ARTIFACT_PATH, ...); each stage skill keeps its own contract. When FOREMAN is not true, no `--foreman` is added.

**2. Record the Stage Outcome**
   Checkpoint success, decline, or failure through RunIndexStore as soon as the stage returns.

- Skill completed with a real, saved output artifact (PRD/TRD file, or a scaffolded bead epic for beads_plan): call RunIndexStore.mutate() once to append { type, path, documentId, version, producingStage, recordedAt } to artifacts[] (never overwrite a prior entry on revision), set stageOutcome to { kind: "success", recordedAt: now() }, and advance stage to the next STAGE_ORDER entry.
- User declines the output: mutate() stageOutcome to { kind: "decline", detail: <reason>, recordedAt: now() }; stage does not advance; artifacts[] unchanged. Ask the user for the correction needed; do not silently retry with no new input.
- User asks for an edit/regenerate: append the new version's artifacts[] entry, but do NOT advance `stage` or set stageOutcome.kind to "success" until the user explicitly accepts it; no dependent stage runs meanwhile.
- Foreman mode: when FOREMAN == true nothing is asked: a stage that completed with a real saved artifact is recorded as success without asking for acceptance, and the decline and edit paths never apply. A stage-skill hard HALT (readiness gate FAIL, constitution violation) is still a failure recorded by step 3.

**3. Handle Stage Failure**
   A failure pauses the run at the failed stage; no auto-retry within the invocation.

- If the stage throws or reports a failure: call RunIndexStore.mutate() setting stageOutcome to { kind: "failure", detail: <error message>, recordedAt: now() } at the CURRENT stage (do not advance `stage`); leave artifacts[] as it was before this invocation. Print the error and the stage name.
- Do not advance, do not retry, do not re-dispatch any stage within this invocation -- the run ends here. A later bare invocation leaves stage/stageOutcome/revision unchanged; Entry Point Resolution step 4 defines what an explicit retry looks like.

**4. Explicit-Retry-Only Resume of a Failed Stage**
   A failed stage is re-run only after Entry Point Resolution step 4's explicit 'yes'.

- Re-execute step 1 for the parked stage (Stage Resolution pins ELIGIBLE_STAGE to it) with the same or user-edited input. On success only that stage's artifact/outcome changes; earlier stages' artifacts[] entries are never re-executed or re-derived by a retry. Stages after the parked one remain blocked until the retry succeeds.

**5. Implementation Approval Checkpoint**
   Human checkpoint; nothing past it runs without a recorded approval timestamp.

- Present the accepted PRD/TRD references (artifacts[] from prd_refine/trd_refine) and the bead plan (beadRefs[]) via AskUserQuestion, exactly as recorded in the run, and wait for explicit approval.
- On explicit approval: call RunIndexStore.mutate() setting implementationApprovedAt = now() and advancing stage to "implementation" in the same call.
- On absent or declined approval: make no mutate() call -- the run stays parked at implementation_approval with implementationApprovedAt null.
- Foreman mode: when FOREMAN == true, ask nothing (no question, no prompt) -- the Foreman dispatch is the approval. Grant it in a single mutate() call setting implementationApprovedAt = now(), advancing stage to "implementation", and setting stageOutcome to { kind: "approval_wait", detail: "implementation approval granted by --foreman policy (no human present)", recordedAt: now() }. `--status` prints that detail, so an auto-grant is never mistaken for a human approval.

**6. PR Approval Checkpoint**
   Optional; requires an approval distinct from implementation_approval's.

- Enter only if the user opts in after implementation completes. Declining makes no PrProvider call at all.
- On opt-in: construct a GhCliPrProvider and call isAvailable(). If false: create no PR, mutate() to record stageOutcome detail "no PR provider available", and advance stage to "done".
- If isAvailable() === true: present the target repo/branch/title/body (repo/branch from the run's recorded references, title/body proposed from the accepted PRD/TRD) via AskUserQuestion and require a separate, immediate explicit approval before createPullRequest().
- On absent/declined approval: create no PR and advance stage to "done".
- On explicit approval: call RunIndexStore.mutate() setting prApprovedAt = now() and advancing stage to "pr_create" immediately before the create call -- never in the same mutate() call as implementationApprovedAt.
- Foreman mode: when FOREMAN == true, do not ask for the opt-in or present repo/branch/title/body (no question, no prompt) -- treat the opt-in as yes. Call RunIndexStore.mutate() setting prApprovedAt = now(), advancing stage to "pr_create", and setting stageOutcome detail to "PR approval granted by --foreman policy (no human present)" -- never in the same mutate() call as implementationApprovedAt.
- Foreman mode: when FOREMAN == true and isAvailable() is false, the rule above applies unchanged: create no PR, record stageOutcome detail "no PR provider available", and advance stage to "done".

**7. Execute Stage: PR Creation**
   Only reached when prApprovedAt is already set by the PR Approval Checkpoint.

- Before createPullRequest(), read RunIndexStore.loadRun()'s current prApprovedAt directly; a null prApprovedAt denies the call, whatever conversational text claims.
- Call GhCliPrProvider.createPullRequest() with the exact repo/branch/title/body approved at the checkpoint.
- On success: mutate() to append `pr:<url>` (the returned { url }, prefixed) as a beadRefs[] entry -- beadRefs[] also holds plain bead IDs, so the "pr:" prefix is how a PR reference is told apart -- and advance stage to "done" with stageOutcome { kind: "success", recordedAt: now() }.
- On failure (createPullRequest() throws): mutate() stageOutcome to { kind: "failure", detail: <error message>, recordedAt: now() } at pr_create -- do not advance stage or fabricate a PR URL; steps 3/4 apply.

## Usage

```
/ensemble:new-feature
```
