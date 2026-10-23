'use strict';

/**
 * Scripted tracker-swap scenario (TRD-2026-8d825f54 TRD-034, bead br-0g5b, PRD AC-015-2,
 * AC-016-1, AC-016-4). Proves, through REAL subprocess entry points against the REAL,
 * un-copied `packages/development/lib/toolchain-cli.js` / `trd-cli.js` /
 * `complexity-analyzer.js`, that an operator can select the Jira Cloud or Azure Boards tracker
 * adapter by configuration alone and run scaffold/claim/update/close with the default `br`/`bv`
 * tool not installed anywhere on `PATH`.
 *
 * Seven coverage areas (1:1 with the wave orchestrator's assignment):
 *   1. AC1 -- full create/claim/update/close lifecycle through each alternative adapter, on a
 *      PATH with no `br`/`bv` at all; the ledger lists exactly four side effects.
 *   2. AC2 -- `toolchain-cli validate` (TRD-007's composed conformance gate) over both real
 *      manifest directories.
 *   3. AC3 -- `beads-build-wave.yaml`'s documented claim-step argv, both as a static raw-text
 *      assertion and as a dynamic, verbatim reproduction against Azure Boards.
 *   4. Zero-br/bv-invocation proof with STUB br/bv binaries actually present and reachable on
 *      PATH (stronger than AC1's "no br/bv anywhere"), plus a `tracker: beads` control run that
 *      proves the SAME bin dir's br/bv stubs DO get invoked once the default adapter is
 *      selected.
 *   5. Missing-binary negative case: preflight fails `HEALTH_FAILED` naming the configured
 *      adapter, never a silent fallback to `beads`.
 *   6. Swap-consistency: `trd-cli bead-context`, `complexity-analyzer` and `trd-cli beads-label`
 *      all route through whichever adapter is configured, for both alternatives.
 *   7. Mutation proof: a hardcoded-to-`beads` mutant of `toolchain-cli.js`'s `run` subcommand
 *      either fails to resolve at all, or -- when a `br` stub is reachable -- visibly redirects
 *      a `tracker.create` call to it, while the real, unmutated CLI still routes to the
 *      configured alternative adapter.
 *
 * Findings (documented, not fixed -- see the matching inline comment near each one below):
 *   - TRD-034's own Implementation AC 2 names a `toolchain-cli validate --conformance tracker`
 *     flag that does not exist anywhere in this codebase; the real mechanism is a bare
 *     `validate <adapter-dir> --json`, which composes TRD-007's conformance check internally
 *     (`validateAdapterDir`). See the AC2 block below.
 *   - The `tracker.update` category contract's single `fields` input is interpreted
 *     differently per adapter (jira: literal status string via `--status`; azure-boards:
 *     literal state string via `--state`; beads: free-form notes via `--notes`).
 *     `beads-build-wave.yaml`'s own literal claim-step argv (`--arg
 *     fields={"status":"in_progress"}`) is shaped for the BEADS adapter's free-form
 *     interpretation and is not a valid Jira/Azure status/state name when routed through
 *     those adapters -- a pre-existing TRD-032/033 design gap, out of TRD-034's scope. See the
 *     AC3 block below.
 *   - `tracker.label`/`tracker.sync`/`tracker.dep-remove`/`tracker.stage-export` have no
 *     jira/azure-boards implementation (`required:false`). Only `tracker.stage-export` (and
 *     the `work-graph.*` capabilities) actually declare a category-contract `fallback` field;
 *     empirically verified (see the AC6 block below) that `tracker.label`/`tracker.sync`/
 *     `tracker.dep-remove` declare NO fallback, so calling them returns `NOT_ALLOWED`, not the
 *     `UNAVAILABLE`-with-documented-fallback envelope.
 *   - The full `beads-build-wave.yaml` preflight (`--require tracker.sync --require
 *     work-graph.ready` among others) would fail `HEALTH_FAILED`/`UNAVAILABLE` against either
 *     alternative tracker today, since neither implements `tracker.sync` or any `work-graph.*`
 *     capability -- TRD-034 only proves the claim-step argv routes correctly, not that the
 *     full wave preflight passes end to end against an alternative tracker.
 *   - `beads-build-wave.yaml`/`implement-trd-beads.yaml` are agent-orchestration prose read by
 *     an LLM, not an executable entry point a test can spawn directly -- AC3's "reaches its
 *     tracker step" is proven via a static raw-text assertion (the literal documented argv is
 *     present) plus a dynamic reproduction of that same literal argv as a real subprocess call.
 *
 * Independent review is deferred to the PR 8 gate (no reviewer agent runs on this bead).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

jest.setTimeout(30000);

const REPO_ROOT = path.join(__dirname, '..', '..');
const DEV_LIB = path.join(REPO_ROOT, 'packages', 'development', 'lib');
const TOOLCHAIN_CLI = path.join(DEV_LIB, 'toolchain-cli.js');
const TRD_CLI = path.join(DEV_LIB, 'trd-cli.js');
const COMPLEXITY_ANALYZER = path.join(DEV_LIB, 'complexity-analyzer.js');
const JIRA_ADAPTER_DIR = path.join(REPO_ROOT, 'packages', 'infrastructure', 'skills', 'adapter-tracker-jira');
const AZURE_ADAPTER_DIR = path.join(REPO_ROOT, 'packages', 'infrastructure', 'skills', 'adapter-tracker-azure-boards');
const BEADS_WAVE_YAML = path.join(REPO_ROOT, 'packages', 'development', 'commands', 'beads-build-wave.yaml');

const SLUG = 'trd-2026-tracker-swap-demo';

/** Minimal, parseable TRD fixture -- one INFRA task, no PRD requirements -- mirroring the
 * established fixture shape `packages/development/tests/trd-cli-adapter-swap.test.js` uses,
 * since there is no shared canonical TRD fixture file in this repo (confirmed: every sibling
 * test inlines its own TRD_TEXT). */
const TRD_TEXT = `# Demo TRD

Summary.

## Master Task List

### PR 1: First

**Shippable State:** Works.

- [ ] **TRD-002** Wire CI (1h) \`[satisfies INFRA]\`
  - Target File: ci.yml
`;

// ---------------------------------------------------------------------------
// Generic fixture / subprocess helpers (mirroring trd-cli-adapter-swap.test.js's own
// buildPath/run/readCalls conventions).
// ---------------------------------------------------------------------------

/** Fresh throwaway `/tmp` directory, symlink-resolved so later path comparisons never trip on
 * macOS's `/tmp` -> `/private/tmp` symlink. */
function mkThrowawayProjectRoot(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeToolchainConfig(dir, tracker) {
  fs.mkdirSync(path.join(dir, '.ensemble'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.ensemble', 'toolchain.yaml'), `tracker: ${tracker}\n`);
}

function writeTrdFixture(dir) {
  fs.mkdirSync(path.join(dir, 'docs', 'TRD'), { recursive: true });
  const trdPath = path.join(dir, 'docs', 'TRD', `${SLUG}.md`);
  fs.writeFileSync(trdPath, TRD_TEXT);
  return trdPath;
}

/** A fresh throwaway project root: `.ensemble/toolchain.yaml` selecting `tracker`, the TRD
 * fixture under `docs/TRD/`, and an empty `bin/` dir ready for stub binaries. Adapter manifests
 * themselves are never written here -- the REAL `packages/infrastructure/skills/adapter-
 * tracker-{jira,azure-boards}` / `packages/development/skills/adapter-tracker-beads`
 * directories resolve automatically through the library-relative installed-tier search
 * (`packages/development/lib/toolchain/adapters.js`), as long as the REAL, un-copied
 * toolchain-cli.js/trd-cli.js run the subprocess. */
function mkTrackerProject(prefix, tracker) {
  const dir = mkThrowawayProjectRoot(prefix);
  writeToolchainConfig(dir, tracker);
  const trdPath = writeTrdFixture(dir);
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  return { dir, binDir, trdPath };
}

/** `PATH` containing ONLY the fixture bin dir, node's own dir (so `node <cli>` itself still
 * resolves) and `/usr/bin:/bin` (core POSIX utilities `git`/`which` may need) -- NEVER the real
 * inherited `process.env.PATH` -- so no real `br`/`bv`/`jira`/`az` anywhere on the host's real
 * PATH can possibly be reached by these subprocesses. */
function buildPath(binDir) {
  return [binDir, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter);
}

function runNode(cliPath, args, cwd, env) {
  const r = spawnSync(process.execPath, [cliPath, ...args], { cwd, env, encoding: 'utf8' });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    // some assertions below only need status/stdout/stderr
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

function readCallsLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function installBinary(binDir, binName, source) {
  fs.mkdirSync(binDir, { recursive: true });
  const binPath = path.join(binDir, binName);
  fs.writeFileSync(binPath, source, { mode: 0o755 });
  fs.chmodSync(binPath, 0o755);
}

// ---------------------------------------------------------------------------
// Stub executable sources. Each appends every argv it receives (one JSON line) to its own
// `calls-<bin>.log` in the same bin dir, then answers a small set of recognized argv shapes
// (derived directly from the REAL adapter manifests' own `run[]`/`health[]` templates, read
// verbatim while researching this task); any unrecognized argv fails loudly (stderr + exit 1)
// rather than silently succeeding, so a routing mistake in the production code under test
// surfaces as a real subprocess failure, not a passed assertion on the wrong data.
// ---------------------------------------------------------------------------

function jiraStubSource({ showResponses = {}, listResponse = [], createdId = 'JIRA-100' } = {}) {
  return [
    '#!/usr/bin/env node',
    "'use strict';",
    "const fs = require('fs');",
    "const path = require('path');",
    'const argv = process.argv.slice(2);',
    "fs.appendFileSync(path.join(__dirname, 'calls-jira.log'), JSON.stringify(argv) + '\\n');",
    'function out(value) { process.stdout.write(JSON.stringify(value)); }',
    "function flagValue(name) { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; }",
    `const SHOW = ${JSON.stringify(showResponses)};`,
    `const LIST = ${JSON.stringify(listResponse)};`,
    "if (argv[0] === '--version') {",
    "  process.stdout.write('jira stub 1.0.0\\n');",
    "} else if (argv[0] === 'issues' && argv[1] === 'read') {",
    '  const id = argv[2];',
    '  const resp = SHOW[id];',
    "  if (!resp) { process.stderr.write('stub jira: unknown issue ' + id + '\\n'); process.exit(1); }",
    '  out(resp);',
    "} else if (argv[0] === 'issues' && argv[1] === 'list') {",
    '  out(LIST);',
    "} else if (argv[0] === 'issues' && argv[1] === 'create') {",
    `  out({ key: ${JSON.stringify(createdId)}, summary: argv[2] });`,
    "} else if (argv[0] === 'issues' && argv[1] === 'update') {",
    '  const id = argv[2];',
    "  const status = flagValue('--status');",
    '  out({ key: id, status: status });',
    '} else {',
    "  process.stderr.write('stub jira: unrecognized argv ' + JSON.stringify(argv) + '\\n');",
    '  process.exit(1);',
    '}',
    '',
  ].join('\n');
}

function azStubSource({ showResponses = {}, createdId = '4200' } = {}) {
  return [
    '#!/usr/bin/env node',
    "'use strict';",
    "const fs = require('fs');",
    "const path = require('path');",
    'const argv = process.argv.slice(2);',
    "fs.appendFileSync(path.join(__dirname, 'calls-az.log'), JSON.stringify(argv) + '\\n');",
    'function out(value) { process.stdout.write(JSON.stringify(value)); }',
    "function flagValue(name) { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; }",
    `const SHOW = ${JSON.stringify(showResponses)};`,
    "if (argv[0] === '--version') {",
    "  process.stdout.write('azure-cli stub 2.0.0\\n');",
    "} else if (argv[0] === 'extension' && argv[1] === 'show') {",
    "  out({ name: 'azure-devops', version: '1.0.0' });",
    "} else if (argv[0] === 'devops' && argv[1] === 'configure') {",
    "  out({ organization: 'https://dev.azure.com/stub', project: 'stub-project' });",
    "} else if (argv[0] === 'boards' && argv[1] === 'query') {",
    '  out([]);',
    "} else if (argv[0] === 'boards' && argv[1] === 'work-item' && argv[2] === 'show') {",
    "  const id = flagValue('--id');",
    '  const resp = SHOW[id];',
    "  if (!resp) { process.stderr.write('stub az: unknown work item ' + id + '\\n'); process.exit(1); }",
    '  out(resp);',
    "} else if (argv[0] === 'boards' && argv[1] === 'work-item' && argv[2] === 'create') {",
    `  out(${JSON.stringify(createdId)});`,
    "} else if (argv[0] === 'boards' && argv[1] === 'work-item' && argv[2] === 'update') {",
    "  const id = flagValue('--id');",
    "  const state = flagValue('--state');",
    "  const query = flagValue('--query') || '';",
    "  if (query.trim().indexOf('[') === 0) {",
    '    out([id, state]);',
    '  } else {',
    '    out(id);',
    '  }',
    '} else {',
    "  process.stderr.write('stub az: unrecognized argv ' + JSON.stringify(argv) + '\\n');",
    '  process.exit(1);',
    '}',
    '',
  ].join('\n');
}

function brStubSource({ createdId = 'BR-100' } = {}) {
  return [
    '#!/usr/bin/env node',
    "'use strict';",
    "const fs = require('fs');",
    "const path = require('path');",
    'const argv = process.argv.slice(2);',
    "fs.appendFileSync(path.join(__dirname, 'calls-br.log'), JSON.stringify(argv) + '\\n');",
    'function out(value) { process.stdout.write(JSON.stringify(value)); }',
    "if (argv[0] === '--version') {",
    "  process.stdout.write('br stub 1.0.0\\n');",
    "} else if (argv[0] === 'create') {",
    `  out([{ id: ${JSON.stringify(createdId)} }]);`,
    "} else if (argv[0] === 'update') {",
    '  out([{ id: argv[1] }]);',
    "} else if (argv[0] === 'close') {",
    "  out([{ id: argv[1], status: 'closed' }]);",
    '} else {',
    "  process.stderr.write('stub br: unrecognized argv ' + JSON.stringify(argv) + '\\n');",
    '  process.exit(1);',
    '}',
    '',
  ].join('\n');
}

function bvStubSource() {
  return [
    '#!/usr/bin/env node',
    "'use strict';",
    "const fs = require('fs');",
    "const path = require('path');",
    'const argv = process.argv.slice(2);',
    "fs.appendFileSync(path.join(__dirname, 'calls-bv.log'), JSON.stringify(argv) + '\\n');",
    "if (argv[0] === '--version') {",
    "  process.stdout.write('bv stub 1.0.0\\n');",
    '} else {',
    "  process.stderr.write('stub bv: unrecognized argv ' + JSON.stringify(argv) + '\\n');",
    '  process.exit(1);',
    '}',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Fixture data: a `## References` block (bead-context's own expected shape) plus `tracker.show`
// / `tracker.list` response builders, one per adapter's own real parse/map shape.
// ---------------------------------------------------------------------------

function referencesBlock(taskAnchor) {
  return ['## References', `TRD: docs/TRD/${SLUG}.md`, `TRD Task: docs/TRD/${SLUG}.md#${taskAnchor}`].join('\n');
}

/** jira's `tracker.show` parse map: a flat object keyed `.key`/`.summary`/`.description`/
 * `.issueType`/`.status`/`.priority`/`.labels` (adapter-tracker-jira/adapter.yaml). */
function jiraShowResponse(id) {
  return {
    key: id,
    summary: `${id} fixture bead`,
    description: referencesBlock('trd-002'),
    issueType: 'Task',
    status: 'To Do',
    priority: '2',
    labels: [],
  };
}

/** azure-boards' `tracker.show` parse map: a bare 7-element array `[id, title, description,
 * type, status, priority, relations]` (adapter-tracker-azure-boards/adapter.yaml). */
function azShowResponse(id) {
  return [id, `${id} fixture bead`, referencesBlock('trd-002'), 'Task', 'New', '2', []];
}

/** `tracker.list` fixture: three beads in this TRD's scope (one of each status, one already
 * labeled `demo`) and one foreign bead outside scope -- mirrors the established
 * trd-cli-adapter-swap.test.js convention. */
function jiraListResponse() {
  return [
    { id: 'b-1', title: `[trd:${SLUG}:task:TRD-001] one`, status: 'open', labels: [] },
    { id: 'b-2', title: `[trd:${SLUG}:task:TRD-002] two`, status: 'closed', labels: ['demo'] },
    { id: 'b-3', title: `[trd:${SLUG}:task:TRD-003] three`, status: 'in_progress', labels: [] },
    { id: 'b-4', title: '[trd:other-slug] foreign', status: 'open', labels: [] },
  ];
}

// ---------------------------------------------------------------------------
// Per-adapter configuration: which binary, which stub builder, which health-check argvs
// (literal, read verbatim off each adapter's own `health:` block) so a "how many REAL
// capability-level calls happened" assertion can exclude preflight's own health-check noise.
// ---------------------------------------------------------------------------

const JIRA_HEALTH_ARGVS = [
  ['--version'],
  ['issues', 'list', '--limit', '1'],
];
const AZ_HEALTH_ARGVS = [
  ['--version'],
  ['extension', 'show', '--name', 'azure-devops'],
  ['devops', 'configure', '--list'],
  ['boards', 'query', '--wiql', 'SELECT [System.Id] FROM WorkItems', '--top', '1'],
];
const BR_HEALTH_ARGVS = [['--version']];
const BV_HEALTH_ARGVS = [['--version']];

function nonHealthCalls(calls, healthArgvs) {
  const healthKeys = new Set(healthArgvs.map((argv) => JSON.stringify(argv)));
  return calls.filter((argv) => !healthKeys.has(JSON.stringify(argv)));
}

const ADAPTERS = {
  jira: {
    id: 'jira',
    binName: 'jira',
    dirPath: JIRA_ADAPTER_DIR,
    healthArgvs: JIRA_HEALTH_ARGVS,
    claimStatus: 'In Progress',
    secondStatus: 'In Review',
    callsLog: (binDir) => path.join(binDir, 'calls-jira.log'),
    installStub: (binDir, opts) => installBinary(binDir, 'jira', jiraStubSource(opts)),
    showShapeMatches: (argv) => argv[0] === 'issues' && argv[1] === 'read',
    showResponseFor: (id) => jiraShowResponse(id),
  },
  'azure-boards': {
    id: 'azure-boards',
    binName: 'az',
    dirPath: AZURE_ADAPTER_DIR,
    healthArgvs: AZ_HEALTH_ARGVS,
    claimStatus: 'Active',
    secondStatus: 'New',
    callsLog: (binDir) => path.join(binDir, 'calls-az.log'),
    installStub: (binDir, opts) => installBinary(binDir, 'az', azStubSource(opts)),
    showShapeMatches: (argv) => argv[0] === 'boards' && argv[1] === 'work-item' && argv[2] === 'show',
    showResponseFor: (id) => azShowResponse(id),
  },
};
const ADAPTER_KEYS = Object.keys(ADAPTERS);

/** Confirm `br`/`bv` are not resolvable at all under `PATH` (same `which`-based check
 * trd-cli-adapter-swap.test.js uses). */
function expectNoBrBvOnPath(PATH) {
  const whichBr = spawnSync('which', ['br'], { env: { PATH }, encoding: 'utf8' });
  expect(whichBr.status).not.toBe(0);
  expect(whichBr.stdout.trim()).toBe('');
  const whichBv = spawnSync('which', ['bv'], { env: { PATH }, encoding: 'utf8' });
  expect(whichBv.status).not.toBe(0);
  expect(whichBv.stdout.trim()).toBe('');
}

/**
 * Full create -> claim -> update -> close lifecycle through `toolchain-cli.js run`/`trd-cli.js
 * scaffold-plan`, against whichever adapter `project`'s `.ensemble/toolchain.yaml` selects.
 *
 * `--non-interactive` is passed on every side-effecting `run` call: `tracker.create`/`update`/
 * `close` are all `sideEffect:true` in the `tracker` category contract, so `toolchain-cli.js
 * run`'s own confirmation gate (`./toolchain/confirm.js#confirmStatus`) requires an EXPLICIT
 * non-interactive signal (`--non-interactive`, `ENSEMBLE_NON_INTERACTIVE=1`, a non-empty
 * `FOREMAN_TASK_TITLE`, or `CI=true`) before a resolved adapter is even considered confirmed;
 * this scenario's constructed `env` carries none of the other three, so without this flag
 * every one of these calls would fail `CONFIRMATION_REQUIRED` rather than exercising routing at
 * all. This mirrors `beads-build-wave.yaml`'s OWN documented claim-step argv (TRD-034's cited
 * research), which appends exactly this flag "when FOREMAN is true" -- the production shape
 * for a non-interactive, automated caller, which this scripted scenario always is.
 */
function runLifecycle(adapterKey, project, PATH) {
  const cfg = ADAPTERS[adapterKey];

  const preflight = runNode(
    TOOLCHAIN_CLI,
    ['preflight', '--require', 'tracker.create', '--require', 'tracker.update', '--require', 'tracker.close', '--json'],
    project.dir,
    { PATH }
  );
  const runId = preflight.json && preflight.json.runId;

  const scaffold = runNode(TRD_CLI, ['scaffold-plan', project.trdPath], project.dir, { PATH });
  const task = scaffold.json && scaffold.json.ok ? scaffold.json.plan.tasks[0] : null;

  const create = runNode(
    TOOLCHAIN_CLI,
    [
      'run',
      'tracker.create',
      '--run-id',
      runId,
      '--arg',
      `title=${task && task.title}`,
      '--arg',
      `type=${task && task.type}`,
      '--arg',
      `description=${task && task.description}`,
      '--json',
      '--non-interactive',
    ],
    project.dir,
    { PATH }
  );
  const beadId = create.json && create.json.ok ? create.json.data.id : null;

  const claim = runNode(
    TOOLCHAIN_CLI,
    ['run', 'tracker.update', '--run-id', runId, '--arg', `id=${beadId}`, '--arg', `fields=${cfg.claimStatus}`, '--json', '--non-interactive'],
    project.dir,
    { PATH }
  );

  const update = runNode(
    TOOLCHAIN_CLI,
    ['run', 'tracker.update', '--run-id', runId, '--arg', `id=${beadId}`, '--arg', `fields=${cfg.secondStatus}`, '--json', '--non-interactive'],
    project.dir,
    { PATH }
  );

  const close = runNode(
    TOOLCHAIN_CLI,
    ['run', 'tracker.close', '--run-id', runId, '--arg', `id=${beadId}`, '--json', '--non-interactive'],
    project.dir,
    { PATH }
  );

  return { preflight, runId, scaffold, task, create, beadId, claim, update, close };
}

// ---------------------------------------------------------------------------
// 1. AC1 -- full lifecycle through each alternative adapter, no br/bv on PATH at all.
// ---------------------------------------------------------------------------

describe('AC1: full scaffold/claim/update/close lifecycle through each alternative adapter (no br/bv on PATH)', () => {
  test.each(ADAPTER_KEYS)('%s: every step exits 0, the ledger lists exactly 4 side effects, br/bv are unreachable', (adapterKey) => {
    const cfg = ADAPTERS[adapterKey];
    const project = mkTrackerProject(`ac1-${adapterKey}-`, adapterKey);
    cfg.installStub(project.binDir, {});
    const PATH = buildPath(project.binDir);

    const lifecycle = runLifecycle(adapterKey, project, PATH);

    expect(lifecycle.preflight.status).toBe(0);
    expect(lifecycle.preflight.json.ok).toBe(true);
    expect(typeof lifecycle.runId).toBe('string');

    expect(lifecycle.scaffold.status).toBe(0);
    expect(lifecycle.scaffold.json.ok).toBe(true);
    expect(lifecycle.task).toBeTruthy();
    expect(lifecycle.task.type).toBe('task');

    expect(lifecycle.create.status).toBe(0);
    expect(lifecycle.create.json.ok).toBe(true);
    expect(typeof lifecycle.beadId).toBe('string');
    expect(lifecycle.beadId.length).toBeGreaterThan(0);

    expect(lifecycle.claim.status).toBe(0);
    expect(lifecycle.claim.json.ok).toBe(true);

    expect(lifecycle.update.status).toBe(0);
    expect(lifecycle.update.json.ok).toBe(true);

    expect(lifecycle.close.status).toBe(0);
    expect(lifecycle.close.json.ok).toBe(true);
    expect(lifecycle.close.json.data.status).toBe('closed');

    // Ledger: read directly off disk, never through a CLI re-query.
    const ledgerPath = path.join(project.dir, '.ensemble', 'state', 'toolchain', `ledger-${lifecycle.runId}.jsonl`);
    const ledgerLines = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean);
    expect(ledgerLines.length).toBe(4);
    const ledgerEntries = ledgerLines.map((line) => JSON.parse(line));
    expect(ledgerEntries.map((entry) => entry.capability)).toEqual([
      'tracker.create',
      'tracker.update',
      'tracker.update',
      'tracker.close',
    ]);
    for (const entry of ledgerEntries) {
      expect(entry.adapter).toBe(cfg.id);
      expect(typeof entry.timestamp).toBe('string');
    }

    expectNoBrBvOnPath(PATH);
  });
});

// ---------------------------------------------------------------------------
// 2. AC2 -- conformance (toolchain-cli validate) over both alternative manifests.
//
// FINDING: TRD-034's own Implementation AC 2 names `toolchain-cli validate --conformance
// tracker`; no such flag exists anywhere in toolchain-cli.js's parseArgs/HANDLERS (confirmed
// by reading the whole file). The real mechanism is a bare `validate <adapter-dir> --json`,
// which composes validateManifest + validateAllowlist + validateConformance (TRD-007) +
// scanCredentials internally via `validateAdapterDir` -- this IS the "conformance run (TRD-007
// validator)" TRD-034's own prose describes, just not through a literal `--conformance` flag.
// This mirrors scripts/tests/toolchain-adapter-tracker-azure-boards-manifest.test.js:83-95
// exactly.
// ---------------------------------------------------------------------------

describe('AC2: conformance -- toolchain-cli validate over both alternative tracker manifests', () => {
  test.each([
    ['jira', JIRA_ADAPTER_DIR],
    ['azure-boards', AZURE_ADAPTER_DIR],
  ])('%s adapter directory validates clean via a real subprocess', (name, dir) => {
    const jsonProc = spawnSync(process.execPath, [TOOLCHAIN_CLI, 'validate', dir, '--json'], { encoding: 'utf8' });
    expect(jsonProc.status).toBe(0);
    expect(JSON.parse(jsonProc.stdout.trim())).toEqual({ ok: true, errors: [] });

    const textProc = spawnSync(process.execPath, [TOOLCHAIN_CLI, 'validate', dir], { encoding: 'utf8' });
    expect(textProc.status).toBe(0);
    expect(textProc.stdout.trim()).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// 3. AC3 -- beads-build-wave's claim-step reaches the Azure Boards adapter.
// ---------------------------------------------------------------------------

describe('AC3: beads-build-wave.yaml claim-step reaches the Azure Boards adapter', () => {
  test('(a) static: the lifecycle_contract literally documents the tracker.update claim argv', () => {
    // beads-build-wave.yaml is agent-orchestration prose read by an LLM, not an executable
    // entry point this test can spawn directly (see this file's header finding list) -- this
    // raw-text assertion mirrors the idiom packages/development/tests/implement-trd-beads-
    // command.test.js already uses for the same family of command YAML files (e.g. its
    // "--foreman tags only task beads..." test, around lines 185-189).
    const text = fs.readFileSync(BEADS_WAVE_YAML, 'utf8');
    expect(text).toContain('tracker.update --run-id <RUN_ID> --arg id=<BEAD_ID> --arg fields={"status":"in_progress"}');
  });

  test('(b) dynamic: the literal documented claim argv routes to `az boards work-item update`, not br, when Azure Boards is selected', () => {
    const cfg = ADAPTERS['azure-boards'];
    const project = mkTrackerProject('ac3-azure-', 'azure-boards');
    cfg.installStub(project.binDir, {});
    const PATH = buildPath(project.binDir);

    const preflight = runNode(
      TOOLCHAIN_CLI,
      ['preflight', '--require', 'tracker.create', '--require', 'tracker.update', '--json'],
      project.dir,
      { PATH }
    );
    expect(preflight.status).toBe(0);
    const runId = preflight.json.runId;

    const scaffold = runNode(TRD_CLI, ['scaffold-plan', project.trdPath], project.dir, { PATH });
    expect(scaffold.status).toBe(0);
    const task = scaffold.json.plan.tasks[0];

    const create = runNode(
      TOOLCHAIN_CLI,
      [
        'run',
        'tracker.create',
        '--run-id',
        runId,
        '--arg',
        `title=${task.title}`,
        '--arg',
        `type=${task.type}`,
        '--arg',
        `description=${task.description}`,
        '--json',
        '--non-interactive',
      ],
      project.dir,
      { PATH }
    );
    expect(create.status).toBe(0);
    const beadId = create.json.data.id;

    // The LITERAL argv beads-build-wave.yaml documents for its claim step, verbatim, plus
    // --non-interactive (see runLifecycle's own header comment for why this flag is required).
    const claim = runNode(
      TOOLCHAIN_CLI,
      ['run', 'tracker.update', '--run-id', runId, '--arg', `id=${beadId}`, '--arg', 'fields={"status":"in_progress"}', '--json', '--non-interactive'],
      project.dir,
      { PATH }
    );
    expect(claim.status).toBe(0);
    expect(claim.json.ok).toBe(true);

    const calls = readCallsLog(cfg.callsLog(project.binDir));
    const claimCall = calls.find(
      (argv) => argv[0] === 'boards' && argv[1] === 'work-item' && argv[2] === 'update' && argv[3] === '--id' && argv[4] === beadId
    );
    expect(claimCall).toBeTruthy();
    // FINDING (pre-existing TRD-032/033 cross-adapter semantic gap, not a bug this test should
    // paper over): the claim-step argv is shaped for the BEADS adapter's own free-form
    // "fields as notes" interpretation; routed through azure-boards, the literal JSON text
    // `{"status":"in_progress"}` lands VERBATIM as the `--state` value -- this is not real
    // Azure Boards state vocabulary (New/Active/Closed). This assertion proves the ROUTING
    // (the argv shape reaching `az boards work-item update`), not that the value itself is
    // semantically valid Azure state -- `tracker.update`'s parse block maps only a bare `id`
    // scalar (no statusMap), so the runner never validates this value at all.
    expect(claimCall.slice(0, 7)).toEqual([
      'boards',
      'work-item',
      'update',
      '--id',
      beadId,
      '--state',
      '{"status":"in_progress"}',
    ]);

    expectNoBrBvOnPath(PATH);
  });
});

// ---------------------------------------------------------------------------
// 4. Zero-br/bv-invocation proof WITH stub br/bv present and reachable (stronger than AC1's
//    "no br/bv anywhere"), plus a `tracker: beads` control run proving the same bin dir's
//    br/bv stubs DO get invoked once the default adapter is selected.
// ---------------------------------------------------------------------------

describe('Mandate 4: zero br/bv invocation while stub br/bv ARE reachable on PATH; a tracker: beads control run DOES invoke them', () => {
  test.each(ADAPTER_KEYS)('%s: the lifecycle never touches br/bv; switching to tracker: beads (control) does', (adapterKey) => {
    const cfg = ADAPTERS[adapterKey];
    const project = mkTrackerProject(`ac4-${adapterKey}-`, adapterKey);
    cfg.installStub(project.binDir, {});
    installBinary(project.binDir, 'br', brStubSource({}));
    installBinary(project.binDir, 'bv', bvStubSource());
    const PATH = buildPath(project.binDir);

    const brLog = path.join(project.binDir, 'calls-br.log');
    const bvLog = path.join(project.binDir, 'calls-bv.log');

    // --- Phase 1: the alternative-tracker lifecycle (same shape as AC1) ---
    const lifecycle = runLifecycle(adapterKey, project, PATH);
    expect(lifecycle.create.json.ok).toBe(true);
    expect(lifecycle.claim.json.ok).toBe(true);
    expect(lifecycle.update.json.ok).toBe(true);
    expect(lifecycle.close.json.ok).toBe(true);

    const adapterCallsPhase1 = nonHealthCalls(readCallsLog(cfg.callsLog(project.binDir)), cfg.healthArgvs);
    expect(adapterCallsPhase1.length).toBe(4);
    expect(readCallsLog(brLog)).toEqual([]);
    expect(readCallsLog(bvLog)).toEqual([]);

    // --- Phase 2 (control): the SAME bin dir, switched to the default `beads` adapter ---
    writeToolchainConfig(project.dir, 'beads');
    const preflight2 = runNode(
      TOOLCHAIN_CLI,
      ['preflight', '--require', 'tracker.create', '--require', 'tracker.update', '--require', 'tracker.close', '--json'],
      project.dir,
      { PATH }
    );
    expect(preflight2.status).toBe(0);
    expect(preflight2.json.ok).toBe(true);
    const runId2 = preflight2.json.runId;

    const create2 = runNode(
      TOOLCHAIN_CLI,
      ['run', 'tracker.create', '--run-id', runId2, '--arg', 'title=control bead', '--arg', 'type=task', '--arg', 'description=control description', '--json', '--non-interactive'],
      project.dir,
      { PATH }
    );
    expect(create2.status).toBe(0);
    expect(create2.json.ok).toBe(true);
    const beadId2 = create2.json.data.id;

    const claim2 = runNode(
      TOOLCHAIN_CLI,
      ['run', 'tracker.update', '--run-id', runId2, '--arg', `id=${beadId2}`, '--arg', 'fields={"status":"in_progress"}', '--json', '--non-interactive'],
      project.dir,
      { PATH }
    );
    expect(claim2.status).toBe(0);
    expect(claim2.json.ok).toBe(true);

    const update2 = runNode(
      TOOLCHAIN_CLI,
      ['run', 'tracker.update', '--run-id', runId2, '--arg', `id=${beadId2}`, '--arg', 'fields={"status":"updated"}', '--json', '--non-interactive'],
      project.dir,
      { PATH }
    );
    expect(update2.status).toBe(0);
    expect(update2.json.ok).toBe(true);

    const close2 = runNode(
      TOOLCHAIN_CLI,
      ['run', 'tracker.close', '--run-id', runId2, '--arg', `id=${beadId2}`, '--json', '--non-interactive'],
      project.dir,
      { PATH }
    );
    expect(close2.status).toBe(0);
    expect(close2.json.ok).toBe(true);

    // CONTROL proof: br/bv DO now have entries -- exactly 4 real capability calls each
    // *could* carry (create/claim/update/close), modulo br/bv's own role: `br` performs all
    // 4 (create/update/update/close), while `bv` is never a capability target here (its own
    // `bv-version` health check is the only reason it was invoked at all) -- while the jira/az
    // log stays frozen at phase 1's 4 entries. No cross-contamination in either direction.
    expect(readCallsLog(brLog).length).toBeGreaterThan(0);
    expect(readCallsLog(bvLog).length).toBeGreaterThan(0);
    expect(nonHealthCalls(readCallsLog(brLog), BR_HEALTH_ARGVS).length).toBe(4);
    expect(nonHealthCalls(readCallsLog(bvLog), BV_HEALTH_ARGVS).length).toBe(0);
    const adapterCallsPhase2 = nonHealthCalls(readCallsLog(cfg.callsLog(project.binDir)), cfg.healthArgvs);
    expect(adapterCallsPhase2.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 5. Missing-binary negative case: preflight fails HEALTH_FAILED, never a silent fallback.
// ---------------------------------------------------------------------------

describe('AC5: missing-binary negative case -- preflight fails HEALTH_FAILED naming the configured adapter, never a silent fallback to beads', () => {
  test('tracker: jira with an EMPTY bin dir (no jira binary anywhere on PATH)', () => {
    const project = mkTrackerProject('ac5-jira-', 'jira');
    // project.binDir exists (mkTrackerProject always creates it) but is left EMPTY here -- no
    // stub of any kind is written, so `jira` cannot resolve anywhere on the constructed PATH.
    const PATH = buildPath(project.binDir);

    const preflight = runNode(TOOLCHAIN_CLI, ['preflight', '--require', 'tracker.show', '--json'], project.dir, { PATH });
    expect(preflight.status).not.toBe(0);
    expect(preflight.json.ok).toBe(false);
    expect(preflight.json.error.code).toBe('HEALTH_FAILED');
    expect(preflight.json.error.message).toContain('jira');
    expect(preflight.json.error.message).toContain('jira-installed');
    // Not a silent fallback to the shipped default `beads` adapter: the failure names jira's
    // own health check, never beads/br/bv.
    expect(preflight.json.error.message).not.toMatch(/\bbeads\b/);
    expect(preflight.json.error.message).not.toMatch(/\bbr\b/);
    expect(preflight.json.error.message).not.toMatch(/\bbv\b/);
  });
});

// ---------------------------------------------------------------------------
// 6. Swap-consistency: bead-context, complexity-analyzer and beads-label all route through
//    whichever adapter is configured.
// ---------------------------------------------------------------------------

describe('AC6: swap-consistency -- trd-cli bead-context, complexity-analyzer and beads-label', () => {
  test.each(ADAPTER_KEYS)('%s: bead-context and complexity-analyzer both route tracker.show; beads-label fails identically (throws, never a clean ok:false)', (adapterKey) => {
    const cfg = ADAPTERS[adapterKey];
    const project = mkTrackerProject(`ac6-${adapterKey}-`, adapterKey);
    const beadId = 'b-show-1';
    const showResponses = { [beadId]: cfg.showResponseFor(beadId) };
    const listResponse = adapterKey === 'jira' ? jiraListResponse() : [];
    cfg.installStub(project.binDir, { showResponses, listResponse });
    const PATH = buildPath(project.binDir);

    const beadContext = runNode(TRD_CLI, ['bead-context', '--bead', beadId, '--trd', project.trdPath], project.dir, { PATH });
    expect(beadContext.status).toBe(0);
    expect(beadContext.json.ok).toBe(true);

    const analyzer = runNode(COMPLEXITY_ANALYZER, ['analyze', '--bead', beadId, '--json'], project.dir, { PATH });
    expect(analyzer.status).toBe(0);
    expect(analyzer.json.ok).toBe(true);

    const callsAfterReads = readCallsLog(cfg.callsLog(project.binDir));
    const showCalls = callsAfterReads.filter(cfg.showShapeMatches);
    expect(showCalls.length).toBe(2); // bead-context, then complexity-analyzer

    // beads-label: neither jira nor azure-boards implements tracker.label. Empirically
    // verified (direct runCapabilitySync calls against both real manifests while researching
    // this task): tracker.label's category-contract entry
    // (packages/development/toolchain/categories/tracker.yaml) declares NO `fallback` field
    // (unlike tracker.stage-export/work-graph.*, which do) -- so `lookupCapability`
    // (runner.js:858-889) falls through to the plain `NOT_ALLOWED` envelope, never the
    // `UNAVAILABLE`-with-documented-fallback shape. `ensureLabel`
    // (packages/development/lib/beads-label.js:116-128) never catches a failed `run(...)`
    // call -- `raiseOnFailure` (beads-label.js:44-48) always THROWS -- so this surfaces at
    // trd-cli.js's own top-level try/catch (main(), around line 1562) as a bare `{error:
    // <message>}` on stdout with exit 1, never the clean `{ok:false, ...}` envelope a declared-
    // but-unavailable capability might suggest.
    //
    // The two adapters fail at DIFFERENT steps, though: jira's `tracker.list` run template has
    // no argv placeholder at all (`["jira","issues","list"]`), so it succeeds and the failure
    // is reached at the genuine `tracker.label` call (NOT_ALLOWED). azure-boards' `tracker.list`
    // template has an UNFILLED `${filter}` placeholder (`az boards query --wiql ${filter}
    // --output json`), and `ensureLabel`'s default `runBr` always calls `tracker.list` with an
    // EMPTY args object -- so azure-boards fails ONE STEP EARLIER, inside `buildArgv` itself
    // (INVALID_ARG: "'filter': no value supplied and the contract declares no default"),
    // before a `tracker.label` call -- or any real `az` subprocess for this request at all --
    // is ever attempted. Both still surface as the SAME {error, exit 1} shape at the trd-cli.js
    // CLI boundary.
    const label = runNode(TRD_CLI, ['beads-label', '--label', 'demo', '--match', `[trd:${SLUG}`], project.dir, { PATH });
    expect(label.status).toBe(1);
    expect(label.json.ok).toBeUndefined();
    expect(typeof label.json.error).toBe('string');

    const callsAfterLabel = readCallsLog(cfg.callsLog(project.binDir));
    if (adapterKey === 'jira') {
      expect(label.json.error).toContain("capability 'tracker.label' is not declared by adapter 'jira'");
      // tracker.list succeeded (one more real call than before); tracker.label itself never
      // reached a real subprocess (lookupCapability's own `!cap` branch returns an envelope
      // before argv is even built).
      expect(callsAfterLabel.length).toBe(callsAfterReads.length + 1);
      expect(callsAfterLabel[callsAfterLabel.length - 1]).toEqual(['issues', 'list']);
    } else {
      expect(label.json.error).toContain("'filter': no value supplied and the contract declares no default");
      // Failed inside buildArgv, before any `az` subprocess for this request -- no new call.
      expect(callsAfterLabel.length).toBe(callsAfterReads.length);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Mutation proof: hardcoding toolchain-cli.js's `run()` adapter resolution to `beads`
//    either fails to resolve, or -- with a reachable `br` stub -- visibly redirects a
//    tracker.create call to it, while the real, unmutated CLI still routes to the configured
//    alternative adapter. Mirrors packages/development/tests/trd-cli-adapter-swap.test.js:
//    445-484's own mutant-vs-control structure.
// ---------------------------------------------------------------------------

/** Build a fresh `/tmp` copy of `packages/development/lib/` + `packages/development/toolchain/`
 * (the same "copy the whole lib directory" shape
 * packages/development/tests/trd-cli-adapter-swap.test.js#makeTrdCliMutantRoot already
 * establishes) PLUS `packages/development/skills/` -- NOT copied by that established helper,
 * but required here: a mutation that hardcodes the `beads` adapter id must still be able to
 * resolve a REAL `beads` manifest via adapters.js's library-relative installed-tier search,
 * which is rooted at THIS COPY's own `__dirname` (`<root>/packages/development/lib/toolchain`),
 * never the real repo's. A `node_modules` symlink (not a copy) makes `js-yaml`/`ajv` resolve
 * without duplicating the real repo's install. */
function makeToolchainMutantRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-swap-mutant-'));
  const nodeModulesLink = path.join(root, 'node_modules');
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), nodeModulesLink, 'dir');

  const devPkgRoot = path.join(root, 'packages', 'development');
  fs.mkdirSync(devPkgRoot, { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'packages', 'development', 'lib'), path.join(devPkgRoot, 'lib'), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'packages', 'development', 'toolchain'), path.join(devPkgRoot, 'toolchain'), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'packages', 'development', 'skills'), path.join(devPkgRoot, 'skills'), { recursive: true });

  return {
    toolchainCliPath: path.join(devPkgRoot, 'lib', 'toolchain-cli.js'),
    cleanup: () => {
      try {
        fs.rmSync(nodeModulesLink, { force: true });
      } catch {
        // already gone
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Single-replacement, loud-on-miss mutation of an on-disk file (no `require` -- the mutated
 * copy is run as a real subprocess, never loaded in-process), mirroring trd-cli-adapter-
 * swap.test.js's own `mutateFile` exactly. `needle` is deliberately the SHORT 2-line snippet
 * `const resolvedCategory = resolveCategory(category, ctx);\nadapterId =
 * resolvedCategory.value;`, which (confirmed while researching this task) appears THREE times
 * verbatim in toolchain-cli.js -- once each in `run`, `confirmStatus` and `confirmRecord`.
 * `String.prototype.replace(needle, replacement)` only ever rewrites the FIRST occurrence,
 * which is `run`'s own (it is defined earliest in the file) -- `confirmStatus`/`confirmRecord`
 * are untouched, which is irrelevant here since this scenario only ever calls `run`. */
function mutateFile(filePath, needle, replacement) {
  const original = fs.readFileSync(filePath, 'utf8');
  if (!original.includes(needle)) {
    throw new Error(`mutateFile: needle not found in ${filePath}: ${JSON.stringify(needle)}`);
  }
  fs.writeFileSync(filePath, original.replace(needle, replacement));
}

const RUN_RESOLVE_NEEDLE = [
  '      const resolvedCategory = resolveCategory(category, ctx);',
  '      adapterId = resolvedCategory.value;',
].join('\n');
const RUN_RESOLVE_MUTANT = [
  '      const resolvedCategory = resolveCategory(category, ctx);',
  "      adapterId = 'beads';",
].join('\n');

describe('Mandate 7: mutation proof -- toolchain-cli.js run() adapter routing actually discriminates', () => {
  test('hardcoding adapterId to "beads" inside run() redirects tracker.create to the br stub; the unmutated CLI still routes to jira', () => {
    const cfg = ADAPTERS.jira;
    const project = mkTrackerProject('ac7-mutant-', 'jira');
    cfg.installStub(project.binDir, {});
    installBinary(project.binDir, 'br', brStubSource({ createdId: 'BR-MUTANT-1' }));
    installBinary(project.binDir, 'bv', bvStubSource());
    const PATH = buildPath(project.binDir);

    const preflight = runNode(TOOLCHAIN_CLI, ['preflight', '--require', 'tracker.create', '--json'], project.dir, { PATH });
    expect(preflight.status).toBe(0);
    const runId = preflight.json.runId;

    // Control: the REAL, unmutated toolchain-cli.js routes through the configured jira adapter.
    const control = runNode(
      TOOLCHAIN_CLI,
      ['run', 'tracker.create', '--run-id', runId, '--arg', 'title=control task', '--arg', 'type=task', '--arg', 'description=control description', '--json', '--non-interactive'],
      project.dir,
      { PATH }
    );
    expect(control.status).toBe(0);
    expect(control.json.ok).toBe(true);
    expect(control.json.adapter).toBe('jira');

    const jiraLog = cfg.callsLog(project.binDir);
    const brLog = path.join(project.binDir, 'calls-br.log');
    expect(nonHealthCalls(readCallsLog(jiraLog), cfg.healthArgvs).length).toBe(1);
    expect(readCallsLog(brLog)).toEqual([]);

    const mutant = makeToolchainMutantRoot();
    try {
      mutateFile(mutant.toolchainCliPath, RUN_RESOLVE_NEEDLE, RUN_RESOLVE_MUTANT);

      const mutantResult = runNode(
        mutant.toolchainCliPath,
        ['run', 'tracker.create', '--run-id', runId, '--arg', 'title=mutant task', '--arg', 'type=task', '--arg', 'description=mutant description', '--json', '--non-interactive'],
        project.dir,
        { PATH }
      );
      expect(mutantResult.status).toBe(0);
      expect(mutantResult.json.ok).toBe(true);
      // The mutant's own success envelope directly names the contaminated adapter.
      expect(mutantResult.json.adapter).toBe('beads');
      expect(mutantResult.json.data.id).toBe('BR-MUTANT-1');

      expect(readCallsLog(brLog).length).toBe(1);
      // The jira log is untouched by the mutant run -- still exactly the control run's 1 entry.
      expect(nonHealthCalls(readCallsLog(jiraLog), cfg.healthArgvs).length).toBe(1);

      // Control, repeated against the SAME project/run id, after the mutant ran: the real CLI
      // still routes to jira, proving the control behavior above was never a fluke of ordering.
      const realAgain = runNode(
        TOOLCHAIN_CLI,
        ['run', 'tracker.create', '--run-id', runId, '--arg', 'title=control task 2', '--arg', 'type=task', '--arg', 'description=control description 2', '--json', '--non-interactive'],
        project.dir,
        { PATH }
      );
      expect(realAgain.status).toBe(0);
      expect(realAgain.json.ok).toBe(true);
      expect(realAgain.json.adapter).toBe('jira');
      expect(nonHealthCalls(readCallsLog(jiraLog), cfg.healthArgvs).length).toBe(2);
      expect(readCallsLog(brLog).length).toBe(1);
    } finally {
      mutant.cleanup();
    }
  });
});

