'use strict';

/**
 * Shared test helper (NOT a test file itself) for TRD-027's built-in
 * `work-graph-links-fallback` adapter test suite (`scripts/tests/work-graph-fallback.test.js`,
 * `packages/development/tests/toolchain-cli.test.js`). Writes a single small, executable,
 * node-shebang stub tracker binary into a caller-supplied directory under `os.tmpdir()`, for a
 * fixture TRACKER adapter whose `adapter.yaml` manifest declares `categories: [tracker]` only
 * (no `work-graph`), so `./work-graph-resolve.js#resolveWorkGraphAdapter`'s `auto` expansion
 * falls back to the built-in adapter.
 *
 * Mirrors `adapter-tracker-beads-stub.js`'s own `control.json`-driven, real-file-on-disk
 * convention (never an inline `-e` script string): a capability's `run[]` argv template is
 * substituted via `packages/development/lib/toolchain/runner.js#buildArgv`, whose runtime
 * placeholder regex matches ANY `{...}` substring of ANY argv element, not just ones
 * `translateManifestTemplate` itself produced from `${...}` -- an inline `-e` script
 * containing ordinary JS object-literal or arrow-function braces (e.g. `{id: i.id}`) would be
 * misread as an undeclared placeholder and fail with `INVALID_ARG` (confirmed by direct
 * experiment while building this fixture). Writing a real file sidesteps this entirely: only
 * the argv template STRING ELEMENTS are scanned for placeholders, never a file's own contents
 * on disk.
 *
 * Never shells out to a real tracker tool and never writes inside the real repository tree.
 */

const fs = require('fs');
const path = require('path');

const CONTROL_FILE_NAME = 'control.json';
const STUB_BIN_NAME = 'fixture-work-graph-tracker';

/**
 * @param {string} binDir absolute path to the per-test stub bin directory
 * @returns {string} the control file path
 */
function controlFilePath(binDir) {
  return path.join(binDir, CONTROL_FILE_NAME);
}

/**
 * Write this test's item data. Call once per test, after `writeNoWorkGraphTrackerStub(binDir)`.
 *
 * @param {string} binDir the same directory passed to `writeNoWorkGraphTrackerStub`
 * @param {{id: string, status: string, dependencies?: {id: string}[]}[]} items `list` returns
 *   `{id}` for each, in this exact order; `show <id>` returns the full matching entry
 *   (`dependencies` included only when the entry itself declares it, letting a caller control
 *   whether `tracker.show`'s declared `parse.map` even has a `dependencies` path to resolve)
 */
function writeStubControl(binDir, items) {
  fs.writeFileSync(controlFilePath(binDir), JSON.stringify({ items }));
}

const STUB_SOURCE = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);

function readControl() {
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(process.argv[1]), '${CONTROL_FILE_NAME}'), 'utf8'));
  } catch {
    return { items: [] };
  }
}
const items = readControl().items || [];

function out(value) {
  process.stdout.write(JSON.stringify(value));
}

if (argv[0] === 'list') {
  out(items.map((item) => ({ id: item.id })));
} else if (argv[0] === 'show') {
  const item = items.find((candidate) => candidate.id === argv[1]);
  out(item || { id: argv[1] });
} else {
  process.stderr.write('stub fixture-work-graph-tracker: unrecognized argv ' + JSON.stringify(argv) + '\\n');
  process.exit(1);
}
`;

/**
 * Write the executable stub tracker binary into `binDir` (created if missing).
 *
 * @param {string} binDir absolute path, expected to live under `os.tmpdir()`
 * @returns {string} absolute path to the written stub binary
 */
function writeNoWorkGraphTrackerStub(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const binPath = path.join(binDir, STUB_BIN_NAME);
  fs.writeFileSync(binPath, STUB_SOURCE, { mode: 0o755 });
  fs.chmodSync(binPath, 0o755);
  return binPath;
}

module.exports = { writeNoWorkGraphTrackerStub, writeStubControl, STUB_BIN_NAME };
