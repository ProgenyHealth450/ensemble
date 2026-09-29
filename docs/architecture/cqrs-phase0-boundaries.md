# Phase 0: one execution path, and what the host can actually enforce

- **Status:** Delivered
- **Date:** 2026-09-29
- **Beads:** `br-behavior-runtime-cqrs-xl24.2` (Story 0.1), `br-behavior-runtime-cqrs-xl24.3` (Spike 0.2), `br-33co`
- **Spec:** [`ensemble-behavior-cqrs-implementation-requirements.md`](./ensemble-behavior-cqrs-implementation-requirements.md) §5 Phase 0
- **Input:** [`cqrs-gap-report.md`](./cqrs-gap-report.md)

## 1. The route that was chosen, and the one that was removed

There were two dispatch paths for one event. Both ran.

```text
test.failure.observed
  ├── enqueueContinuation -> turn_end -> pi.sendUserMessage -> the USER'S agent edits files
  └── matcher.onEvent -> BehaviorRunner -> AutofixLoop -> MutationGuard
```

The governed branch refused to write under `policy.mode: propose`. The continuation branch
repaired the same file in the same run, because no write in it passed through `MutationGuard`
at all. Since the continuation always "worked", the governed branch being dead for three days
was invisible (br-dowt, br-cxn8, br-boam).

**The governed route is the one that survives.** The continuation is deleted, not flagged off:
§7 says explicitly that keeping both behind a flag is not acceptable, and a flag defaulting to
the ungoverned path is the configuration that produced the incident.

Removed outright:

| Module | Why |
| --- | --- |
| `extension.ts` continuation queue | The second dispatch path (REQ-CQRS-002). |
| `behavior-runner.ts` | Test-failure-specific orchestration; replaced by `workflow-dispatch.ts`, which names no behavior. |
| `autofix-loop.ts` | Its roles are now `fix.propose` / `fix.verify` / `fix.apply`, three separate facts. |
| `agent-fix-provider.ts` | Replaced by `agent-port.ts`, which is contained (§3) and returns a candidate rather than a patch-shaped special case. |
| `constitution-proposal.ts` | Replaced by `constitution.propose` / `constitution.apply`. |
| `working-tree-snapshot.ts` | Whole-tree `git checkout -- .` rollback, forbidden as routine by REQ-SAFE-005. It discarded concurrent user edits and reported `restored: true` for files it had never captured. |
| `issue-identity.ts` | Only consumed by the modules above. |

Retained and repurposed: `continuation-budget.ts` → `invocation-budget.ts`. The bounding it
provides is still required (REQ-SAFE-007); only the thing being bounded changed.

Retained as defence in depth, explicitly not as isolation: `write-boundary-monitor.ts` and
`tree-baseline.ts` (§3.3).

### Regression tests

- `pi-extension/tests/one-dispatch-path.test.ts` asserts at source level that no runtime module
  calls `sendUserMessage` for behavior work, that no continuation queue exists, that no
  whole-tree restore survives, and that **no behavior name appears in runtime code**. Source
  level on purpose: a behavioural test proves only that the second path did not fire in the
  scenario it set up, and the original defect was that it fired in scenarios nobody set up.
- `pi-extension/tests/reference-flow.e2e.test.ts` proves a duplicate failure event produces
  exactly one workflow run and one explicit, reasoned refusal.

## 2. Migration note: manifest fields → the §3.1 contract

| Field | Status after Phase 0 |
| --- | --- |
| `api_version`, `metadata.name`, `metadata.version` | Unchanged. |
| `metadata.digest` | Unchanged: the manifest digest. |
| `metadata.packageDigest` | **New, runtime-computed.** Covers the manifest plus every package asset, so an editable prompt does not make "what ran" unidentifiable (REQ-BEH-003). Never declared in YAML. |
| `trigger.event_type`, `trigger.predicate` | Unchanged. Triggers may now name lifecycle events such as `fix.verified`, which is how behaviors compose. |
| `policy.mode` | Now enforced at the single command boundary rather than on one of two paths. |
| `policy.timeout` | Now actually bounds the workflow run. |
| `capabilities.tools` | Unchanged; a workflow step may narrow this grant, never widen it. |
| `capabilities.mutation_classes` | Unchanged. |
| `capabilities.commands` | **New, optional.** The third authority axis (REQ-SAFE-003). Absent means the behavior may call no commands — the safe default for every manifest written before commands existed. |
| `execution.graph` | **Retained, inert.** Kept so existing manifests keep validating (REQ-BEH-005). It selects nothing. |
| `execution.workflow` | **New, optional.** When present the shared interpreter runs it. When absent the behavior loads and is explicitly reported at dispatch as having nothing to interpret — it is never silently routed to hardcoded logic, because that fallback is what Phase 0 removed. |
| `execution.test_command` | Unchanged; exposed to workflows as `${behavior.testCommand}` so a package cannot spell its verification command two different ways. |
| `outcomes` | Now validated against the outcomes a workflow's `outcome` steps declare. |

Migrating a legacy package is additive: add `capabilities.commands` and `execution.workflow`.
Nothing existing has to be removed or renamed.

## 3. Spike 0.2: what Pi/OMP can and cannot enforce

Measured, not read from documentation.

### 3.1 Tool grants do not restrict a spawned child

```text
omp -p --no-session --no-extensions --tools=read,grep,glob --cwd=<sandbox>
child reports: _read _grep _glob _manage_skill _learn _write
```

Adding `--no-tools --no-skills` changed nothing. A probe child was asked to use them and
created `~/.omp/agent/managed-skills/containment-probe-delete-me/SKILL.md` — a real file in the
operator's HOME, loaded as a skill in every future session in every repository. Measured three
times (br-33co).

The prompt that child receives is built from test output, which is attacker-influenceable in
principle. So the chain was: hostile text → fix child → indefinite persistence outside the repo.

**`--tools` is a hint, not a boundary.** It is still passed, and it is documented as
defence-in-depth only. Anything describing it as containment is wrong.

### 3.2 What does contain the child

Two OS-level boundaries, both in `agent-port.ts`:

1. **A throwaway HOME.** `HOME`, `USERPROFILE`, the `XDG_*` roots, and the OMP/Pi config
   directories point into a temp directory deleted when the call returns. `_manage_skill` and
   `_learn` still work; what they write dies with the run. Redirected rather than unset,
   because unsetting `HOME` makes most tools fall back to the passwd entry — which is the real
   home again.
2. **An isolated git worktree as cwd.** A child writing relative paths reaches a disposable
   checkout, never the user's tree.

If a worktree cannot be created, the port **refuses to invoke**. "We could not contain it, so we
ran it anyway" is the fail-open shape this epic exists to remove.

### 3.3 What is still not prevented (REQ-SAFE-004)

A child that writes an **absolute path** into the user's repository is not prevented. Neither
boundary above covers it, and preventing it needs an OS sandbox (seatbelt/bwrap/container) that
this harness does not have.

It is **detected**: `agent-port.ts` takes a `git`-object baseline of the live tree before the
call and compares after. On drift it discards the reply and reports, and **does not revert** —
a concurrent user save is indistinguishable from a child's write, and REQ-SAFE-005 forbids
silently overwriting the user's work. Safe under both readings: the user keeps their edit, and a
provider that wrote has broken its read-only contract, so its reply cannot be trusted anyway.

Likewise `WriteBoundaryMonitor` is corrective, not preventive: it detects and reverts
protected-path changes *after* a tool call made them. It is never described as a sandbox.

### 3.4 Approval and cancellation

- **Approval** is reliable through `ui.select`, and fails closed when there is no UI. Four
  answers are used rather than a boolean `confirm`, which would silently collapse allow-always
  and deny-always. A dismissed dialog is deny-once, never a default yes.
- **Cancellation** propagates: the interpreter chains the caller's signal into its own
  controller, ports are required to honour it, and an already-aborted signal aborts on entry
  rather than being ignored until the first deadline. Proven in
  `hostile-tools.e2e.test.ts` and `workflow-interpreter.test.ts`.

### 3.5 Residual risk summary

| Threat | Status |
| --- | --- |
| Child persists a skill into the operator's HOME | **Prevented** (throwaway HOME, OS-enforced) |
| Child writes project source by relative path | **Prevented** (isolated worktree, OS-enforced) |
| Child writes project source by absolute path | **Detected**, reply discarded, not reverted |
| Child reads anything the user can read | **Not prevented.** No secrets boundary exists. |
| Child reaches the network | **Not prevented.** |
| Behavior mutates under `mode: propose` | **Prevented** at the command boundary |
| Protected path edited by any behavior | **Prevented** at proposal time and at the guard |
