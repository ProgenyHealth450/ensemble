# Local CI Gate — Baseline Note (REQ-013)

Capture date: 2026-10-21 (template created; figures NOT yet measured)
Status: **target unproven until measured**
Gate enablement record: none — the gate is not enabled. This note MUST be
filled in and dated before any enablement is recorded.

The numeric target and the minimum post-change cohort size/duration are
DECIDED FROM this baseline after it is measured. They are not set here, and no
figure below may be filled in from memory or estimation. Once decided, record
them in the PRD changelog (`docs/PRD/PRD-2026-4dec59b8-local-ci-pr-approval.md`).

## Capture procedure

Choose a cohort window (for example the last 30 merged PRs, or a fixed date
range) and record it below. Run from the repository root:

```sh
# 1. Merged PRs in the window: open and merge times
gh pr list --state merged --limit 30 \
  --json number,createdAt,mergedAt,headRefOid

# 2. Hosted CI wait per PR: check runs on the head commit
gh api repos/{owner}/{repo}/commits/<headRefOid>/check-runs \
  --jq '.check_runs[] | {name, started_at, completed_at, conclusion}'
#   ciWaitMs = latest completed_at - earliest started_at of the hosted CI runs

# 3. Bot-review wait per PR: reviews by the bot (e.g. coderabbitai[bot])
gh pr view <number> --json reviews \
  --jq '.reviews[] | {author: .author.login, state, submittedAt}'
#   botReviewWaitMs = first bot review submittedAt - PR createdAt
#   (or head-push time, if the bot reviewed the final head)
```

Feed `{ number, openedAt: createdAt, mergedAt, ciWaitMs, botReviewWaitMs }`
per PR to `summarizeCohort` in `packages/development/lib/local-ci-baseline.js`.
Percentiles are linear-interpolation (median = p50, p75 = p75). CI wait and
bot-review wait are reported separately and are never summed or conflated.

## Results (unfilled — NOT measured)

Cohort window: _unfilled_
Cohort size: _unfilled_

| Metric                      | Median     | p75        |
| --------------------------- | ---------- | ---------- |
| Open-to-merge time          | _unfilled_ | _unfilled_ |
| Hosted CI wait              | _unfilled_ | _unfilled_ |
| Bot-review (CodeRabbit) wait | _unfilled_ | _unfilled_ |

## Decisions (made only after measurement)

- Numeric target (reduction in median and p75 open-to-merge): _undecided_
- Minimum post-change cohort size: _undecided_
- Minimum post-change duration: _undecided_

Until these are decided and a post-change cohort of at least the minimum size
exists, status is reported as `unproven`, never `met`.
