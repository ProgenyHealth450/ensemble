# Behavioral evals

Headless harness that checks what models *do* with Ensemble instructions. Graders are deterministic (no LLM judge).

## Run

```bash
npm run evals -- --dry-run                      # list scenarios
node evals/run.js --scenario fix-issue --model sonnet --max-usd 1
node evals/run.js --max-usd 5                   # all scenarios
```

Agent scenarios shell out to `claude -p` (stream-json, `--plugin-dir packages/<pkg>`, `--max-turns`, `--allowedTools`, `--permission-mode`) inside a throwaway git repo built from the scenario fixture. `cli` scenarios run no model.

Without the `claude` CLI (override path with `EVALS_CLAUDE_BIN`): `--dry-run` prints a skip message and exits 0; a real run exits 3.

## Cost cap

`--max-usd N` is the total budget. Each scenario gets the remainder as `--max-budget-usd`; once spent, later agent scenarios are skipped as `budget exhausted`. Always set it.

## Results

`evals/results/<model>-<timestamp>.json` (gitignored): per-grader pass/fail, turns, cost. Exit code is 1 if any scenario fails.

## Add a scenario

1. `evals/scenarios/<id>/scenario.json`: `type` (`agent`|`cli`), `prompt`, `plugins`, `allowedTools`, `permissionMode`, `maxTurns`, `timeoutSec`, optional `remote: true` (bare `origin`), and `graders`. `{{repo}}` expands to the repo root.
2. `evals/scenarios/<id>/fixture/`: files copied into the sandbox and committed on `main`.
3. Graders live in `evals/lib/graders.js` (`trdParses`, `fileExists`, `fileMatches`, `testsPass`, `commandOutputMatches`, `noProtectedBranchCommit`, `remoteBranchUnchanged`, `noForbiddenCommand`). Add new ones as pure functions with a test.

Tests: `npx jest evals` (uses a stub `claude`; no model calls).
