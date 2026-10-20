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

`ENSEMBLE_GUARDS=0` disables all guards. Not implemented: test-first guard.
