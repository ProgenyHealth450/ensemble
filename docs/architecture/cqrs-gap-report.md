# Gap report: checked-out tree vs. the CQRS implementation requirements

- **Status:** Required deliverable of §8 ("Definition of done for Claude") — produced before implementation
- **Date:** 2026-09-29
- **Branch inspected:** `feature/trd-2026-0fc1c1d0-behavior-runtime-pi-harness` at `d52ba41`
- **Specification:** [`ensemble-behavior-cqrs-implementation-requirements.md`](./ensemble-behavior-cqrs-implementation-requirements.md)
- **Bead:** `br-behavior-runtime-cqrs-xl24.1`

This report is the input to Story 0.1 (`br-behavior-runtime-cqrs-xl24.2`). It states what
exists today, not what the docstrings claim. Where the two disagree, the code wins.

## 1. Runtime inventory

### 1.1 Components that exist

| Component | File | Role today |
| --- | --- | --- |
| Event translator | `agent-core/src/behavior/event-translator.ts` | Maps Pi native tool events to `test.failure.observed` etc. Pure. Non-mutating. |
| Matcher | `agent-core/src/behavior/local-event-matcher.ts` | `match()` over compiled manifests. `matchNames()` is a side-effect-free predicate; `onEvent()` invokes. In-memory only. Non-mutating itself. |
| Compiler | `agent-core/src/behavior/compiler.ts` | Field-presence validation + digest. Validates `execution.graph` is a non-empty **string**. No workflow concept exists. |
| `BehaviorRunner` (invoker) | `pi-extension/src/behavior-runner.ts` | The **governed** dispatch path. Calls a fix provider, then `AutofixLoop`. **Mutating** (via AutofixLoop). |
| `AutofixLoop` | `pi-extension/src/autofix-loop.ts` | Applies candidate writes through `MutationGuard.authorize()`, snapshots, runs the suite, restores on failure. **Mutating**. |
| `MutationGuard` | `agent-core/src/behavior/mutation-guard.ts` | The single authorization chokepoint — *for the governed path only*. |
| Continuation queue | `pi-extension/src/extension.ts` (`continuationQueue`, `enqueueContinuation`, `turn_end` handler) | The **second** dispatch path. Injects a user turn via `pi.sendUserMessage`; the host model edits files with its own tools. **Mutating, and it does not traverse `MutationGuard` at all.** |
| Write boundary monitor | `agent-core/src/behavior/write-boundary-monitor.ts` | Post-hoc, effect-based. Detects and reverts changes to protected paths after a tool call. **Corrective, not preventive.** |
| Tool grant enforcement | `pi-extension/src/tool-grant-enforcement.ts` | Blocks native tool calls in the *host* session during a behavior scope. Does not apply to spawned children. |
| Agent fix provider | `pi-extension/src/agent-fix-provider.ts` | Spawns `omp -p --no-extensions --tools=read,grep,glob`. **Escapes containment** — see §3.3. |
| Verifier | `pi-extension/src/verify-suite.ts` | Re-runs the failing command, parses a summary line. |
| Local outbox | `agent-core/src/behavior/outbox.ts` | Append-only JSONL. No acceptance vocabulary at all. |

### 1.2 Every path that can write files or run shell/network operations

1. **`AutofixLoop.deps.applyWrite`** (`behavior-runner.ts`) — `fs.writeFileSync` on an
   authorized candidate. Governed: passes `MutationGuard.authorize()` per write.
2. **The continuation turn** (`extension.ts` `turn_end`) — `pi.sendUserMessage()` queues a
   real turn; the host model then writes with its own `edit`/`write`/`bash`. **Ungoverned.**
   No `MutationGuard`, no mutation class, no `policy.mode` consultation.
3. **`WorkspaceSnapshot.restore()`** (`agent-core`) — writes captured file contents back.
4. **`restoreWorkingTree()`** (`working-tree-snapshot.ts`) — `git checkout -- .` plus
   `git apply`: a **whole-tree** restore in the interactive workspace, which REQ-SAFE-005
   forbids as routine rollback.
5. **`WriteBoundaryMonitor.check()`** — reverts protected-path files post-hoc.
6. **`ConstitutionProposal` / constitution applier** — writes `docs/standards/constitution.md`
   after approval; root selection is unresolved (br-nft8).
7. **`spawnSuite` / `verifySuite` / `execFileSync("git", …)`** — arbitrary shell via
   `spawnSync("bash", ["-lc", command])`, run with the whole ambient environment.
8. **`createAgentFixProvider`'s child process** — a full `omp` agent in the live repo.
9. **`createEnsembleBashTool`** — governed shell, approval-gated.
10. **`FileLocalOutboxSink.append` / `logRuntime`** — appends to `.ensemble/*.jsonl`.

### 1.3 The two-dispatch-path finding (the core of Story 0.1)

One `test.failure.observed` envelope reaches `dispatchingSink.publish()` and starts **both**:

```text
envelope
  ├── enqueueContinuation(...)        →  turn_end  →  pi.sendUserMessage  →  model edits files
  └── matcher.onEvent(...)            →  BehaviorRunner → AutofixLoop → MutationGuard
```

These are not fallbacks for each other. They race. Reproduced live (br-dowt): the governed
branch logged `rejected … mode: propose; direct write to src/math.js is denied` while the
continuation branch repaired `src/math.js` in the same run. Because the continuation branch
always "worked", the governed branch being dead for three days was invisible.

§7 of the spec forbids silently merging them: one route must be chosen and the other removed
or strictly isolated.

## 2. Manifest field → §3.1 contract mapping (migration note)

| Today (`behavior.yaml`) | §3.1 contract | Status |
| --- | --- | --- |
| `api_version` | package/API version | maps directly |
| `metadata.name` / `.version` | stable name, version | maps directly |
| `metadata.digest` | deterministic digest | maps, but covers the **manifest only** — REQ-BEH-003 requires prompt files in the digest |
| `trigger.event_type` + `trigger.predicate` | typed trigger | maps directly |
| `policy.mode` (`propose`/`auto`/`shadow`) | policy | maps; enforced only on the governed path |
| `policy.timeout` | bounded execution | parsed; **never enforced per step** (REQ-SAFE-007 gap) |
| `capabilities.tools` | tool grant | maps; enforcement is host-session-only |
| `capabilities.mutation_classes` | mutation classes | maps; consulted only by `MutationGuard` |
| `execution.graph` | declarative workflow | **NO EQUIVALENT.** It is a free-text string naming a graph that does not exist. There is no step list, no step IDs, no bindings, no conditions, no approval step, no outcome step. |
| `execution.test_command` | — | behavior-specific field; becomes a `command` step argument |
| `outcomes` | declared outcome/event types | present as bare strings; **not validated against the event catalog** |
| — | `commands` the behavior may call | **missing** — no command catalog exists |
| — | prompt/skill references | **missing** — `fix-prompt.md` is loaded by filename convention inside `agent-fix-provider.ts`, unvalidated and undigested |

The single largest gap: **`execution.graph` is a name, not a workflow.** Everything §3.1 and
§3.2 require of a declarative workflow has to be added.

## 3. Which of the 12 acceptance criteria (§6) currently fail

| # | Criterion | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | New behavior needs no behavior-specific TypeScript | **FAILS** | `execution.graph` is inert. The entire test-failure flow is hardcoded in `behavior-runner.ts` + `extension.ts`. A second behavior kind cannot be expressed. |
| 2 | New side effect requires a typed reviewed handler | **FAILS** | There are no command descriptors. Effects are ad-hoc functions (`applyWrite`, `openPullRequest`) wired by closure. |
| 3 | Skills submit requests; handlers authorize; events report facts | **FAILS** | No command layer. `domain-tools` emit events directly from agent payloads. |
| 4 | Every mutation uses the same authorization boundary | **FAILS** | Two paths; the continuation path bypasses `MutationGuard` entirely (§1.3). |
| 5 | `propose` cannot mutate the working tree | **FAILS** | br-dowt: a fix was left applied under `mode: propose`. |
| 6 | Concurrent edits are never lost | **FAILS** | `restoreWorkingTree()` runs `git checkout -- .`, discarding every tracked modification made since the snapshot — including the user's. |
| 7 | No ambiguity/zero-test/timeout accepted as success | **PARTIAL** | `verify-suite.ts` correctly rejects zero-test runs and bare exit codes. It still accepts `2 passed, 2 total` when one of those suites **failed to load** (br-gwww). |
| 8 | No overlapping fix paths, no unbounded recursion | **PARTIAL** | `ContinuationBudget` caps retries, but the two paths themselves overlap by construction. |
| 9 | Constitution changes are proposals applied via a separate transition | **PARTIAL** | `ConstitutionProposal` gates on approval, but proposal/approval/application are one method, and the write root is undecided (br-nft8). |
| 10 | Prompt/workflow edits load without recompiling | **PARTIAL** | `loadFixPromptTemplate` reads `fix-prompt.md` at invocation — but with `template ?? default` and **no validation**, so a package prompt silently replaces the response contract and the run returns "no candidate offered". Workflow data does not exist to edit. |
| 11 | Local vs. Foreman acceptance distinguished | **FAILS** | `LocalOutboxSink.append()` returns `void`. Nothing anywhere carries an acceptance scope. |
| 12 | Existing generation remains compatible | **HOLDS** | `packages/pi` generator untouched; artifact snapshots pass. |

Two criteria hold or nearly hold. Ten do not.

## 4. Specific defects with reproduction, already filed

- **br-dowt** — `holdSkipped: 'no tree baseline; fix left applied'` in a *fresh clone*.
  A missing baseline is treated as permission. Fail-open in a system that fails closed
  everywhere else.
- **br-33co** — `--tools=read,grep,glob` does not restrict tools. Measured three times: the
  child reports `_read _grep _glob _manage_skill _learn _write`. A probe child wrote
  `~/.omp/agent/managed-skills/containment-probe-delete-me/SKILL.md` into the operator's
  HOME. `--no-tools --no-skills` changed nothing. **REQ-SAFE-003 is unmet at the spawn
  boundary**, and the prompt for that child is built from attacker-influenceable test output.
- **br-gwww** — a suite that could not load (`require('../src/rounding')`, absent) was counted
  as passed; the same run's constitution amendment described that exact defect.
- **br-nft8** — the constitution applier follows the failing command's cwd, which may be a
  throwaway worktree. An amendment written there is learned and discarded.

## 5. What Phase 0 must therefore do

1. Delete the continuation path as a *mutation* mechanism (Story 0.1 / REQ-CQRS-002).
   Not gate it behind a flag — §7 explicitly rejects "both paths behind a flag".
2. Contain the fix-agent child at the process level (br-33co), since the tool allowlist
   provably does not contain it.
3. Make "cannot verify" resolve to "do not keep" (br-dowt), everywhere.
4. Replace whole-tree restore with owned-path restore (REQ-SAFE-005).

No implementation had begun when this report was written.
