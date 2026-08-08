# Parallel AI-Agent Worktree Workflow

A friction-free loop for running **OMP**, **Claude Code**, and **Codex** in parallel
git worktrees: create → kick off an agent → merge or abandon, with live conflict radar.

Stack:

| Tool | Role | Language |
|------|------|----------|
| [worktrunk](https://github.com/max-sixty/worktrunk) (`wt`) | create / run / merge / abandon worktrees, agent-agnostic | Rust |
| [OMP](https://github.com/can1357/oh-my-pi) / [Claude Code](https://claude.com/claude-code) / [Codex](https://github.com/openai/codex) | the agents that do the work | — |
| [clash](https://github.com/clash-sh/clash) | predict merge conflicts *across* worktrees before they bite | Rust |

> Note: OMP only isolates *sub-agents* via the task tool — main-session worktree
> isolation was closed as "not planned". So we drive the agent from *outside* with
> `wt`; the agent just operates on its worktree's `cwd`.

---

## 1. Install

```bash
# worktrunk
brew install worktrunk        # or: cargo install worktrunk

# clash
brew tap clash-sh/tap && brew install clash    # or: cargo install clash-sh
# (Claude Code only) auto pre-write conflict checks:
claude plugin install clash@clash-sh
```

---

## 2. Agent invocation reference

Everything after `--` is passed verbatim to the launched binary.

| Agent | Interactive (TUI) | Headless / one-shot |
|-------|-------------------|---------------------|
| OMP | `omp` | `omp -p "<task>"` |
| Claude Code | `claude` | `claude -p "<task>"` |
| Codex | `codex` | `codex exec "<task>"` |

Launch any of them inside a fresh worktree via `wt`:

```bash
# interactive — creates worktree + branch, drops you into the agent's TUI
wt switch -c feature-auth -x omp
wt switch -c feature-auth -x claude
wt switch -c feature-auth -x codex

# headless — runs the task and exits
wt switch -c feature-auth -x omp    -- -p   "add user authentication"
wt switch -c feature-auth -x claude -- -p   "add user authentication"
wt switch -c feature-auth -x codex  -- exec "add user authentication"
```

Close the loop:

```bash
wt list      # every active worktree/agent + status at a glance
wt merge     # squash/rebase/merge back + auto-clean the worktree   → "merge"
wt remove    # tear down worktree and branch                        → "abandon"
```

---

## 3. Config files

### User config — `~/.config/worktrunk/config.toml`

```toml
# keep worktrees tucked under the repo, off to the side
worktree-path = "{{ repo_path }}/.worktrees/{{ branch | sanitize }}"

# let an agent write commit messages (swap the model/agent to taste)
[commit.generation]
command = "omp -p --model=anthropic/claude-haiku"

[list]
columns = ["branch", "status", "ci", "path"]
```

### Project config — `.config/wt.toml` (commit this in the ensemble repo)

Tailored to ensemble-plugins (Node ≥20, npm workspaces):

```toml
# runs once when a worktree is created, before the agent starts
[pre-start]
deps = "npm ci"

# merge gate — wt merge won't proceed unless these pass
[pre-merge]
conflicts = "clash status"          # warn on cross-worktree collisions
validate  = "npm run validate"      # plugin structure + version sync + model ids
test      = "npm test"              # workspace tests
```

> Add `.worktrees/` to `.gitignore` if you use the `worktree-path` above.

---

## 4. Conflict radar (clash)

```bash
clash status          # matrix: which worktree pairs collide, on how many files
clash watch           # live TUI, auto-refreshes as agents write   ← keep this open
clash check <file>    # single-file check; exit code 2 if it'd conflict
clash status --json   # machine-readable, for agent hooks / scripts
```

- **Claude Code:** the `clash@clash-sh` plugin checks automatically before every write.
- **OMP / Codex:** no native plugin — add a line like *"run `clash check <file>` before
  editing; if it exits non-zero, stop and report"* to `AGENTS.md` / your OMP instructions,
  and/or just watch the `clash watch` pane.

Read-only: clash uses `git merge-tree` to simulate merges; it never touches your repo.

---

## 5. tmux layout

One window, agents on the left, conflict radar pinned on the right:

```bash
# from the repo root
tmux new-session -d -s agents -c "$PWD"

# right-hand radar pane (25% width)
tmux split-window -h -p 25 -t agents -c "$PWD" 'clash watch'

# left side: stack a few agent panes
tmux select-pane -t agents:0.0
tmux split-window -v -t agents:0.0 -c "$PWD"
tmux split-window -v -t agents:0.0 -c "$PWD"

tmux attach -t agents
```

Then in each left pane, kick off a worktree agent:

```bash
wt switch -c feat/a -x omp
wt switch -c feat/b -x claude
wt switch -c fix/c  -x codex -- exec "fix the failing validate step"
```

Watch the clash pane light up if two agents wander into the same files; resolve or
re-scope before you `wt merge`.

---

## 6. Optional shell aliases — `~/.zshrc`

```bash
ompwt()  { wt switch -c "$1" -x omp; }                       # ompwt feat/x
omprun() { wt switch -c "$1" -x omp -- -p "$2"; }            # omprun feat/x "task"
ccwt()   { wt switch -c "$1" -x claude; }
cxwt()   { wt switch -c "$1" -x codex; }
alias ship='wt merge'      # merge back + cleanup
alias nuke='wt remove'     # abandon
alias wts='wt list'        # all active agents
alias cw='clash watch'     # radar
```

Whole cycle in a few keystrokes: `omprun feat/x "..."` → work → `ship` or `nuke`.
