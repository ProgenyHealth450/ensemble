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

A `git push` whose remote/refspec contains an unresolved shell expansion (`$VAR`, `${VAR}`, `$(...)`, backticks) is blocked under `protected-branch`, because it cannot be proven not to target a protected branch; spell the branch literally. Commands nesting more than 200 substitution / `bash -c` / `eval` bodies that mention git or br are blocked for the same reason.

`ENSEMBLE_GUARDS=0` disables all guards. Not implemented: test-first guard.
