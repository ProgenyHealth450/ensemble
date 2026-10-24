---
name: adapter-test-runner-default
description: Default `test-runner` toolchain adapter (TRD-2026-8d825f54 TRD-043, PRD REQ-006). Loaded by the toolchain resolver, not invoked directly by name. Dispatches to one of five shipped per-language test runner scripts via `framework`.
---

# Default Test Runner Adapter

This is a `test-runner`-only toolchain adapter (`adapter: default`), the shipped default for
the `test-runner` category (`packages/development/toolchain/toolchain.default.yaml`). A skill
directory, not a command: the toolchain resolver
(`packages/development/lib/toolchain/adapters.js#loadAdapter`) loads `adapter.yaml` and runs its
capabilities through `packages/development/lib/toolchain/runner.js#runCapability`.

Backing tool: none of its own -- it dispatches, via the `framework` input
(`runner.js#selectTemplate`'s `variants` mechanism), to one of the five already-shipped
per-language test runner scripts:

- `packages/jest/skills/run-test.js` (`node`)
- `packages/pytest/skills/run-test.py` (`python3`)
- `packages/exunit/skills/run-test.exs` (`elixir`, per its own `#!/usr/bin/env elixir` shebang)
- `packages/xunit/skills/run-test.sh` (`bash`, per its own `#!/usr/bin/env bash` shebang)
- `packages/rspec/skills/run-test.rb` (`ruby`)

## Vocabulary

- `test-runner.run`: run the test suite at `file` for the selected `framework` (`jest`,
  `pytest`, `exunit`, `xunit` or `rspec`)
- Binaries: `node`, `python3`, `elixir`, `bash`, `ruby`
- Env: none

## Manifest

`adapter.yaml` declares `categories: [test-runner]` only, `contract: {test-runner: "1.0"}`.

`detect: []` -- `default` is the shipped DEFAULT for `test-runner`, not remote-detected, per TRD
interpretation I2 (same convention `adapter-workflow-plain-git`/`adapter-tracker-beads` use).

`binaries: [node, python3, elixir, bash, ruby]`, one per per-language runner script above.
`allowlist` permits each binary only the literal path of its one script plus `--version` (for
the matching health check).

`test-runner.run`'s single capability uses `variants` keyed on `framework`
(`runner.js#selectTemplate`): an unknown `framework` value throws `NOT_ALLOWED` before any
process spawns. Smoke-tested live against this manifest (no process spawned, `NOT_ALLOWED`
thrown before `execFile`):

```js
const { runCapability } = require('./packages/development/lib/toolchain/runner.js');
const yaml = require('js-yaml');
const fs = require('fs');
const adapter = yaml.load(fs.readFileSync('packages/development/skills/adapter-test-runner-default/adapter.yaml', 'utf8'));
runCapability(adapter, 'test-runner.run', { file: 'x', framework: 'not-a-real-framework' })
  .then((r) => console.log(JSON.stringify(r)));
// -> {"ok":false,"error":{"code":"NOT_ALLOWED","message":"framework: 'not-a-real-framework' is not an allowed variant (expected one of: jest, pytest, exunit, xunit, rspec)"}}
```

A `framework: 'pytest'` call selects the `python3` variant (`python3
packages/pytest/skills/run-test.py --file=<file>`), confirmed the same way.

## Known limits

- **`config`/`coverage` are declared category-contract inputs but never referenced.** Only
  jest (`--config`, `--coverage`), pytest (`-c`) and rspec (`--options`) accept any config flag
  at all; xunit has only `--coverage` (no config flag); exunit has neither. There is no way to
  reference either placeholder across all five variants without making it a MANDATORY value on
  every single call (`runner.js#buildCapabilityArgv` always passes an empty `inputs` map to
  `resolveArg`, so no manifest-level default is possible for an optional flag) -- each script's
  own default behavior (no custom config, no coverage collection) is relied on instead, the
  same disclosed gap `adapter-host-github`'s `host.change-request-list` `filter` input has.
- **`skipped` (a declared `test-runner.yaml` output) is never populated.** `parse` is one block
  shared across every `variants` entry (the adapter manifest schema has no per-variant
  `parse`), and `packages/jest/skills/run-test.js`/`packages/exunit/skills/run-test.exs`'s own
  result objects have no `skipped` key at all -- mapping it would throw `BAD_OUTPUT` (`mapping
  .js`: "every path must resolve to a present value") on every jest/exunit call. `success`,
  `passed`, `failed`, `total`, `duration` and `failures` are the only fields every one of the
  five scripts' own JSON always includes, so only those are mapped.
- **A test run that reports failures exits non-zero.** All five shipped scripts intentionally
  `exit(1)` when the suite they ran has failures (standard test-runner CLI convention, by
  design, not specific to this adapter). `runner.js#runCapability` spawns every capability via
  `child_process.execFile`, which treats ANY non-zero exit as an error and resolves `TOOL_FAILED`
  using `stderr` -- never reading the real, structured JSON report these scripts print to
  stdout. This is a pre-existing limitation of the generic runner's exit-code handling (shared
  by every category, not introduced or fixed here); a caller that needs the structured
  pass/fail report from a FAILING run must invoke the underlying script directly rather than
  through `toolchain-cli run test-runner.run`, until a future task addresses it at the runner
  layer. A fully passing run (exit 0) returns the normalized report as documented above.
- **`packages/xunit/skills/run-test.sh` shells out to `dotnet`/`node` internally.** Those
  subprocess calls are inside the script, not part of this adapter's own argv, so they are
  outside this manifest's `binaries`/`allowlist` scope (the same convention
  `adapter-tracker-beads`'s `tracker.stage-export` uses for `cat`'s target file).
- **Never executed live end-to-end through `toolchain-cli run`** (this bead did not have a
  configured target project with all five frameworks installed); `packages/pytest/skills/
  run-test.py --file=<fixture>` was live-verified directly (not through the adapter/runner
  layer) against a real 2-pass/1-fail fixture, see `packages/pytest/tests/run-test.test.js`.
