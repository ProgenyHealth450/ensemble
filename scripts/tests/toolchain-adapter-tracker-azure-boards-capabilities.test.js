'use strict';
/**
 * Capability-by-capability tests for `packages/infrastructure/skills/adapter-tracker-azure-boards`
 * (TRD-2026-8d825f54 TRD-033/TRD-033-TEST), against the small, deterministic stub `az` script
 * in `scripts/tests/fixtures/toolchain/adapter-tracker-azure-boards-stub.js`. Manifest-level
 * static checks (schema/allowlist/conformance, resolver loadability, mutation-proof guard
 * tests, allowlist-vs-help-fixture cross-check) live in
 * `scripts/tests/toolchain-adapter-tracker-azure-boards-manifest.test.js`; this file exercises
 * every capability's actual `run[]`+`parse` behavior, and proves the `relations[]` ->
 * `dependencies[]` mapping and multi-word-allowlist engine fix are correctly consumed by the
 * REAL, unmodified manifest.
 *
 * No test here spawns a real `az`/`jira`/`br`/`bv`: no `az` binary is installed in this
 * environment at all (see this adapter's own `SKILL.md` "Known limits"); every capability
 * resolves `az` through `PATH`, and every test that reaches a real process prepends a per-test
 * tmpdir containing ONLY the stub script to `process.env.PATH` (saved and restored in
 * `afterEach`).
 */

const fs = require('fs');
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');

const Ajv = require('ajv');

const { loadAdapter } = require('../../packages/development/lib/toolchain/adapters');
const { runCapability } = require('../../packages/development/lib/toolchain/runner');
const { mapOutput } = require('../../packages/development/lib/toolchain/mapping');
const { writeAzureBoardsStub, writeStubControl } = require('./fixtures/toolchain/adapter-tracker-azure-boards-stub');

const REPO_ROOT = path.join(__dirname, '..', '..');
const ADAPTER_DIR = path.join(REPO_ROOT, 'packages', 'infrastructure', 'skills', 'adapter-tracker-azure-boards');
const WORK_ITEM_SCHEMA_PATH = path.join(
  REPO_ROOT,
  'packages',
  'development',
  'toolchain',
  'schemas',
  'normalized',
  'work-item.json'
);
// Synthetic fixture (not a live capture -- see the adapter's own SKILL.md "Known limits" and
// fixtures/README.md).
const WORK_ITEM_SHOW_FIXTURE_PATH = path.join(ADAPTER_DIR, 'fixtures', 'az-work-item-show.sample.json');

const ajv = new Ajv({ allErrors: true });
const validateWorkItem = ajv.compile(JSON.parse(fs.readFileSync(WORK_ITEM_SCHEMA_PATH, 'utf8')));

const { manifest: REAL_MANIFEST } = loadAdapter('azure-boards', { projectRoot: REPO_ROOT });

const tempDirs = [];
let savedPath;

beforeEach(() => {
  savedPath = process.env.PATH;
});

afterEach(() => {
  process.env.PATH = savedPath;
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function mkStubBinDir() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-tracker-azure-boards-bin-')));
  tempDirs.push(dir);
  writeAzureBoardsStub(dir);
  process.env.PATH = `${dir}:${process.env.PATH}`;
  return dir;
}

function withStubEnv(binDir) {
  return { parentEnv: { ...process.env, PATH: `${binDir}:${process.env.PATH}` }, timeoutMs: 10000 };
}

/**
 * By-hand derivation of what the REAL `tracker.show` capability's own `--query` JMESPath
 * expression (`packages/infrastructure/skills/adapter-tracker-azure-boards/adapter.yaml`)
 * would produce from the raw, nested Azure DevOps REST fixture
 * (`fixtures/az-work-item-show.sample.json`) -- no `jmespath` npm package is available in this
 * repo and no real `az` binary exists in this environment to execute the query live, so this
 * flattening is performed manually here, matching the query string verbatim:
 *   `{id: to_string(id), title: fields."System.Title", description: fields."System.Description",
 *     type: fields."System.WorkItemType", status: fields."System.State",
 *     priority: to_string(fields."Microsoft.VSTS.Common.Priority"),
 *     dependencies: relations[?attributes.name=='Predecessor'].{id: url, type: attributes.name} || `[]`}`
 * Filters `relations[]` down to only the `Predecessor`-named entry (excluding the fixture's
 * other, `Child`-named relation), proving the filter is selective, not a passthrough.
 */
function deriveFlattenedShowOutput(rawFixture) {
  return [
    String(rawFixture.id),
    rawFixture.fields['System.Title'],
    rawFixture.fields['System.Description'],
    rawFixture.fields['System.WorkItemType'],
    rawFixture.fields['System.State'],
    String(rawFixture.fields['Microsoft.VSTS.Common.Priority']),
    rawFixture.relations || []
  ];
}

describe('TRD-033-TEST: a recorded az boards work-item show fixture (with a Predecessor relation) normalizes through the REAL manifest parse block (Implementation AC 2)', () => {
  test('the hand-derived --query-flattened fixture, mapped through the real manifest parse.map/arrayMap, validates against work-item.json and isolates the Predecessor relation', () => {
    const rawFixture = JSON.parse(fs.readFileSync(WORK_ITEM_SHOW_FIXTURE_PATH, 'utf8'));
    expect(rawFixture.relations.length).toBeGreaterThan(1); // both Predecessor and Child present
    const flattened = deriveFlattenedShowOutput(rawFixture);

    const mapped = mapOutput(JSON.stringify(flattened), REAL_MANIFEST.capabilities['tracker.show'].parse);

    expect(mapped).toEqual({
      id: '123',
      title: 'Implement login flow',
      description: '<div>Add OAuth2 login flow for the web client.</div>',
      type: 'User Story',
      status: 'in_progress', // fixture's raw "Active" maps through statusMap
      priority: '2',
      dependencies: [
        { id: 'https://dev.azure.com/sunstone-partners/ensemble/_apis/wit/workItems/456', type: 'Predecessor' }
      ]
    });
    expect(validateWorkItem(mapped)).toBe(true);
    // The Child relation must NOT have leaked into dependencies[].
    expect(mapped.dependencies.some((dep) => dep.type === 'Child')).toBe(false);
  });

  test('every statusMap entry (New/Active/Closed) normalizes to the {open,in_progress,closed} enum', () => {
    const rawFixture = JSON.parse(fs.readFileSync(WORK_ITEM_SHOW_FIXTURE_PATH, 'utf8'));
    for (const [raw, normalized] of [
      ['New', 'open'],
      ['Active', 'in_progress'],
      ['Closed', 'closed']
    ]) {
      const flattened = deriveFlattenedShowOutput(rawFixture);
      flattened[4] = raw; // status is the 5th element
      const mapped = mapOutput(JSON.stringify(flattened), REAL_MANIFEST.capabilities['tracker.show'].parse);
      expect(mapped.status).toBe(normalized);
      expect(validateWorkItem(mapped)).toBe(true);
    }
  });

  test('a status value with no statusMap entry (e.g. "Resolved") fails closed with BAD_OUTPUT naming the value', () => {
    const rawFixture = JSON.parse(fs.readFileSync(WORK_ITEM_SHOW_FIXTURE_PATH, 'utf8'));
    const flattened = deriveFlattenedShowOutput(rawFixture);
    flattened[4] = 'Resolved';
    expect(() => mapOutput(JSON.stringify(flattened), REAL_MANIFEST.capabilities['tracker.show'].parse)).toThrow(
      expect.objectContaining({ code: 'BAD_OUTPUT' })
    );
  });

  test('when no relation matches "Predecessor" at all, dependencies[] is an empty array, not null or absent', () => {
    const flattened = ['999', 'No dependencies', 'desc', 'Task', 'New', '2', [{ rel: 'x', url: 'https://x/1', attributes: { name: 'Successor' } }]];
    const mapped = mapOutput(JSON.stringify(flattened), REAL_MANIFEST.capabilities['tracker.show'].parse);
    expect(mapped.dependencies).toEqual([]);
    expect(validateWorkItem(mapped)).toBe(true);
  });

  test('a relation missing "attributes" entirely is excluded, not an error', () => {
    const flattened = ['999', 'Title', 'desc', 'Task', 'New', '2', [{ rel: 'AttachedFile', url: 'https://x/attachment' }]];
    const mapped = mapOutput(JSON.stringify(flattened), REAL_MANIFEST.capabilities['tracker.show'].parse);
    expect(mapped.dependencies).toEqual([]);
    expect(validateWorkItem(mapped)).toBe(true);
  });
});

describe('TRD-033-TEST: tracker.show, real runCapability() against the stub az (proves the real manifest + multi-word allowlist end to end)', () => {
  test('normalizes and validates against work-item.json, including dependencies[] from the stub\'s Predecessor relation', async () => {
    const binDir = mkStubBinDir();
    writeStubControl(binDir, { state: 'Closed' });

    const result = await runCapability(REAL_MANIFEST, 'tracker.show', { id: '9' }, withStubEnv(binDir));
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      id: '9',
      title: 'Stub work item title',
      description: 'Stub work item description',
      type: 'User Story',
      status: 'closed',
      priority: '2',
      dependencies: [{ id: 'https://dev.azure.com/stub-org/stub-project/_apis/wit/workItems/456', type: 'Predecessor' }]
    });
    expect(validateWorkItem(result.data)).toBe(true);
  });

  test('a flag-like id ("-x") is rejected before the tool ever executes (Implementation AC 3)', async () => {
    const binDir = mkStubBinDir();
    const result = await runCapability(REAL_MANIFEST, 'tracker.show', { id: '-x' }, withStubEnv(binDir));
    expect(result.ok).toBe(false);
    expect(['INVALID_ARG', 'NOT_ALLOWED']).toContain(result.error.code);
  });

  test('an error envelope on stdout despite a zero exit fails closed (ok:false, TOOL_FAILED)', async () => {
    const binDir = mkStubBinDir();
    writeStubControl(binDir, { errorEnvelope: true });
    const result = await runCapability(REAL_MANIFEST, 'tracker.show', { id: '9' }, withStubEnv(binDir));
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('TOOL_FAILED');
  });
});

describe('TRD-033-TEST: tracker.update/tracker.close/tracker.comment/tracker.dep-add flag-like ids are also rejected before execution (Implementation AC 3, side-effecting capabilities)', () => {
  test.each([
    ['tracker.update', { id: '-x', fields: 'Active' }],
    ['tracker.close', { id: '-x' }],
    ['tracker.comment', { id: '-x', text: 'a note' }],
    ['tracker.dep-add', { id: '-x', dependsOnId: '456', type: 'Predecessor' }],
    ['tracker.create', { title: '-x', description: 'd', type: 'Task' }]
  ])('%s with a flag-like value fails INVALID_ARG/NOT_ALLOWED, never reaching the stub', async (capability, args) => {
    const binDir = mkStubBinDir();
    const result = await runCapability(REAL_MANIFEST, capability, args, withStubEnv(binDir));
    expect(result.ok).toBe(false);
    expect(['INVALID_ARG', 'NOT_ALLOWED']).toContain(result.error.code);
  });
});

describe('PR8-TEST: tracker.list uses a fixed default WIQL (no filter arg) and declares an arrayMap parse block normalizing to {items:[...]}', () => {
  test('tracker.list with NO filter arg (every real caller in this repo omits it): data is {items: [{id, title, status}]}', async () => {
    const binDir = mkStubBinDir();
    const result = await runCapability(REAL_MANIFEST, 'tracker.list', {}, withStubEnv(binDir));
    expect(result.ok).toBe(true);
    expect(typeof result.data).toBe('object');
    expect(Array.isArray(result.data.items)).toBe(true);
    expect(result.data.items).toHaveLength(2);
    expect(result.data.items[0]).toEqual({ id: '1', title: 'Stub item one', status: 'New' });
    expect(result.data.items[1]).toEqual({ id: '2', title: 'Stub item two', status: 'Active' });
  });

  test('tracker.list: an error envelope on stdout despite a zero exit fails closed (TOOL_FAILED)', async () => {
    const binDir = mkStubBinDir();
    writeStubControl(binDir, { errorEnvelope: true });
    const result = await runCapability(REAL_MANIFEST, 'tracker.list', {}, withStubEnv(binDir));
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('TOOL_FAILED');
  });

  test('tracker.list output validates against work-item-list.json (CAPABILITY_NORMALIZED_SCHEMA), not the single-work-item schema', async () => {
    const binDir = mkStubBinDir();
    const result = await runCapability(REAL_MANIFEST, 'tracker.list', {}, withStubEnv(binDir));
    expect(result.ok).toBe(true);
    expect(validateWorkItem(result.data)).toBe(false);
    const listSchemaPath = path.join(
      REPO_ROOT, 'packages', 'development', 'toolchain', 'schemas', 'normalized', 'work-item-list.json'
    );
    const validateList = new Ajv({ allErrors: true }).compile(JSON.parse(fs.readFileSync(listSchemaPath, 'utf8')));
    expect(validateList(result.data)).toBe(true);
  });
});

describe('TRD-033-TEST: side-effecting tracker capabilities, real runCapability() (multi-word allowlist end to end)', () => {
  test('tracker.create: normalizes id and validates against work-item.json', async () => {
    const binDir = mkStubBinDir();
    const result = await runCapability(
      REAL_MANIFEST,
      'tracker.create',
      { title: 'New task', description: 'Details', type: 'Task' },
      withStubEnv(binDir)
    );
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ id: 'stub-created-1' });
    expect(validateWorkItem(result.data)).toBe(true);
  });

  test('tracker.update: run[] substitutes "fields" into --title (non-status field edit), and the result normalizes', async () => {
    const binDir = mkStubBinDir();
    const result = await runCapability(REAL_MANIFEST, 'tracker.update', { id: '9', fields: 'Renamed title text' }, withStubEnv(binDir));
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ id: '9' });
    expect(validateWorkItem(result.data)).toBe(true);
  });

  test('tracker.close: always passes the literal "Closed" state, and status normalizes to "closed"', async () => {
    const binDir = mkStubBinDir();
    const result = await runCapability(REAL_MANIFEST, 'tracker.close', { id: '9' }, withStubEnv(binDir));
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ id: '9', status: 'closed' });
    expect(validateWorkItem(result.data)).toBe(true);
  });

  test('tracker.comment: normalizes the work item id and validates against work-item.json', async () => {
    const binDir = mkStubBinDir();
    const result = await runCapability(REAL_MANIFEST, 'tracker.comment', { id: '9', text: 'a new comment' }, withStubEnv(binDir));
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ id: '9' });
    expect(validateWorkItem(result.data)).toBe(true);
  });

  test('tracker.dep-add: run[] substitutes id/type/dependsOnId into relation add, and the result normalizes', async () => {
    const binDir = mkStubBinDir();
    const result = await runCapability(
      REAL_MANIFEST,
      'tracker.dep-add',
      { id: '9', dependsOnId: '456', type: 'Predecessor' },
      withStubEnv(binDir)
    );
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ id: '9' });
    expect(validateWorkItem(result.data)).toBe(true);
  });

  test('tracker.dep-add: a flag-like relation "type" is rejected before execution', async () => {
    const binDir = mkStubBinDir();
    const result = await runCapability(
      REAL_MANIFEST,
      'tracker.dep-add',
      { id: '9', dependsOnId: '456', type: '--relation-type' },
      withStubEnv(binDir)
    );
    expect(result.ok).toBe(false);
    expect(['INVALID_ARG', 'NOT_ALLOWED']).toContain(result.error.code);
  });
});

describe('PR8-TEST: tracker.set-status (PR 8 independent review item 1: fixed, provider-native state literals via variants)', () => {
  test('status=open spawns the "New" variant and the result normalizes back to open', async () => {
    const binDir = mkStubBinDir();
    const result = await runCapability(REAL_MANIFEST, 'tracker.set-status', { id: '9', status: 'open' }, withStubEnv(binDir));
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ id: '9', status: 'open' });
    expect(validateWorkItem(result.data)).toBe(true);
  });

  test('status=in_progress spawns the "Active" variant and the result normalizes back to in_progress', async () => {
    const binDir = mkStubBinDir();
    const result = await runCapability(REAL_MANIFEST, 'tracker.set-status', { id: '9', status: 'in_progress' }, withStubEnv(binDir));
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ id: '9', status: 'in_progress' });
    expect(validateWorkItem(result.data)).toBe(true);
  });

  test('status=closed spawns the "Closed" variant and the result normalizes back to closed', async () => {
    const binDir = mkStubBinDir();
    const result = await runCapability(REAL_MANIFEST, 'tracker.set-status', { id: '9', status: 'closed' }, withStubEnv(binDir));
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ id: '9', status: 'closed' });
    expect(validateWorkItem(result.data)).toBe(true);
  });

  test('an unknown status value is rejected NOT_ALLOWED before any process spawns', async () => {
    const binDir = mkStubBinDir();
    const result = await runCapability(REAL_MANIFEST, 'tracker.set-status', { id: '9', status: 'bogus' }, withStubEnv(binDir));
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_ALLOWED');
    expect(result.error.message).toContain('bogus');
  });

  test('a flag-like id ("-x") is rejected before execution', async () => {
    const binDir = mkStubBinDir();
    const result = await runCapability(REAL_MANIFEST, 'tracker.set-status', { id: '-x', status: 'open' }, withStubEnv(binDir));
    expect(result.ok).toBe(false);
    expect(['INVALID_ARG', 'NOT_ALLOWED']).toContain(result.error.code);
  });
});

describe('TRD-033-TEST: health checks run the real (stubbed) az --version / extension show / devops configure / boards query', () => {
  test('every declared health check succeeds against the stub binary', () => {
    const binDir = mkStubBinDir();
    for (const check of REAL_MANIFEST.health) {
      const stdout = execFileSync(check.run[0], check.run.slice(1), {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
        encoding: 'utf8'
      });
      expect(stdout.length).toBeGreaterThan(0);
    }
  });
});

describe('TRD-033-TEST: "az repos" (a host-adapter subcommand) is never reachable through this adapter at runtime', () => {
  test('no declared capability or health check ever produces an "az repos" argv', () => {
    for (const [, capability] of Object.entries(REAL_MANIFEST.capabilities)) {
      expect(capability.run[1]).not.toBe('repos');
    }
    for (const check of REAL_MANIFEST.health) {
      expect(check.run[1]).not.toBe('repos');
    }
    const azAllowlist = REAL_MANIFEST.allowlist.find((e) => e.bin === 'az');
    expect(azAllowlist.sub.some((sub) => sub.split(' ')[0] === 'repos')).toBe(false);
  });
});
