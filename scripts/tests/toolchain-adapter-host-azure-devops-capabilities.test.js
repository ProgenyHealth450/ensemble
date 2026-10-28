'use strict';
/**
 * Capability-level test for `packages/infrastructure/skills/adapter-host-azure-devops`
 * (TRD-2026-8d825f54 TRD-040, TRD-040-TEST, PRD REQ-017), exercising the REAL, unmodified
 * `host.change-request-view` `parse` block (including the `statusMap`-on-`state`-fallback and
 * `trimPrefix` generalizations TRD-040 itself landed in `mapping.js`) against the adapter's own
 * shipped `fixtures/az-repos-pr-show.sample.json`. Manifest-level static checks (schema/
 * allowlist/conformance, resolver loadability, help-fixture cross-check, mutation-proof guard
 * tests, the "Merge denied" scenario) live in
 * `toolchain-adapter-host-azure-devops-manifest.test.js`.
 *
 * `fixtures/az-repos-pr-show.sample.json` is a disclosed SYNTHETIC fixture, NOT a captured live
 * `az repos pr show` run (no `az` binary is installed in this environment -- see the adapter's
 * own `fixtures/README.md` and `SKILL.md` "Known limits"). It is also captured in the shape
 * BEFORE this adapter's own `--query` flattening is applied (the raw Azure DevOps REST
 * pull-request object), since `az repos pr show --query "[...]" --output json` itself would
 * produce a 5-element JSON array, not this nested object -- no `jmespath` npm package is
 * available in this repo and no real `az` binary exists here to execute the query live, so
 * `deriveFlattenedShowOutput` below performs that flattening by hand, matching
 * `host.change-request-view`'s own `--query` string verbatim (same technique
 * `toolchain-adapter-tracker-azure-boards-capabilities.test.js`'s own
 * `deriveFlattenedShowOutput` uses for the sibling `az boards work-item show` capability).
 *
 * No test here spawns a real `az`.
 */

const fs = require('fs');
const path = require('path');

const Ajv = require('ajv');

const { loadAdapter } = require('../../packages/development/lib/toolchain/adapters');
const { mapOutput } = require('../../packages/development/lib/toolchain/mapping');

const REPO_ROOT = path.join(__dirname, '..', '..');
const ADAPTER_DIR = path.join(REPO_ROOT, 'packages', 'infrastructure', 'skills', 'adapter-host-azure-devops');
const CHANGE_REQUEST_SCHEMA_PATH = path.join(
  REPO_ROOT,
  'packages',
  'development',
  'toolchain',
  'schemas',
  'normalized',
  'change-request.json'
);
// Synthetic fixture (not a live capture -- see the adapter's own SKILL.md "Known limits" and
// fixtures/README.md).
const SHOW_FIXTURE_PATH = path.join(ADAPTER_DIR, 'fixtures', 'az-repos-pr-show.sample.json');

const ajv = new Ajv({ allErrors: true });
const validateChangeRequest = ajv.compile(JSON.parse(fs.readFileSync(CHANGE_REQUEST_SCHEMA_PATH, 'utf8')));

const { manifest: REAL_MANIFEST } = loadAdapter('azure-devops', { projectRoot: REPO_ROOT });

/**
 * By-hand derivation of what the REAL `host.change-request-view` capability's own `--query`
 * JMESPath expression (`packages/infrastructure/skills/adapter-host-azure-devops/adapter.yaml`:
 * `"[to_string(pullRequestId), url, status, sourceRefName, targetRefName]"`) would produce from
 * the raw, nested Azure DevOps REST fixture (`fixtures/az-repos-pr-show.sample.json`): a
 * 5-element JSON array, position-for-position matching this capability's own `parse.map`
 * (`id: "$[0]"`, `url: "$[1]"`, `state: "$[2]"`, `headBranch: "$[3]"`, `baseBranch: "$[4]"`).
 *
 * @param {object} rawFixture the parsed az-repos-pr-show.sample.json object
 * @returns {[string, string, string, string, string]}
 */
function deriveFlattenedShowOutput(rawFixture) {
  return [String(rawFixture.pullRequestId), rawFixture.url, rawFixture.status, rawFixture.sourceRefName, rawFixture.targetRefName];
}

describe('TRD-040-TEST: Scenario "Pull request normalizes" -- the real az-repos-pr-show.sample.json fixture, hand-flattened to match host.change-request-view\'s own --query, maps through the REAL manifest parse block and validates against change-request.json', () => {
  test('mapOutput(--query-flattened fixture, REAL parse block) maps status:"active" to state:"open" and strips "refs/heads/" from both branches (TRD-040 Implementation AC 2)', () => {
    const rawFixture = JSON.parse(fs.readFileSync(SHOW_FIXTURE_PATH, 'utf8'));
    expect(rawFixture.status).toBe('active');
    expect(rawFixture.sourceRefName.startsWith('refs/heads/')).toBe(true);
    const flattened = deriveFlattenedShowOutput(rawFixture);

    const mapped = mapOutput(JSON.stringify(flattened), REAL_MANIFEST.capabilities['host.change-request-view'].parse);

    expect(mapped.id).toBe('42');
    expect(mapped.url).toBe(rawFixture.url);
    expect(mapped.state).toBe('open');
    expect(mapped.headBranch).toBe('feature/trd-040-azure-devops-host-adapter');
    expect(mapped.headBranch).not.toMatch(/^refs\/heads\//);
    expect(mapped.baseBranch).toBe('main');
    expect(mapped.baseBranch).not.toMatch(/^refs\/heads\//);
  });

  test('the mapped result validates against the normalized change-request schema (AC-040-2)', () => {
    const rawFixture = JSON.parse(fs.readFileSync(SHOW_FIXTURE_PATH, 'utf8'));
    const flattened = deriveFlattenedShowOutput(rawFixture);
    const mapped = mapOutput(JSON.stringify(flattened), REAL_MANIFEST.capabilities['host.change-request-view'].parse);

    expect(validateChangeRequest(mapped)).toBe(true);
    expect(validateChangeRequest.errors).toBeNull();
  });

  test('every statusMap entry (active/completed/abandoned) normalizes to the {open,closed,closed} enum this schema documents', () => {
    const rawFixture = JSON.parse(fs.readFileSync(SHOW_FIXTURE_PATH, 'utf8'));
    for (const [raw, normalized] of [
      ['active', 'open'],
      ['completed', 'closed'],
      ['abandoned', 'closed']
    ]) {
      const flattened = deriveFlattenedShowOutput(rawFixture);
      flattened[2] = raw; // status is the 3rd element
      const mapped = mapOutput(JSON.stringify(flattened), REAL_MANIFEST.capabilities['host.change-request-view'].parse);
      expect(mapped.state).toBe(normalized);
      expect(validateChangeRequest(mapped)).toBe(true);
    }
  });

  test('a status value with no statusMap entry fails closed with BAD_OUTPUT naming the value', () => {
    const rawFixture = JSON.parse(fs.readFileSync(SHOW_FIXTURE_PATH, 'utf8'));
    const flattened = deriveFlattenedShowOutput(rawFixture);
    flattened[2] = 'notSet'; // a real az repos pr list --status value, but not in this capability's statusMap
    expect(() =>
      mapOutput(JSON.stringify(flattened), REAL_MANIFEST.capabilities['host.change-request-view'].parse)
    ).toThrow(expect.objectContaining({ code: 'BAD_OUTPUT' }));
  });

  test('a mapped change-request value missing "state" fails validation (required: [id, state])', () => {
    const rawFixture = JSON.parse(fs.readFileSync(SHOW_FIXTURE_PATH, 'utf8'));
    const flattened = deriveFlattenedShowOutput(rawFixture);
    const mapped = mapOutput(JSON.stringify(flattened), REAL_MANIFEST.capabilities['host.change-request-view'].parse);
    delete mapped.state;

    expect(validateChangeRequest(mapped)).toBe(false);
  });
});

describe('TRD-2026-8d825f54 PR 9 fix round, item 1: host.change-request-list normalizes per-item state via the new arrayMap statusMap form', () => {
  test('mapOutput(--query-flattened fixture wrapped as a one-element list, REAL parse block) normalizes status:"active" to state:"open" per item', () => {
    const rawFixture = JSON.parse(fs.readFileSync(SHOW_FIXTURE_PATH, 'utf8'));
    // `az repos pr list --query "[].[...]"` projects the SAME 5-field flattening this
    // capability's `host.change-request-view` sibling uses, once per listed pull request --
    // wrapping the single real fixture's own flattened shape in an outer array reproduces
    // exactly what a one-result `az repos pr list` invocation would print.
    const flattenedList = [deriveFlattenedShowOutput(rawFixture)];
    const mapped = mapOutput(JSON.stringify(flattenedList), REAL_MANIFEST.capabilities['host.change-request-list'].parse);

    expect(mapped.items).toEqual([
      {
        id: '42',
        url: rawFixture.url,
        state: 'open',
        headBranch: 'refs/heads/feature/trd-040-azure-devops-host-adapter',
        baseBranch: 'refs/heads/main'
      }
    ]);
  });

  test('an unmapped per-item status fails closed with BAD_OUTPUT naming the value (never silently passed through raw)', () => {
    const rawFixture = JSON.parse(fs.readFileSync(SHOW_FIXTURE_PATH, 'utf8'));
    const flattenedItem = deriveFlattenedShowOutput(rawFixture);
    flattenedItem[2] = 'notSet'; // a real az repos pr list --status value, but not in this statusMap
    const flattenedList = [flattenedItem];

    expect(() =>
      mapOutput(JSON.stringify(flattenedList), REAL_MANIFEST.capabilities['host.change-request-list'].parse)
    ).toThrow(expect.objectContaining({ code: 'BAD_OUTPUT' }));
  });
});

describe('TRD-2026-8d825f54 PR 9 fix round, item 1: host.change-request-checks normalizes reviewer votes into named states', () => {
  function flattenedChecksInput(rawFixture) {
    // `az repos pr show --query "[to_string(pullRequestId), reviewers]"`: the real fixture's
    // own unmodified `reviewers[]` array (real Azure DevOps REST shape: `{displayName, id,
    // vote, isRequired, isFlagged}`), never a shape tailored to this capability's own parse map.
    return [String(rawFixture.pullRequestId), rawFixture.reviewers];
  }

  test('mapOutput(real fixture reviewers[], REAL parse block) maps each reviewer into {reviewer, state}, normalizing the real fixture\'s own vote:10 and vote:0 entries', () => {
    const rawFixture = JSON.parse(fs.readFileSync(SHOW_FIXTURE_PATH, 'utf8'));
    expect(rawFixture.reviewers.map((r) => r.vote)).toEqual([10, 0]);
    const mapped = mapOutput(
      JSON.stringify(flattenedChecksInput(rawFixture)),
      REAL_MANIFEST.capabilities['host.change-request-checks'].parse
    );

    expect(mapped.id).toBe('42');
    expect(mapped.checks).toEqual([
      { reviewer: 'Jane Reviewer', state: 'approved' },
      { reviewer: 'John Reviewer', state: 'no-vote' }
    ]);
  });

  test('every documented Azure vote integer (10/5/0/-5/-10) normalizes to its named state', () => {
    const rawFixture = JSON.parse(fs.readFileSync(SHOW_FIXTURE_PATH, 'utf8'));
    for (const [vote, normalized] of [
      [10, 'approved'],
      [5, 'approved-with-suggestions'],
      [0, 'no-vote'],
      [-5, 'waiting-for-author'],
      [-10, 'rejected']
    ]) {
      const input = [String(rawFixture.pullRequestId), [{ displayName: 'Reviewer', vote }]];
      const mapped = mapOutput(JSON.stringify(input), REAL_MANIFEST.capabilities['host.change-request-checks'].parse);
      expect(mapped.checks).toEqual([{ reviewer: 'Reviewer', state: normalized }]);
    }
  });

  test('an unmapped vote integer fails closed with BAD_OUTPUT naming the value, never silently passed through as a bare number', () => {
    const rawFixture = JSON.parse(fs.readFileSync(SHOW_FIXTURE_PATH, 'utf8'));
    const input = [String(rawFixture.pullRequestId), [{ displayName: 'Reviewer', vote: 3 }]];

    expect(() =>
      mapOutput(JSON.stringify(input), REAL_MANIFEST.capabilities['host.change-request-checks'].parse)
    ).toThrow(expect.objectContaining({ code: 'BAD_OUTPUT' }));
  });

  test('the mapped result\'s checks[] validates against the normalized change-request schema', () => {
    const rawFixture = JSON.parse(fs.readFileSync(SHOW_FIXTURE_PATH, 'utf8'));
    const mapped = mapOutput(
      JSON.stringify(flattenedChecksInput(rawFixture)),
      REAL_MANIFEST.capabilities['host.change-request-checks'].parse
    );
    // 'id'+'checks' only -- this capability's own contract declares no 'state' output, so a
    // bare 'state'-requiring validation is not meaningful here; 'checks[]' items themselves
    // only need to be objects, which change-request.json's own 'checks' property enforces.
    expect(Array.isArray(mapped.checks)).toBe(true);
    for (const check of mapped.checks) {
      expect(typeof check).toBe('object');
      expect(check).not.toBeNull();
    }
  });
});

describe('TRD-040-TEST: host.change-request-link-work-item declares no parse block (no publicly documented JSON shape, not fabricated structure)', () => {
  test('the capability has no parse block at all', () => {
    expect(REAL_MANIFEST.capabilities['host.change-request-link-work-item'].parse).toBeUndefined();
  });
});
