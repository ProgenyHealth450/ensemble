# Local CI Gate - Speed and Fidelity Measurement

<!-- TEMPLATE-UNFILLED: delete this line only when every figure below is filled from a real run. -->

Status: **speed comparison NOT yet measured** (template; no figures captured).

Verdict: <faster|slower|equal|unmeasured - fill in after measuring>

No speed target is asserted. The gate enablement check (`checkEnablementReady` in
`packages/development/lib/local-ci-timing.js`) refuses while this file still carries the
`TEMPLATE-UNFILLED` line or has no `Verdict:` line of `faster`, `slower` or `equal`.

Known, separately measured context (not a result of this template): hosted required CI on
this repository takes about 2.5-3 minutes (`test` 153-192 s, `validate` 44-62 s). The local
gate is therefore unlikely to be faster in run time; if it is slower, the benefit comes from
removing the bot-review wait, not from run time, and the note must say so.

## Capture procedure

Run from the repository root, on the same head commit for local and hosted.

```sh
# 1. Local, cold: no dependency cache, Node not yet downloaded
#    (remove the cache/Node download first), then time each version
time npm run ci:local -- --node 22
time npm run ci:local -- --node 24

# 2. Local, warm: immediately re-run the same commands with caches present
time npm run ci:local -- --node 22
time npm run ci:local -- --node 24

# 3. Hosted durations for the same workflows over the same period
gh api repos/{owner}/{repo}/commits/<headSha>/check-runs \
  --jq '.check_runs[] | {name, started_at, completed_at, conclusion}'
```

Fill the results into `recordTimings({ versions, toleranceMs, local, hosted })` and paste
`renderNote(...)` output over this file, then remove the `TEMPLATE-UNFILLED` line.

## Results (UNFILLED)

| Node | Local cold | Local warm | Hosted | Verdict |
| --- | --- | --- | --- | --- |
| 22 | NOT MEASURED | NOT MEASURED | NOT MEASURED | unmeasured |
| 24 | NOT MEASURED | NOT MEASURED | NOT MEASURED | unmeasured |

## Fidelity gaps (UNFILLED)

Not assessed. List every job that passes in one of local/hosted and fails or cannot run in
the other, for the same head commit.
