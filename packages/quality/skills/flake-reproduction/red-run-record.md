# Red-run record

Write one record per red required run. Put it in the hand-off report and in the bead (a comment or the description). Nothing here needs a service: the skill prints this shape and you fill it in. Never put a token, a password or a full environment dump in a record; cite counts, ids and repository-relative paths only.

## Classes

- `failing-test`: at least one test failed.
- `guard-only`: the run exited non-zero after every test passed (a suite-end leak guard, a coverage gate, a warnings gate). Name the guard that raised and quote its first line.
- `infrastructure`: the run failed before the test command started (checkout, dependency fetch, service start). Re-running is a recorded operator action, never automatic. Whether an operator may re-run a required job after such a failure is still an open question in PRD-2026-bd69b524 (OQ-4).

## Replay handle

The handle is what the runner printed so the run can be repeated: a random seed, an order file or a shard or partition id. Record its kind, its value and where in the log it appeared. If the runner printed none, write `none printed` and treat the class as unreplayable until a handle is captured.

## Markdown template

```markdown
## Red run: <short title>

- Run: <run id or URL>   Job: <job name>   Commit: <full sha>
- Class: failing-test | guard-only | infrastructure
- Guard (guard-only only): <name and first line>
- Failing tests: <test id 1>; <test id 2>
- First assertion or error: <one line>
- Replay handle: <kind> = <value> (log line: <line or none printed>)
- Partition or shard: <id or n/a>
- Replay command: `<exact command, run from the failing commit's tree>`
- Log: <path or URL of the full output>
- Replay result: reproduced | not reproduced | not attempted (<why>)
- Capture: <runs>, <failures>, <load: unloaded or burners=N, load average>, <log paths>
- Cause: <one sentence> [proven | unproven]
- Evidence for the cause: <deterministic reproduction command and result, or "none: inferred only">
- Tests audited (run or read in full): <list>   Only skimmed: <list>
- Fix: <PR URL or "none yet">   Decision at time box: continue | park | escalate | n/a
```

## JSON template

```json
{
  "run": "",
  "job": "",
  "commit": "",
  "class": "failing-test",
  "guard": null,
  "failing_tests": [],
  "first_error": "",
  "handle": { "kind": "seed", "value": "", "log_line": null },
  "partition": null,
  "replay_command": "",
  "log": "",
  "replay_result": "not attempted",
  "capture": { "runs": 0, "failures": 0, "load": "", "logs": [] },
  "cause": { "text": "", "status": "unproven", "evidence": null },
  "audited": [],
  "skimmed": [],
  "fix_pr": null,
  "decision": null
}
```

Allowed values: `class` is `failing-test`, `guard-only` or `infrastructure`; `replay_result` is `reproduced`, `not reproduced` or `not attempted`; `cause.status` is `proven` or `unproven`; `decision` is `continue`, `park`, `escalate` or `null`.

## Rules for filling it in

- A cause is `proven` only when you made the failure happen on demand and the fix removed it. An inferred mechanism is `unproven` and is written as such.
- A captured failure outranks a theory: if they disagree, rewrite the theory.
- Replay the handle on the single failing file and record the result before bisecting.
- A bead is not closed as fixed with `unproven` and no stated reason; close it with the label visible or leave it open.
