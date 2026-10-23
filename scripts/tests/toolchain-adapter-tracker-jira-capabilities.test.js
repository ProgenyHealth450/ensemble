'use strict';
/**
 * Capability-by-capability tests for `packages/infrastructure/skills/adapter-tracker-jira`
 * (TRD-2026-8d825f54 TRD-032/TRD-032-TEST), against the small, deterministic stub `jira`
 * script in `scripts/tests/fixtures/toolchain/adapter-tracker-jira-stub.js`. Manifest-level
 * static checks (schema/allowlist/conformance, resolver loadability, mutation-proof guard
 * tests) live in `scripts/tests/toolchain-adapter-tracker-jira-manifest.test.js`; this file
 * exercises every capability's actual `run[]`+`parse` behavior.
 *
 * No test here spawns a real `jira`: no `jira` binary is installed in this environment at all
 * (see this adapter's own `SKILL.md` "Known limits"); every capability resolves `jira` through
 * `PATH`, and every test that reaches a real process prepends a per-test tmpdir containing
 * ONLY the stub script to `process.env.PATH` (saved and restored in `afterEach`).
 */

const fs = require('fs');
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');

const Ajv = require('ajv');

const { loadAdapter } = require('../../packages/development/lib/toolchain/adapters');
const { runCapability } = require('../../packages/development/lib/toolchain/runner');
const { mapOutput } = require('../../packages/development/lib/toolchain/mapping');
const { writeJiraStub, writeStubControl } = require('./fixtures/toolchain/adapter-tracker-jira-stub');

const REPO_ROOT = path.join(__dirname, '..', '..');
const ADAPTER_DIR = path.join(REPO_ROOT, 'packages', 'infrastructure', 'skills', 'adapter-tracker-jira');
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
// this fixture file's sibling comment in the capability-level test below).
const ISSUE_SHOW_FIXTURE_PATH = path.join(ADAPTER_DIR, 'fixtures', 'jira-issue-show.sample.json');

const ajv = new Ajv({ allErrors: true });
const validateWorkItem = ajv.compile(JSON.parse(fs.readFileSync(WORK_ITEM_SCHEMA_PATH, 'utf8')));

const { manifest: REAL_MANIFEST } = loadAdapter('jira', { projectRoot: REPO_ROOT });

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
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-tracker-jira-bin-')));
  tempDirs.push(dir);
  writeJiraStub(dir);
  process.env.PATH = `${dir}:${process.env.PATH}`;
  return dir;
}

function withStubEnv(binDir) {
  return { parentEnv: { ...process.env, PATH: `${binDir}:${process.env.PATH}` }, timeoutMs: 10000 };
}

describe('TRD-032-TEST: a recorded jira issues read fixture normalizes and status-maps (Implementation AC 2)', () => {
  test('fixtures/jira-issue-show.sample.json, mapped through the real manifest parse block, validates against work-item.json', () => {
    const fixtureJson = fs.readFileSync(ISSUE_SHOW_FIXTURE_PATH, 'utf8');
    const mapped = mapOutput(fixtureJson, REAL_MANIFEST.capabilities['tracker.show'].parse);

    expect(mapped).toEqual({
      id: 'VA-2228',
      title: 'Fix login timeout bug',
      description: 'Users are logged out after 5 minutes of inactivity instead of the configured 30.',
      type: 'Bug',
      status: 'in_progress', // fixture's raw "In Review" maps through statusMap
      priority: 'High',
      labels: ['backend', 'auth']
    });
    expect(validateWorkItem(mapped)).toBe(true);
  });

  test('every statusMap entry normalizes to the {open,in_progress,closed} enum', () => {
    for (const [raw, normalized] of [
      ['To Do', 'open'],
      ['Backlog', 'open'],
      ['Open', 'open'],
      ['In Progress', 'in_progress'],
      ['In Review', 'in_progress'],
      ['Done', 'closed'],
      ['Closed', 'closed']
    ]) {
      const fixture = JSON.parse(fs.readFileSync(ISSUE_SHOW_FIXTURE_PATH, 'utf8'));
      fixture.status = raw;
      const mapped = mapOutput(JSON.stringify(fixture), REAL_MANIFEST.capabilities['tracker.show'].parse);
      expect(mapped.status).toBe(normalized);
      expect(validateWorkItem(mapped)).toBe(true);
    }
  });

  test('a status value with no statusMap entry fails closed with BAD_OUTPUT naming the value', () => {
    const fixture = JSON.parse(fs.readFileSync(ISSUE_SHOW_FIXTURE_PATH, 'utf8'));
    fixture.status = 'Blocked (unrecognized)';
    expect(() =>
      mapOutput(JSON.stringify(fixture), REAL_MANIFEST.capabilities['tracker.show'].parse)
    ).toThrow(expect.objectContaining({ code: 'BAD_OUTPUT' }));
  });
});

describe('TRD-032-TEST: tracker.show, real runCapability() against the stub jira', () => {
  test('normalizes and validates against work-item.json', async () => {
    const binDir = mkStubBinDir();
    writeStubControl(binDir, { issueStatus: 'Done' });

    const result = await runCapability(REAL_MANIFEST, 'tracker.show', { id: 'VA-9' }, withStubEnv(binDir));
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      id: 'VA-9',
      title: 'Stub issue summary',
      description: 'Stub issue description',
      type: 'Bug',
      status: 'closed',
      priority: 'High',
      labels: ['stub-label']
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
    const result = await runCapability(REAL_MANIFEST, 'tracker.show', { id: 'VA-9' }, withStubEnv(binDir));
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('TOOL_FAILED');
  });
});

describe('TRD-032-TEST: tracker.update\'s flag-like id is also rejected before execution (Implementation AC 3, a side-effecting capability)', () => {
  test('tracker.update with id="-x" fails INVALID_ARG/NOT_ALLOWED, never reaching the stub', async () => {
    const binDir = mkStubBinDir();
    const result = await runCapability(
      REAL_MANIFEST,
      'tracker.update',
      { id: '-x', fields: 'Done' },
      withStubEnv(binDir)
    );
    expect(result.ok).toBe(false);
    expect(['INVALID_ARG', 'NOT_ALLOWED']).toContain(result.error.code);
  });

  test('tracker.close with id="-x" fails INVALID_ARG/NOT_ALLOWED, never reaching the stub', async () => {
    const binDir = mkStubBinDir();
    const result = await runCapability(REAL_MANIFEST, 'tracker.close', { id: '-x' }, withStubEnv(binDir));
    expect(result.ok).toBe(false);
    expect(['INVALID_ARG', 'NOT_ALLOWED']).toContain(result.error.code);
  });
});

describe('TRD-032-TEST: tracker.list/tracker.comments declare no parse block, so data is raw stdout text', () => {
  test('tracker.list: data is the raw bare-array stdout text', async () => {
    const binDir = mkStubBinDir();
    const result = await runCapability(REAL_MANIFEST, 'tracker.list', {}, withStubEnv(binDir));
    expect(result.ok).toBe(true);
    expect(typeof result.data).toBe('string');
    const parsed = JSON.parse(result.data);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].key).toBe('VA-1');
  });

  test('tracker.list: an error envelope on stdout despite a zero exit fails closed (TOOL_FAILED)', async () => {
    const binDir = mkStubBinDir();
    writeStubControl(binDir, { errorEnvelope: true });
    const result = await runCapability(REAL_MANIFEST, 'tracker.list', {}, withStubEnv(binDir));
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('TOOL_FAILED');
  });

  test('tracker.comments: data is the raw array stdout text', async () => {
    const binDir = mkStubBinDir();
    const result = await runCapability(REAL_MANIFEST, 'tracker.comments', { id: 'VA-9' }, withStubEnv(binDir));
    expect(result.ok).toBe(true);
    expect(typeof result.data).toBe('string');
    expect(JSON.parse(result.data)).toEqual([{ id: 'comment-1', body: 'a stub comment' }]);
  });
});

describe('TRD-032-TEST: side-effecting tracker capabilities, real runCapability()', () => {
  test('tracker.create: normalizes id and validates against work-item.json', async () => {
    const binDir = mkStubBinDir();
    const result = await runCapability(
      REAL_MANIFEST,
      'tracker.create',
      { title: 'New bug', description: 'Details', type: 'Bug' },
      withStubEnv(binDir)
    );
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ id: 'VA-created-1' });
    expect(validateWorkItem(result.data)).toBe(true);
  });

  test('tracker.update: run[] substitutes "fields" into --status, and the result normalizes', async () => {
    const binDir = mkStubBinDir();
    const result = await runCapability(
      REAL_MANIFEST,
      'tracker.update',
      { id: 'VA-9', fields: 'In Progress' },
      withStubEnv(binDir)
    );
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ id: 'VA-9' });
    expect(validateWorkItem(result.data)).toBe(true);
  });

  test('tracker.close: always passes the literal "Done" status, and status normalizes to "closed"', async () => {
    const binDir = mkStubBinDir();
    writeStubControl(binDir, { issueStatus: 'Done' });
    const result = await runCapability(REAL_MANIFEST, 'tracker.close', { id: 'VA-9' }, withStubEnv(binDir));
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ id: 'VA-9', status: 'closed' });
    expect(validateWorkItem(result.data)).toBe(true);
  });

  test('tracker.comment: normalizes the comment id and validates against work-item.json', async () => {
    const binDir = mkStubBinDir();
    const result = await runCapability(
      REAL_MANIFEST,
      'tracker.comment',
      { id: 'VA-9', text: 'a new comment' },
      withStubEnv(binDir)
    );
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ id: 'comment-1' });
    expect(validateWorkItem(result.data)).toBe(true);
  });
});

describe('TRD-032-TEST: health checks run the real (stubbed) jira --version / issues list', () => {
  test('both health checks succeed against the stub binary', () => {
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
