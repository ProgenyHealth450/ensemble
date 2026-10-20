# ensemble-telemetry

Local, opt-in usage telemetry: which Ensemble commands, skills and agents do you actually use?

## Enable

Off by default. Opt in with `ENSEMBLE_TELEMETRY=1` or create `.ensemble/telemetry/enabled` in your project.

## What is recorded

One line per use in `.ensemble/telemetry/usage.jsonl`: `{ts, session_id, kind, name}`. Never prompt text, tool inputs/outputs, tokens, or paths. Nothing leaves your machine; delete the file anytime.

## Report

```bash
node bin/ensemble-stats.js            # usage ranking
node bin/ensemble-stats.js --inventory --repo <ensemble-root>   # plus zero-use components
node bin/ensemble-stats.js --json
```
