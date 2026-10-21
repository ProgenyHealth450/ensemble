# ensemble-guards

Hooks that enforce rules prompts only request. Any internal error fails open (exit 0).

| Rule | Blocks |
|---|---|
| `protected-branch` | `git commit`/`push` on main, master, production (including after `git checkout`/`switch` earlier in the same command); force push to them |
| `bypass-flags` | `--no-verify`, `--no-gpg-sign` on git commands |
| `br-close-reason` | `br close` without non-empty `--reason` |
| `dod` | Stop/SubagentStop when your command fails (opt-in) |

Configure `.ensemble/guards.json`:

```json
{ "protectedBranches": ["main"], "disable": ["bypass-flags"],
  "dod": { "command": "npm test", "timeoutSec": 300 } }
```

`protectedBranches` replaces the default list (main, master, production) wholesale; list every branch you want protected.

A `git push` whose remote/refspec contains an unresolved shell expansion (`$VAR`, `${VAR}`, `$(...)`, backticks, `{a,b}` / `{a..b}` braces) is blocked under `protected-branch`, because it cannot be proven not to target a protected branch; spell the branch literally. Commands nesting more than 200 substitution / `bash -c` / `eval` bodies, exceeding 1 MB of analyzed text, or longer than 1 MB while mentioning `git push`, are blocked for the same reason.

Push-adjacent text fails closed (`protected-branch`): reserved words and function bodies (`do`, `then`, `{`, `f(){`) are stripped so the inner `git` is analyzed; and a command is blocked when (a) `git ... push` appears as separate words under a command that is not git and not an inert printer (`echo`, `grep`, `man`, `cat`...), e.g. `timeout 5 git push`, or (b) the text mentions `git ... push` and is fed to a shell, `xargs`, `eval` or `source` through stdin, a here-string, a process substitution or an expansion (`echo 'git push ...' | sh`). Quoted mentions (`git commit -m "git push"`, `grep "git push" docs/`) and `bash script.sh` stay allowed. If the hook itself errors on text mentioning git push, it blocks instead of failing open.

The shell/`xargs`/`eval`/`source` gate is scoped: the `git ... push` text must be in the same pipeline / command-list segment as the consumer (an `eval "$x"` whose value may come from an earlier assignment checks the whole command). `xargs` targeting `wc`, `grep`, `echo`, `cat`, `head`, `sort`, `ls`, ... is data-only and allowed; `xargs sh -c`, `xargs bash -c`, `xargs git` and any shell reading a pipe still block. `git send-pack` / `git http-push` get the same protected-ref analysis as `git push`; wrappers (`timeout`, `nice`, `ionice`, `stdbuf`, `setsid`, `watch`, `caffeinate`, `script`...) are skipped and any `sh|bash|zsh|dash|ksh -c` payload is analyzed wherever it appears.

`ENSEMBLE_GUARDS=0` disables all guards. Not implemented: test-first guard.
