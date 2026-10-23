'use strict';
/**
 * Capability-by-capability tests for `packages/git/skills/adapter-host-github` (TRD-2026-
 * 8d825f54 TRD-036/TRD-036-TEST, PRD REQ-006/REQ-024), against the REAL fixtures captured
 * live by TRD-036 in `fixtures/` (not synthetic -- see the adapter's own SKILL.md "Known
 * limits"). Manifest-level static checks (schema/allowlist/conformance, resolver loadability,
 * mutation-proof guard tests) live in `toolchain-adapter-host-github-manifest.test.js`; this
 * file exercises every captured capability's `parse` block against its real fixture via the
 * REAL, unmodified manifest's `mapOutput`, and Ajv-validates the one capability the TRD-036-
 * TEST acceptance criterion names (`host.change-request-view`) against the normalized
 * change-request schema.
 *
 * No test here spawns a real `gh`: every fixture file already IS the real captured stdout a
 * `gh ... --jq '...'` invocation produced (confirmed in the adapter's own `adapter.yaml`
 * comments and SKILL.md), so each test reads the fixture and feeds it directly to
 * `mapOutput`, exactly like `runCapability` would with that same stdout string.
 */

const fs = require('fs');
const path = require('path');

const Ajv = require('ajv');

const { loadAdapter } = require('../../packages/development/lib/toolchain/adapters');
const { mapOutput } = require('../../packages/development/lib/toolchain/mapping');

const REPO_ROOT = path.join(__dirname, '..', '..');
const ADAPTER_DIR = path.join(REPO_ROOT, 'packages', 'git', 'skills', 'adapter-host-github');
const CHANGE_REQUEST_SCHEMA_PATH = path.join(
  REPO_ROOT,
  'packages',
  'development',
  'toolchain',
  'schemas',
  'normalized',
  'change-request.json'
);

const ajv = new Ajv({ allErrors: true });
const validateChangeRequest = ajv.compile(JSON.parse(fs.readFileSync(CHANGE_REQUEST_SCHEMA_PATH, 'utf8')));

const { manifest: REAL_MANIFEST } = loadAdapter('github', { projectRoot: REPO_ROOT });

function readFixture(name) {
  return fs.readFileSync(path.join(ADAPTER_DIR, 'fixtures', name), 'utf8');
}

describe('TRD-036-TEST: Scenario "Recorded output normalizes" -- the real gh-pr-view.json fixture maps through host.change-request-view\'s REAL manifest parse block and validates against change-request.json', () => {
  test('mapOutput(real fixture, REAL parse block) produces the documented {id,url,state,baseBranch,headBranch,checks} shape, with state normalized via statusMap (PR 9 fix round, item 1)', () => {
    const stdout = readFixture('gh-pr-view.json');
    const mapped = mapOutput(stdout, REAL_MANIFEST.capabilities['host.change-request-view'].parse);

    expect(mapped.id).toBe('190');
    expect(mapped.url).toBe('https://github.com/Sunstone-Partners/ensemble/pull/190');
    expect(mapped.state).toBe('merged');
    expect(mapped.baseBranch).toBe('dev');
    expect(mapped.headBranch).toBe('docs/local-ci-runbook-stale-branch');
    expect(Array.isArray(mapped.checks)).toBe(true);
    expect(mapped.checks.length).toBeGreaterThan(0);
  });

  test('the mapped result validates against the normalized change-request schema (AC-036-2)', () => {
    const stdout = readFixture('gh-pr-view.json');
    const mapped = mapOutput(stdout, REAL_MANIFEST.capabilities['host.change-request-view'].parse);

    expect(validateChangeRequest(mapped)).toBe(true);
    expect(validateChangeRequest.errors).toBeNull();
  });

  test('a mapped change-request value missing "state" fails validation (required: [id, state])', () => {
    const stdout = readFixture('gh-pr-view.json');
    const mapped = mapOutput(stdout, REAL_MANIFEST.capabilities['host.change-request-view'].parse);
    delete mapped.state;

    expect(validateChangeRequest(mapped)).toBe(false);
  });

  test('every statusMap entry (OPEN/CLOSED/MERGED) normalizes to open/closed/merged', () => {
    const stdout = readFixture('gh-pr-view.json');
    const rawFlattened = JSON.parse(stdout);
    for (const [raw, normalized] of [
      ['OPEN', 'open'],
      ['CLOSED', 'closed'],
      ['MERGED', 'merged']
    ]) {
      const flattened = [...rawFlattened];
      flattened[2] = raw; // state is the 3rd element
      const mapped = mapOutput(JSON.stringify(flattened), REAL_MANIFEST.capabilities['host.change-request-view'].parse);
      expect(mapped.state).toBe(normalized);
    }
  });

  test('a state value with no statusMap entry fails closed with BAD_OUTPUT naming the value', () => {
    const stdout = readFixture('gh-pr-view.json');
    const flattened = JSON.parse(stdout);
    flattened[2] = 'DRAFT'; // not one of GitHub's known terminal states this adapter maps

    expect(() =>
      mapOutput(JSON.stringify(flattened), REAL_MANIFEST.capabilities['host.change-request-view'].parse)
    ).toThrow(expect.objectContaining({ code: 'BAD_OUTPUT' }));
  });
});

describe('TRD-036-TEST: other captured capabilities also normalize through the real manifest parse against their own real fixtures', () => {
  test('host.change-request-list maps gh-pr-list.json into {items: [{id,url,state,baseBranch,headBranch}]}, with per-item state normalized via arrayMap statusMap (PR 9 fix round, item 1)', () => {
    const stdout = readFixture('gh-pr-list.json');
    const mapped = mapOutput(stdout, REAL_MANIFEST.capabilities['host.change-request-list'].parse);

    expect(Array.isArray(mapped.items)).toBe(true);
    expect(mapped.items).toHaveLength(3);
    expect(mapped.items[0]).toEqual({
      id: '190',
      url: 'https://github.com/Sunstone-Partners/ensemble/pull/190',
      state: 'merged',
      baseBranch: 'dev',
      headBranch: 'docs/local-ci-runbook-stale-branch'
    });
  });

  test('host.change-request-list: an unmapped per-item state fails closed with BAD_OUTPUT naming the value', () => {
    const stdout = readFixture('gh-pr-list.json');
    const rawItems = JSON.parse(stdout);
    rawItems[0][2] = 'DRAFT'; // state is the 3rd element of each inner array

    expect(() =>
      mapOutput(JSON.stringify(rawItems), REAL_MANIFEST.capabilities['host.change-request-list'].parse)
    ).toThrow(expect.objectContaining({ code: 'BAD_OUTPUT' }));
  });

  test('host.change-request-checks maps gh-pr-checks.json into {checks: [...]}', () => {
    const stdout = readFixture('gh-pr-checks.json');
    const mapped = mapOutput(stdout, REAL_MANIFEST.capabilities['host.change-request-checks'].parse);

    expect(Array.isArray(mapped.checks)).toBe(true);
    expect(mapped.checks.length).toBeGreaterThan(0);
    expect(mapped.checks[0].name).toBe('CodeQL');
  });

  test('host.change-request-threads maps gh-pr-view-threads.json (real PR with zero comments) into {id, threads: []}', () => {
    const stdout = readFixture('gh-pr-view-threads.json');
    const mapped = mapOutput(stdout, REAL_MANIFEST.capabilities['host.change-request-threads'].parse);

    expect(mapped).toEqual({ id: '190', threads: [] });
  });
});

describe('TRD-036-TEST: host.change-request-merge declares no parse block (free-text confirmation, not fabricated structure)', () => {
  test('the capability has no parse block at all', () => {
    expect(REAL_MANIFEST.capabilities['host.change-request-merge'].parse).toBeUndefined();
  });
});
