# PR Review Cycle -- Steps 8, 8b and 9 (status, explainer offer, state report)

Companion to `SKILL.md`; every rule here is normative.

### Step 8 -- Derive status (CLI `status`)

Run `node "$PR_REVIEW_CLI" status` with the accumulated facts: `{ baseSha,
headSha, reviewedHeadSha, reviewedTreeSha, headTreeSha,
findingCounts:{total, actionable, deferred}, tests:{exitCode, skipped, command},
remotePhase, roundsUsed, roundCap, access, prUrl, reportPath }`. `baseSha`, `headSha` and
`reviewedHeadSha` (full 40- or 64-hex
object ids, never a bare ref) and `findingCounts` (`total`, `actionable` and
`deferred`: non-negative integers with `total >= actionable + deferred`) are
required, `roundsUsed`, when given, is a non-negative integer, `roundCap`,
when given, is the policy's integer 1-5 (absent means the strict default of
3, and a value outside the range is refused with the default applied), and
`tests`,
when given, carries the test command's integer `exitCode` (required unless
`skipped: true`; `passed` is derived, never supplied, and a contradicting `passed`
is refused; leave `tests` out and the tests count as never run). A nonzero exit
is `failed test` unless `preExistingOnly: true` and `knownFailures:[{name,
evidence}]` is non-empty: then tests are settled, reason `tests: pre-existing
failures` stays visible: the grader fails closed, so a missing or invalid
fact is never defaulted to a passing value -- it yields `LOCAL_REVIEW_BLOCKED`
naming the missing facts. The result is exactly one of
`REVIEW_COMPLETE` / `REVIEW_PENDING` / `REVIEW_BLOCKED` plus `localPhase`,
`remotePhase` and `reasons`. `REVIEW_COMPLETE` requires `LOCAL_REVIEW_COMPLETE`
**and** `REMOTE_REVIEW_COMPLETE` -- never return it from prose judgment.

**Fresh review.** The review is fresh for `headSha` when `reviewedHeadSha`
equals it, or when `reviewedTreeSha` and `headTreeSha` -- the tree ids of those two commits -- are both given and are the identical full
object id: the local review is bound to a snapshot commit and PR creation then
makes the one real commit, which when it holds exactly the reviewed content is
what was reviewed. Both tree facts are optional -- leave the key out (never an
empty string or a ref) when not computed, and the heads must then be equal. One
that is given must be a full object id or the status is `LOCAL_REVIEW_BLOCKED`
naming it; a tree on one side only never makes a different head fresh, and a
different tree is stale: re-run the local review for the current head.

**Which reviewed head and tree to grade against.** In `MODE=local`, `headSha`
and `reviewedHeadSha` are the same post-fix head (Step 6) and
`reviewedTreeSha` is its tree; leave `headTreeSha` out. In `MODE=remote`,
`headSha` is `HEAD_SHA` and `headTreeSha` is `HEAD_TREE_SHA` -- the commit
being evaluated and its tree -- but `reviewedHeadSha` and `reviewedTreeSha`
are **not** those: they are what the local run recorded, read back from the
report `state-read` returns (Step 9), that report's own `reviewedHeadSha` and
`reviewedTreeSha`; the other local-phase facts it recorded (`baseSha`,
`findingCounts`, `tests`, `rounds.used`) come from the same report. Never copy
`headSha` or `headTreeSha` into them -- that would make every head look
reviewed -- and never use a value from before the batch fix. When `state-read`
finds no report, or discards it, leave both out (the grader blocks, naming the
missing fact) and tell the operator the local phase must be re-run.

A caller-supplied completion override is passed through to the CLI, never
applied here.

Publication is gated on `localPhase` alone: push or create the PR only when it
is exactly `LOCAL_REVIEW_COMPLETE`; `LOCAL_REVIEW_PENDING`,
`LOCAL_REVIEW_BLOCKED`, or a missing or unreadable status (no `localPhase`, a
non-zero CLI exit) halts: report, never publish.

### Step 8b -- High-tier explainer offer (CLI `explainer-offer`)

The report that Step 8 produces carries one more thing, and only on a **High**
effective tier: an offer of an explainer for each touched sensitive module
(AC-022-3). Run `node "$PR_REVIEW_CLI" explainer-offer` with `{ tier, paths,
requested }` -- `tier` is the effective-tier result (or its word; the
**effective** tier decides, so a Low treated as Medium is not High), `paths`
is the Step 1b `paths` classification verbatim, and `requested` is the list of
modules a person has actually asked for (`[]` on the first report).

Put one line per entry in `modules` in the report, naming the module and the
paths that made it sensitive, and say plainly that an explainer is produced
only on request. Then generate **only** what `generate` names, by invoking the
`pr-review-explainer` skill once per module with `REQUESTED = true` and
`MODULE` set to that module; never write an explainer for a module that is not
in `generate`, and never for `unknownRequested` -- report those back as not
offered. An `ok:false` result (`not-high-tier` is `ok:true` with no offer)
means the offer could not be decided: say so in the report, offer nothing and
generate nothing. A report that is not High tier carries no offer at all; a
maintainer may still ask for an explainer directly, which is the explainer
skill's own entry, not this step's.

### Step 9 -- Write state (CLI `state-write`)

Run `node "$PR_REVIEW_CLI" state-write` with `{ prId, state }` -- `prId` is
`PR_ID` and `state` the full status result, a JSON object: it carries
`reviewedHeadSha`, `reviewedTreeSha` and `headTreeSha`, so the report records
which head and tree were reviewed -- never hand-build a state without them. A
`state-write` that answers `ok:false` wrote nothing (the previous report is
untouched): report its `reason`, and never treat the state as recorded. The report lives at `.ensemble/pr-review/pr-<PR_ID>.json`, is listed in
`.gitignore`, and is deliberately never committed: committing it would change
the head SHA and invalidate the very review it records. On resume, run
`state-read` with `{ prId, headSha, treeSha }` for the head being resumed
(`headSha` is required; `treeSha` is that head's tree id -- leave
the key out when not computed) to recover dispositioned findings and the
recorded local-phase facts instead of re-triaging them. A report is kept when
its own head is `headSha`, or when `treeSha` is the `reviewedTreeSha` it
recorded (the real commit PR creation made from the reviewed snapshot);
otherwise, or when it carries no head, it is discarded, not reused.

**What the report records about verification (AC-006-4).** Alongside the
status facts, `state` carries `verification` -- the `votes` result's
`verification` word (`performed`, `partial`, `not-performed` or `blocked`),
its `reason` and its `recoveryAction` -- and, whenever that word is not
`performed`, the same **reduced-review notice** Step 3b puts in the report,
verbatim, under `reducedReview`. A reader of the report, and the next
`state-read` that resumes it, therefore sees that the review was reduced
without having to re-derive it; a report that records a clean status and
says nothing about a review that was never verified is the one shape this
rule exists to prevent.
