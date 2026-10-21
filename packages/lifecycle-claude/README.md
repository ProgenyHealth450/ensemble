# ensemble-lifecycle

Runs the `command.start` / `command.end` hooks from `.ensemble/hooks.yaml` in Claude Code, as in Pi. See `docs/guides/command-lifecycle-hooks.md`.

- **Start**: a prompt `/ensemble:<name> ...` runs the command's `start` handlers. A `block` handler that fails stops the prompt.
- **End**: `Stop` runs the `end` handlers once (`succeeded`); `StopFailure` is `failed`; a new command or `SessionEnd` ends an unfinished run `cancelled`.
- **Shell handlers only**; prompt handlers are Pi-only and count as failed.
- **Trust** (outside the repo): run `node <plugin>/bundle/lifecycle.cjs trust` in a terminal.

Rebuild after changing agent-core hooks: `npm run build` (needs bun); the bundle is committed.
