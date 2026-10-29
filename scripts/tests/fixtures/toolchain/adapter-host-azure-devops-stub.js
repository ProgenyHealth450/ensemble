'use strict';

/**
 * Shared test helper (NOT a test file itself) for the scripted host-swap scenario
 * (TRD-2026-8d825f54 TRD-041, bead br-d6cq, PRD AC-017-1/2/3). Writes a small, executable,
 * node-shebang stub `az` script into a caller-supplied directory under `os.tmpdir()`; a caller
 * prepends that directory to `PATH` so `adapter-host-azure-devops`'s real, unmodified
 * `adapter.yaml` `run[]`/`health[]` templates (which invoke the bare binary name `az`, resolved
 * via `PATH`) hit this stub instead of a real `az` install. NEVER writes inside the real
 * repository tree and NEVER shells out to a real `az`/`gh` binary itself -- no `az` binary is
 * installed in this environment at all (confirmed by `adapter-host-azure-devops/SKILL.md`'s own
 * disclosed "no az binary is installed" note).
 *
 * Deliberately narrower than `adapter-tracker-azure-boards-stub.js`: this stub answers only the
 * subcommands `adapter-host-azure-devops/adapter.yaml`'s own `health[]`/`run[]` templates
 * actually invoke (`--version`, `extension show`, `devops configure`, `repos pr list` for the
 * four health checks; `repos pr create`/`show`/`update`/`work-item add` for the four
 * capabilities this scenario exercises) -- `az boards *`/`az account show` are never dispatched
 * here because the host-swap scenario never requests `tracker.*`/`host.auth-status` capabilities
 * at all (its `tracker: azure-boards` config setting is proven via a bare `resolve --json` call,
 * which loads no adapter binary), so a stub branch for them would be untested, un-exercised
 * surface. Any unrecognized argv fails loudly (stderr + exit 1) rather than silently succeeding,
 * so a routing mistake in the production code under test surfaces as a real subprocess failure,
 * not a passed assertion on the wrong data.
 *
 * `az repos pr create`/`show`/`update` each carry a `--query "[...]"` that pre-flattens REST
 * fields into a plain JSON array, mirroring the real `az --query` behavior this adapter's own
 * `parse.map`/`parse.trimPrefix`/`parse.statusMap` blocks expect (TRD-040). No JMESPath
 * evaluator exists in this repo (same documented limitation `adapter-tracker-azure-boards-
 * stub.js` carries), so this stub ignores the literal `--query`/`--output` argv values and
 * returns the exact already-flattened array the real expression IN THIS ADAPTER'S OWN
 * `adapter.yaml` would produce for its own `--source-branch`/`--target-branch`/`--id` argv
 * inputs -- the same "canned flat response" convention. A small `state.json` file written next
 * to the stub binary (inside `binDir`, never the real repo) persists the created pull request's
 * branches across the separate `create` -> `show` -> `update` process invocations, since each is
 * its own fresh node process with no shared memory -- the same "per-test private channel inside
 * binDir" reasoning `adapter-tracker-azure-boards-stub.js`'s own `control.json` convention uses,
 * just written by the stub itself rather than the test.
 *
 * `az repos pr work-item add` has no `--query`/documented JSON success shape at all (per this
 * adapter's own disclosed "Known limits": no `az` binary is installed here to confirm one
 * empirically, and no publicly documented shape exists either), so this stub prints a plain
 * human-readable confirmation line, never fabricated JSON -- matching the adapter's own choice
 * to declare no `parse` block for this capability (`mapAndValidateOutput`'s documented
 * `!cap.parse -> {data: stdout}` behavior).
 */

const fs = require('fs');
const path = require('path');

/**
 * Build the source text for the combined `az` stub. `prId` is the fixed pull request id every
 * `repos pr create` call in a given test returns (a stub-chosen literal, matching the
 * `createdId`-parameter convention `tracker-swap-scenario.test.js`'s own `azStubSource` uses).
 * @param {{prId?: string}} [opts]
 * @returns {string}
 */
function azStubSource({ prId = '501' } = {}) {
  return [
    '#!/usr/bin/env node',
    "'use strict';",
    "const fs = require('fs');",
    "const path = require('path');",
    'const argv = process.argv.slice(2);',
    "fs.appendFileSync(path.join(__dirname, 'calls-az.log'), JSON.stringify(argv) + '\\n');",
    "const joined = argv.join(' ');",
    "const STATE_FILE = path.join(__dirname, 'state.json');",
    'function out(value) { process.stdout.write(JSON.stringify(value)); }',
    "function flagValue(name) { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; }",
    'function readState() {',
    '  try {',
    "    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));",
    '  } catch {',
    "    return { headBranch: 'unknown', baseBranch: 'unknown' };",
    '  }',
    '}',
    `const PR_ID = ${JSON.stringify(prId)};`,
    "const PR_URL = 'https://dev.azure.com/stub-org/stub-project/_git/stub-repo/pullrequest/' + PR_ID;",
    "if (argv[0] === '--version') {",
    "  process.stdout.write('azure-cli                         2.60.0-stub\\n');",
    "} else if (joined.startsWith('extension show')) {",
    "  out({ name: 'azure-devops', version: '1.0.1-stub' });",
    "} else if (joined.startsWith('devops configure')) {",
    "  out({ organization: 'https://dev.azure.com/stub-org', project: 'stub-project' });",
    "} else if (joined.startsWith('repos pr create')) {",
    "  const headBranch = flagValue('--source-branch');",
    "  const baseBranch = flagValue('--target-branch');",
    '  fs.writeFileSync(STATE_FILE, JSON.stringify({ headBranch, baseBranch }));',
    "  out([PR_ID, PR_URL, 'active', 'refs/heads/' + headBranch, 'refs/heads/' + baseBranch]);",
    "} else if (joined.startsWith('repos pr show')) {",
    "  const id = flagValue('--id');",
    '  const state = readState();',
    "  out([id, PR_URL, 'active', 'refs/heads/' + state.headBranch, 'refs/heads/' + state.baseBranch]);",
    "} else if (joined.startsWith('repos pr update')) {",
    "  const id = flagValue('--id');",
    "  out([id, 'completed']);",
    "} else if (joined.startsWith('repos pr work-item add')) {",
    "  const id = flagValue('--id');",
    "  const workItems = flagValue('--work-items');",
    "  process.stdout.write('Linked pull request ' + id + ' to work item(s): ' + workItems + '\\n');",
    "} else if (joined.startsWith('repos pr list')) {",
    '  out([]);',
    '} else {',
    "  process.stderr.write('stub az: unrecognized argv ' + JSON.stringify(argv) + '\\n');",
    '  process.exit(1);',
    '}',
    ''
  ].join('\n');
}

/**
 * Write an executable `az` stub script into `binDir` (created if missing).
 * @param {string} binDir absolute path, expected to live under `os.tmpdir()`
 * @param {{prId?: string}} [opts]
 * @returns {string} `binDir`
 */
function installHostAzureDevOpsStub(binDir, opts) {
  fs.mkdirSync(binDir, { recursive: true });
  const azPath = path.join(binDir, 'az');
  fs.writeFileSync(azPath, azStubSource(opts), { mode: 0o755 });
  fs.chmodSync(azPath, 0o755);
  return binDir;
}

module.exports = { azStubSource, installHostAzureDevOpsStub };
