'use strict';
/**
 * Tests for TRD-2026-8d825f54 TRD-001: the 14-category taxonomy, the skeleton category
 * contracts and `loadContracts()`/`validateContract()` in
 * packages/development/lib/toolchain/contracts.js (PRD REQ-001, REQ-002, AC-002-1).
 */

const fs = require('fs');
const path = require('path');

const { loadContracts, validateContract } = require('../../packages/development/lib/toolchain/contracts');

const CATEGORIES_DIR = path.join(
  __dirname,
  '..',
  '..',
  'packages',
  'development',
  'toolchain',
  'categories'
);

const EXPECTED_CATEGORIES = [
  'host',
  'workflow',
  'worktree',
  'tracker',
  'work-graph',
  'ci-local',
  'review',
  'lint',
  'test-runner',
  'e2e-quality',
  'container-deploy',
  'iac',
  'platform-cloud',
  'package-runner'
];

describe('category taxonomy', () => {
  test('exactly 14 category yaml files exist, named for the 14 categories', () => {
    const files = fs
      .readdirSync(CATEGORIES_DIR)
      .filter((name) => name.endsWith('.yaml'))
      .sort();

    expect(files).toHaveLength(14);
    expect(files).toEqual([...EXPECTED_CATEGORIES].sort().map((name) => `${name}.yaml`));
  });
});

describe('validateContract', () => {
  test('passes for a well-formed contract matching the schema', () => {
    const result = validateContract(
      {
        category: 'tracker',
        version: '1.0',
        capabilities: {
          'tracker.show': {
            inputs: ['id'],
            outputs: ['id', 'title', 'status'],
            required: true
          }
        }
      },
      'tracker.yaml'
    );

    expect(result).toEqual({ valid: true, errors: [] });
  });

  test('every real category contract loaded from disk validates with no errors', () => {
    const contracts = loadContracts(CATEGORIES_DIR);
    expect(Object.keys(contracts)).toHaveLength(14);

    for (const [fileName, contract] of Object.entries(contracts)) {
      const result = validateContract(contract, fileName);
      expect({ fileName, result }).toEqual({ fileName, result: { valid: true, errors: [] } });
    }
  });

  test('a capability missing outputs fails and names that capability', () => {
    const result = validateContract(
      {
        category: 'tracker',
        capabilities: {
          'tracker.show': {
            inputs: ['id'],
            // outputs intentionally omitted
            required: true
          }
        }
      },
      'broken.yaml'
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('broken.yaml') && e.includes('tracker.show'))).toBe(
      true
    );
  });

  test('a capability with empty inputs also fails', () => {
    const result = validateContract(
      {
        category: 'tracker',
        capabilities: {
          'tracker.show': {
            inputs: [],
            outputs: ['id'],
            required: true
          }
        }
      },
      'broken.yaml'
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('tracker.show'))).toBe(true);
  });

  test('a capability with a non-boolean required field fails', () => {
    const result = validateContract(
      {
        category: 'tracker',
        capabilities: {
          'tracker.show': {
            inputs: ['id'],
            outputs: ['id'],
            required: 'yes'
          }
        }
      },
      'broken.yaml'
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('tracker.show'))).toBe(true);
  });

  test('a contract without a version field fails validateContract naming the file', () => {
    const result = validateContract(
      {
        category: 'tracker',
        capabilities: {
          'tracker.show': {
            inputs: ['id'],
            outputs: ['id'],
            required: true
          }
        }
      },
      'no-version.yaml'
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('no-version.yaml') && e.includes('version'))).toBe(true);
  });

  test('a contract with a malformed version field fails validateContract naming the file', () => {
    const result = validateContract(
      {
        category: 'tracker',
        version: '1',
        capabilities: {
          'tracker.show': {
            inputs: ['id'],
            outputs: ['id'],
            required: true
          }
        }
      },
      'bad-version.yaml'
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('bad-version.yaml') && e.includes('version'))).toBe(true);
  });
});

describe('loadContracts', () => {
  test('reads and parses every *.yaml file in the categories dir', () => {
    const contracts = loadContracts(CATEGORIES_DIR);
    const fileNames = Object.keys(contracts).sort();

    expect(fileNames).toEqual([...EXPECTED_CATEGORIES].sort().map((name) => `${name}.yaml`));
    for (const name of EXPECTED_CATEGORIES) {
      expect(contracts[`${name}.yaml`].category).toBe(name);
    }
  });
});

/**
 * TRD-2026-8d825f54 TRD-001-TEST: every capability states inputs, outputs and
 * required/optional status (PRD REQ-002, AC-002-1).
 *
 * Scenario: Contract capabilities are fully stated -- Given a category, When its contract
 * is read through loadContracts(), Then every capability states inputs, outputs and
 * required/optional status and a capability missing any of them fails validation.
 */
describe('TRD-001-TEST: contract capabilities are fully stated', () => {
  test('Scenario: Contract capabilities are fully stated -- every loaded capability states inputs, outputs and required/optional status', () => {
    const contracts = loadContracts(CATEGORIES_DIR);
    expect(Object.keys(contracts)).toHaveLength(14);

    for (const [fileName, contract] of Object.entries(contracts)) {
      const result = validateContract(contract, fileName);
      expect({ fileName, result }).toEqual({ fileName, result: { valid: true, errors: [] } });

      for (const [capabilityName, capability] of Object.entries(contract.capabilities)) {
        expect(Array.isArray(capability.inputs)).toBe(true);
        expect(capability.inputs.length).toBeGreaterThan(0);
        expect(Array.isArray(capability.outputs)).toBe(true);
        expect(capability.outputs.length).toBeGreaterThan(0);
        expect(typeof capability.required).toBe('boolean');
        expect(capabilityName).toEqual(expect.any(String));
      }
    }
  });

  test('Scenario: Contract capabilities are fully stated -- a capability missing inputs, outputs or required/optional status fails validation', () => {
    const contracts = loadContracts(CATEGORIES_DIR);
    const fileName = 'tracker.yaml';
    const original = contracts[fileName];
    expect(original).toBeDefined();

    const capabilityNames = Object.keys(original.capabilities);
    expect(capabilityNames.length).toBeGreaterThan(0);
    const targetCapability = capabilityNames[0];

    const mutated = JSON.parse(JSON.stringify(original));
    delete mutated.capabilities[targetCapability].outputs;

    const result = validateContract(mutated, fileName);

    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes(fileName) && e.includes(targetCapability))
    ).toBe(true);
  });
});
