'use strict';

/**
 * Shared test helper (NOT a test file itself) for `adapter-tracker-beads`'s own test suite
 * (TRD-2026-8d825f54 TRD-024). Writes small, executable, node-shebang stub `br`/`bv` scripts
 * into a caller-supplied directory under `os.tmpdir()`; a caller prepends that directory to
 * `PATH` so the adapter's real, unmodified `adapter.yaml` `run[]` templates (which invoke the
 * bare binary names `br`/`bv`, resolved via `PATH`) hit these stubs instead of a real
 * `br`/`bv` install. NEVER writes inside the real repository tree and NEVER shells out to a
 * real `br`/`bv` binary itself.
 *
 * Both stubs branch on `process.argv.slice(2)` (the argv the adapter's `run[]` template
 * produced, minus the interpreter and script path) to decide which canned JSON to print,
 * mirroring real `br`/`bv` output shapes captured live and saved under
 * `scripts/tests/fixtures/toolchain/adapter-tracker-beads-samples/` (see that directory's
 * `README.md` for provenance).
 *
 * A per-test CONTROL FILE, not an env var, drives the handful of response variations the
 * suite needs (which `status` `br show` reports, whether `br list` wraps its output, which ids
 * `bv --robot-plan` lists): `packages/development/lib/toolchain/runner.js#buildChildEnv`
 * deliberately strips every env var the resolved adapter's own `env: []` does not declare
 * (plus a small fixed allowlist: `PATH`/`HOME`/`USER`/`LOGNAME`/`LANG`/`TMPDIR`/`TERM`/`TZ`)
 * before spawning ANY adapter child process -- a custom `STUB_*` env var set on the TEST
 * process would never reach the stub child at all (proven empirically: an earlier version of
 * this helper tried exactly that and every "variant" test silently saw only the stub's
 * hard-coded default). `TMPDIR` IS in that fixed allowlist and is always copied through
 * unchanged from the real parent environment, so `os.tmpdir()` resolves identically inside the
 * spawned stub child as it does inside the test process that wrote the control file --
 * `writeStubControl`/the stub's own read both resolve `controlFilePath()` the same way,
 * giving the test process a channel to the stub child that survives `buildChildEnv`'s
 * filtering without needing any new entry in `BASE_ENV_ALLOWLIST` or the adapter's `env: []`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONTROL_FILE_NAME = '.adapter-tracker-beads-stub-control.json';

/** Resolve the control-file path; shared by `writeStubControl`/`clearStubControl` and the
 * stub scripts' own inline copy of this same one-liner (duplicated there, not required, so
 * each stub stays a single self-contained file with no local `require` of this module). */
function controlFilePath() {
  return path.join(os.tmpdir(), CONTROL_FILE_NAME);
}

/**
 * Write this test's stub response overrides. Call once per test (after `writeBeadsStubs`,
 * before invoking the adapter); `afterEach` should call `clearStubControl()` unconditionally
 * so one test's overrides never leak into the next.
 * @param {{brShowStatus?: string, brListShape?: 'wrapped'|'bare', bvItemIds?: string[]}} [overrides]
 */
function writeStubControl(overrides = {}) {
  fs.writeFileSync(controlFilePath(), JSON.stringify(overrides));
}

/** Remove any control file a test left behind; safe to call even when none exists. */
function clearStubControl() {
  fs.rmSync(controlFilePath(), { force: true });
}

const BR_STUB_SOURCE = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const argv = process.argv.slice(2);

function readControl() {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.tmpdir(), '${CONTROL_FILE_NAME}'), 'utf8'));
  } catch {
    return {};
  }
}
const control = readControl();
const status = control.brShowStatus || 'open';
const listShape = control.brListShape || 'wrapped';

function out(value) {
  process.stdout.write(JSON.stringify(value));
}

if (argv[0] === '--version') {
  process.stdout.write('br 0.6.0-stub\\n');
} else if (argv[0] === 'show') {
  out([
    { id: argv[1], title: 'Stub title', description: 'Stub description', issue_type: 'task', status, labels: ['a', 'b'] }
  ]);
} else if (argv[0] === 'list') {
  const issues = [{ id: 'b-1', title: 'Stub issue', status: 'open', issue_type: 'task', labels: [] }];
  out(listShape === 'bare' ? issues : { issues, total: issues.length, limit: 0, offset: 0, has_more: false });
} else if (argv[0] === 'create') {
  out([{ id: 'br-created-1', title: 'Stub created', status: 'open' }]);
} else if (argv[0] === 'update') {
  out([{ id: argv[1], status: 'open' }]);
} else if (argv[0] === 'close') {
  out([{ id: argv[1], status: 'closed' }]);
} else if (argv[0] === 'comments' && argv[1] === 'add') {
  out([{ id: argv[2] }]);
} else if (argv[0] === 'comments' && argv[1] === 'list') {
  out([{ author: 'stub', text: 'a stub comment' }]);
} else if (argv[0] === 'dep' && argv[1] === 'add') {
  out([{ id: argv[2] }]);
} else if (argv[0] === 'dep' && argv[1] === 'remove') {
  out([{ id: argv[2] }]);
} else if (argv[0] === 'label' && argv[1] === 'add') {
  out({ ids: [argv[2]], labels: ['stub-label'] });
} else if (argv[0] === 'sync') {
  out({ status: 'flushed' });
} else {
  process.stderr.write('stub br: unrecognized argv ' + JSON.stringify(argv) + '\\n');
  process.exit(1);
}
`;

const BV_STUB_SOURCE = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const argv = process.argv.slice(2);

function readControl() {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.tmpdir(), '${CONTROL_FILE_NAME}'), 'utf8'));
  } catch {
    return {};
  }
}
const control = readControl();
const ids = control.bvItemIds || ['br-zz-last', 'br-aa-first', 'br-mm-mid'];

function out(value) {
  process.stdout.write(JSON.stringify(value));
}

if (argv.includes('--version')) {
  process.stdout.write('bv v0.25.2-stub\\n');
} else if (argv.includes('--robot-plan')) {
  const items = ids.map((id, i) => ({ id, title: 'Stub ' + id, priority: i, status: 'open', unblocks: [] }));
  out({
    plan: {
      tracks: [
        { track_id: 'track-A', items, reason: 'Independent work stream' },
        { track_id: 'track-B', items: [{ id: 'br-other-track', title: 'x', priority: 0, status: 'open', unblocks: [] }], reason: 'Independent work stream' }
      ],
      total_actionable: items.length + 1,
      total_blocked: 0,
      summary: { highest_impact: items[0] ? items[0].id : null, impact_reason: 'stub', unblocks_count: 0 }
    }
  });
} else if (argv.includes('--robot-insights')) {
  out({
    status: { Cycles: { state: 'computed' }, PageRank: { state: 'computed' } },
    Cycles: []
  });
} else {
  process.stderr.write('stub bv: unrecognized argv ' + JSON.stringify(argv) + '\\n');
  process.exit(1);
}
`;

/**
 * Write executable `br`/`bv` stub scripts into `binDir` (created if missing). Returns `binDir`
 * for convenient chaining.
 * @param {string} binDir absolute path, expected to live under `os.tmpdir()`
 * @returns {string} `binDir`
 */
function writeBeadsStubs(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const brPath = path.join(binDir, 'br');
  const bvPath = path.join(binDir, 'bv');
  fs.writeFileSync(brPath, BR_STUB_SOURCE, { mode: 0o755 });
  fs.writeFileSync(bvPath, BV_STUB_SOURCE, { mode: 0o755 });
  fs.chmodSync(brPath, 0o755);
  fs.chmodSync(bvPath, 0o755);
  return binDir;
}

module.exports = { writeBeadsStubs, writeStubControl, clearStubControl };
