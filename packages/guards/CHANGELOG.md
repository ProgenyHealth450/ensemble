# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `PreToolUse` (Bash) guards: commit/push on protected branches, force push to protected branches, `--no-verify`/`--no-gpg-sign` bypass flags, `br close` without `--reason`.
- Opt-in `Stop`/`SubagentStop` Definition-of-Done gate configured in `.ensemble/guards.json`.
- Fail-open on any internal error; `ENSEMBLE_GUARDS=0` disables everything.
