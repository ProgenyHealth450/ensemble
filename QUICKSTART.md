# Quickstart

## Install (Claude Code)

```bash
/plugin marketplace add Sunstone-Partners/ensemble
/plugin install ensemble-full@ensemble
```

Or install single plugins, e.g. `/plugin install ensemble-core@ensemble`. See README.md for the full list and scopes.

Local development: `claude --plugin-dir ./ensemble/packages/core`.

## Build a feature

```text
/ensemble:new-feature --idea "add CSV export to reports"
```

This drives the feature lifecycle (PRD, TRD, implementation) and pauses at gates for your approval. Individual steps are also available: `/ensemble:create-prd`, `/ensemble:create-trd`.

Prefer the dispatcher form: `/ensemble:feature new <idea>`.

## Where artifacts land

- PRDs: `docs/PRD/`
- TRDs: `docs/TRD/`
- Run state: `.ensemble/new-feature/`

## Resume / status / abandon

```text
/ensemble:feature resume
/ensemble:feature status
/ensemble:feature abandon [reason]
```

`resume` continues the active or paused run from its last checkpoint.

## Uninstall

```bash
/plugin uninstall ensemble-full@ensemble
/plugin marketplace remove ensemble
```
