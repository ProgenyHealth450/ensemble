'use strict';

/**
 * Tests for TRD-2026-8d825f54 TRD-035: the normalized "change request" schema
 * (`packages/development/toolchain/schemas/normalized/change-request.json`) and the finalized
 * `host`/`workflow` category contracts (PRD REQ-001, REQ-002).
 *
 * Ajv usage follows the same pattern as scripts/tests/toolchain-contract-version.test.js and
 * packages/development/lib/toolchain/config.js's `getValidator()`: compile the schema once per
 * test with `new Ajv({ allErrors: true })`.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const Ajv = require('ajv');

const { loadContracts } = require('../../packages/development/lib/toolchain/contracts');

const CATEGORIES_DIR = path.join(
  __dirname,
  '..',
  '..',
  'packages',
  'development',
  'toolchain',
  'categories'
);

const CHANGE_REQUEST_SCHEMA_PATH = path.join(
  __dirname,
  '..',
  '..',
  'packages',
  'development',
  'toolchain',
  'schemas',
  'normalized',
  'change-request.json'
);

const TOOLCHAIN_DEFAULT_PATH = path.join(
  __dirname,
  '..',
  '..',
  'packages',
  'development',
  'toolchain',
  'toolchain.default.yaml'
);
const CATEGORY_CONTRACT_SCHEMA_PATH = path.join(
  __dirname,
  '..',
  '..',
  'packages',
  'development',
  'toolchain',
  'schemas',
  'category-contract-schema.json'
);

function compileChangeRequestValidator() {
  const schema = JSON.parse(fs.readFileSync(CHANGE_REQUEST_SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv({ allErrors: true });
  return ajv.compile(schema);
}

const COMPLETE_SAMPLE = {
  id: '42',
  url: 'https://example.com/pr/42',
  state: 'OPEN',
  baseBranch: 'main',
  headBranch: 'feature/x',
  checks: [{ name: 'ci', status: 'success' }]
};

describe('change-request.json: normalized schema validation', () => {
  test('a complete sample ({id, url, state, baseBranch, headBranch, checks}) passes', () => {
    const validate = compileChangeRequestValidator();
    const ok = validate(COMPLETE_SAMPLE);
    expect(ok).toBe(true);
    expect(validate.errors).toBeNull();
  });

  test('a sample missing "state" fails validation', () => {
    const validate = compileChangeRequestValidator();
    const { state, ...withoutState } = COMPLETE_SAMPLE;
    const ok = validate(withoutState);
    expect(ok).toBe(false);
    expect(validate.errors.some((error) => error.params && error.params.missingProperty === 'state')).toBe(true);
  });

  test('a sample missing "id" fails validation', () => {
    const validate = compileChangeRequestValidator();
    const { id, ...withoutId } = COMPLETE_SAMPLE;
    const ok = validate(withoutId);
    expect(ok).toBe(false);
    expect(validate.errors.some((error) => error.params && error.params.missingProperty === 'id')).toBe(true);
  });
});

describe('host.yaml / workflow.yaml: sideEffect flags on real on-disk capabilities', () => {
  test('host.change-request-merge, workflow.sync and workflow.push all carry sideEffect: true', () => {
    const contracts = loadContracts(CATEGORIES_DIR);
    const host = contracts['host.yaml'];
    const workflow = contracts['workflow.yaml'];
    expect(host).toBeDefined();
    expect(workflow).toBeDefined();

    expect(host.capabilities['host.change-request-merge'].sideEffect).toBe(true);
    expect(workflow.capabilities['workflow.sync'].sideEffect).toBe(true);
    expect(workflow.capabilities['workflow.push'].sideEffect).toBe(true);
  });
});

describe('host.yaml / workflow.yaml: Ajv-valid against category-contract-schema.json', () => {
  test('host.yaml and workflow.yaml each validate against the category contract JSON schema', () => {
    const schema = JSON.parse(fs.readFileSync(CATEGORY_CONTRACT_SCHEMA_PATH, 'utf8'));
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(schema);

    const contracts = loadContracts(CATEGORIES_DIR);

    expect(validate(contracts['host.yaml'])).toBe(true);
    expect(validate.errors).toBeNull();
    expect(validate(contracts['workflow.yaml'])).toBe(true);
    expect(validate.errors).toBeNull();
  });

  test('host.yaml declares exactly the 9 finalized capabilities, workflow.yaml exactly the 11', () => {
    const contracts = loadContracts(CATEGORIES_DIR);
    const host = contracts['host.yaml'];
    const workflow = contracts['workflow.yaml'];

    expect(Object.keys(host.capabilities).sort()).toEqual(
      [
        'host.auth-status',
        'host.change-request-checks',
        'host.change-request-create',
        'host.change-request-link-work-item',
        'host.change-request-list',
        'host.change-request-merge',
        'host.change-request-reviews',
        'host.change-request-threads',
        'host.change-request-view'
      ].sort()
    );

    expect(Object.keys(workflow.capabilities).sort()).toEqual(
      [
        'workflow.branch-create',
        'workflow.commit',
        'workflow.diff',
        'workflow.log',
        'workflow.merge-base',
        'workflow.propose',
        'workflow.push',
        'workflow.remote-url',
        'workflow.ship',
        'workflow.status',
        'workflow.sync'
      ].sort()
    );
  });

  test('host.change-request-checks is required, host.change-request-threads and host.change-request-link-work-item are optional with no fallback', () => {
    const contracts = loadContracts(CATEGORIES_DIR);
    const host = contracts['host.yaml'];

    expect(host.capabilities['host.change-request-checks'].required).toBe(true);

    expect(host.capabilities['host.change-request-threads'].required).toBe(false);
    expect(host.capabilities['host.change-request-threads'].fallback).toBeUndefined();

    expect(host.capabilities['host.change-request-reviews'].required).toBe(false);
    expect(host.capabilities['host.change-request-reviews'].fallback).toBeUndefined();
    expect(host.capabilities['host.change-request-reviews'].sideEffect).toBe(false);

    expect(host.capabilities['host.change-request-link-work-item'].required).toBe(false);
    expect(host.capabilities['host.change-request-link-work-item'].fallback).toBeUndefined();
  });

  test('host.yaml and workflow.yaml both stay at contract version 1.0', () => {
    const contracts = loadContracts(CATEGORIES_DIR);
    expect(contracts['host.yaml'].version).toBe('1.0');
    expect(contracts['workflow.yaml'].version).toBe('1.0');
  });
});

describe('workflow.yaml: vcs.*-equivalent capabilities live under "workflow" with default adapter plain-git', () => {
  test('workflow.status/commit/push/log/diff/merge-base/remote-url are declared in the workflow contract', () => {
    const contracts = loadContracts(CATEGORIES_DIR);
    const workflow = contracts['workflow.yaml'];
    expect(workflow).toBeDefined();
    expect(workflow.category).toBe('workflow');

    const expectedVcsEquivalentIds = [
      'workflow.status',
      'workflow.commit',
      'workflow.push',
      'workflow.log',
      'workflow.diff',
      'workflow.merge-base',
      'workflow.remote-url'
    ];
    for (const capabilityId of expectedVcsEquivalentIds) {
      expect(workflow.capabilities[capabilityId]).toBeDefined();
    }
  });

  test('the shipped default toolchain config selects plain-git for the workflow category', () => {
    const defaultConfig = yaml.load(fs.readFileSync(TOOLCHAIN_DEFAULT_PATH, 'utf8'));
    expect(defaultConfig.workflow).toBe('plain-git');
  });
});
