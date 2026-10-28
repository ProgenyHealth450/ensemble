'use strict';

/**
 * Shared test helper (NOT a test file itself) for `adapter-tracker-azure-boards`'s own test
 * suite (TRD-2026-8d825f54 TRD-033/TRD-033-TEST). Writes a small, executable, node-shebang
 * stub `az` script into a caller-supplied directory under `os.tmpdir()`; a caller prepends
 * that directory to `PATH` so the adapter's real, unmodified `adapter.yaml` `run[]` templates
 * (which invoke the bare binary name `az`, resolved via `PATH`) hit this stub instead of a
 * real `az` install. NEVER writes inside the real repository tree and NEVER shells out to a
 * real `az`/`jira`/`br`/`bv` binary itself -- no `az` binary is installed in this environment
 * at all.
 *
 * Unlike `adapter-tracker-jira-stub.js`/`adapter-tracker-beads-stub.js`, every mutating/show
 * `az` subcommand this adapter's manifest declares carries a `--query <JMESPath>` argument
 * that a REAL `az` would apply to flatten its raw REST response before ever printing it. This
 * stub does not implement a JMESPath evaluator (no such dependency exists in this repo, and
 * none is added for a test-only stub); it instead ignores the literal `--query`/`--output`
 * argv values and returns the exact already-flattened canned object the real `--query`
 * expression IN THIS ADAPTER'S OWN `adapter.yaml` would produce for the fixed, hand-derived
 * sample this file's own canned responses are built from -- the same "canned flat response"
 * convention `adapter-tracker-jira-stub.js`/`adapter-tracker-beads-stub.js` already use for
 * their own mutating commands (neither of those tools' real create/update/close JSON shapes
 * were independently captured live either).
 *
 * Multi-word subcommand matching: this stub branches on `process.argv.slice(2)` joined by a
 * single space and matched by PREFIX against each known multi-word subcommand (`boards
 * work-item show`, `boards work-item create`, `boards work-item update`, `boards work-item
 * relation add`, `boards query`), never only `argv[2]` -- mirroring the multi-word
 * `allowlist[].sub` entries this wave's engine fix
 * (`validate.js`/`runner.js#matchesSubcommandWords`) added support for.
 *
 * A per-test CONTROL FILE, not an env var, drives response variations, mirroring
 * `adapter-tracker-jira-stub.js`/`adapter-tracker-beads-stub.js`'s own documented reasoning:
 * `runner.js#buildChildEnv` deliberately strips every env var the resolved adapter's own
 * `env:` list does not declare (plus a small fixed allowlist) before spawning ANY adapter
 * child process, so a custom `STUB_*` env var set on the TEST process would never reach the
 * stub child. The control file lives INSIDE the caller-supplied `binDir`
 * (`<binDir>/control.json`), giving every test its own private channel with no shared state
 * across jest worker processes.
 */

const fs = require('fs');
const path = require('path');

const CONTROL_FILE_NAME = 'control.json';

/**
 * Resolve one test's control-file path, colocated with its stub binary inside `binDir`.
 * @param {string} binDir absolute path to the per-test stub bin directory
 * @returns {string}
 */
function controlFilePath(binDir) {
  return path.join(binDir, CONTROL_FILE_NAME);
}

/**
 * Write this test's stub response overrides. Call once per test (after
 * `writeAzureBoardsStub(binDir)`, before invoking the adapter), passing the same `binDir`. No
 * cleanup call is needed: the control file lives inside `binDir`, which every caller already
 * removes in its own `afterEach` (`fs.rmSync(dir, {recursive: true, force: true})`).
 * @param {string} binDir the same directory passed to `writeAzureBoardsStub`
 * @param {{state?: string, errorEnvelope?: boolean}} [overrides]
 */
function writeStubControl(binDir, overrides = {}) {
  fs.writeFileSync(controlFilePath(binDir), JSON.stringify(overrides));
}

const AZ_STUB_SOURCE = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const joined = argv.join(' ');

function readControl() {
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(process.argv[1]), 'control.json'), 'utf8'));
  } catch {
    return {};
  }
}
const control = readControl();
const state = control.state || 'Active';
const errorEnvelope = Boolean(control.errorEnvelope);

function out(value) {
  process.stdout.write(JSON.stringify(value));
}

// Matches the adapter's own documented tool-failure-on-zero-exit shape (TRD-024's
// \\\`checkZeroExitErrorEnvelope\\\`, reused verbatim by this adapter's runner call): a
// top-level JSON OBJECT with its own \\\`error\\\` property.
const ERROR_ENVELOPE = { error: { code: 'TOOL_FAILED', message: 'stub az failure' } };

// Matches the real relation REST shape (\\\`rel\\\`/\\\`url\\\`/\\\`attributes.name\\\`) this
// adapter's own \\\`arrayMap\\\` filters/reshapes; includes a non-Predecessor relation (and one
// with no \\\`attributes\\\` at all) to prove the filter actually excludes non-matches, not a
// passthrough.
const STUB_RELATIONS = [
  { rel: 'System.LinkTypes.Dependency-Reverse', url: 'https://dev.azure.com/stub-org/stub-project/_apis/wit/workItems/456', attributes: { name: 'Predecessor' } },
  { rel: 'System.LinkTypes.Hierarchy-Forward', url: 'https://dev.azure.com/stub-org/stub-project/_apis/wit/workItems/789', attributes: { name: 'Child' } },
  { rel: 'AttachedFile', url: 'https://dev.azure.com/stub-org/stub-project/_apis/wit/attachments/abc' }
];

if (argv[0] === '--version') {
  process.stdout.write('azure-cli                         2.60.0-stub\\n');
} else if (argv[0] === 'extension' && argv[1] === 'show') {
  out({ name: 'azure-devops', version: '1.0.1-stub' });
} else if (argv[0] === 'devops' && argv[1] === 'configure') {
  out({ organization: 'https://dev.azure.com/stub-org', project: 'stub-project' });
} else if (argv[0] === 'account' && argv[1] === 'show') {
  out({ id: 'stub-subscription-id', name: 'Stub Subscription' });
} else if (joined.startsWith('boards work-item show')) {
  const idIdx = argv.indexOf('--id');
  const id = idIdx >= 0 ? argv[idIdx + 1] : '0';
  out(
    errorEnvelope
      ? ERROR_ENVELOPE
      : [String(id), 'Stub work item title', 'Stub work item description', 'User Story', state, '2', STUB_RELATIONS]
  );
} else if (joined.startsWith('boards work-item create')) {
  out(errorEnvelope ? ERROR_ENVELOPE : 'stub-created-1');
} else if (joined.startsWith('boards work-item relation add')) {
  const idIdx = argv.indexOf('--id');
  const id = idIdx >= 0 ? argv[idIdx + 1] : '0';
  out(errorEnvelope ? ERROR_ENVELOPE : String(id));
} else if (joined.startsWith('boards work-item update')) {
  const idIdx = argv.indexOf('--id');
  const id = idIdx >= 0 ? argv[idIdx + 1] : '0';
  const stateIdx = argv.indexOf('--state');
  const requestedState = stateIdx >= 0 ? argv[stateIdx + 1] : null;
  if (errorEnvelope) {
    out(ERROR_ENVELOPE);
  } else if (requestedState !== null) {
    // tracker.close (always literal "Closed") and tracker.set-status (PR 8: New/Active/Closed
    // per its \\\`variants\\\` selector) both send \\\`--state\\\` plus the 2-element
    // [to_string(id), fields."System.State"] --query -- a 2-element [id, state] array.
    out([String(id), requestedState]);
  } else {
    // tracker.update (PR 8: --title, no --state at all) / tracker.comment (--discussion, no
    // --state at all) -- bare scalar id, matching the real \\\`to_string(id)\\\` --query.
    out(String(id));
  }
} else if (joined.startsWith('boards query')) {
  // PR 8: tracker.list's run template now flattens each raw { id, fields: {...} } REST
  // work-item via its own \\\`--query "[].[to_string(id), fields.\\"System.Title\\",
  // fields.\\"System.State\\"]"\\\` projection -- this stub does not evaluate JMESPath (see
  // this file's own header), so it returns the shape that projection would ALREADY produce
  // for the same two stub items the pre-PR-8 raw-object canned response used: a bare array of
  // 3-element [id, title, state] arrays, which this adapter's own \\\`parse.arrayMap\\\` then
  // renames into {id, title, status} objects.
  out(
    errorEnvelope
      ? ERROR_ENVELOPE
      : [
          ['1', 'Stub item one', 'New'],
          ['2', 'Stub item two', 'Active']
        ]
  );
} else {
  process.stderr.write('stub az: unrecognized argv ' + JSON.stringify(argv) + '\\n');
  process.exit(1);
}
`;

/**
 * Write an executable `az` stub script into `binDir` (created if missing). Returns `binDir`
 * for convenient chaining.
 * @param {string} binDir absolute path, expected to live under `os.tmpdir()`
 * @returns {string} `binDir`
 */
function writeAzureBoardsStub(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const azPath = path.join(binDir, 'az');
  fs.writeFileSync(azPath, AZ_STUB_SOURCE, { mode: 0o755 });
  fs.chmodSync(azPath, 0o755);
  return binDir;
}

module.exports = { writeAzureBoardsStub, writeStubControl };
