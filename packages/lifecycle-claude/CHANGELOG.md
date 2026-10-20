# Changelog

## [Unreleased]

### Added
- Claude Code adapter for command lifecycle hooks: `UserPromptSubmit` starts a run for `/ensemble:<name>`; `Stop`, `StopFailure` and `SessionEnd` end it. Shell handlers only; same `.ensemble/hooks.yaml`, payload, redaction, timeouts and trust store as Pi.
- `trust` subcommand to record trust from a terminal.
