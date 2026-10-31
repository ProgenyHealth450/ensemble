'use strict';
/**
 * Tests for TRD-2026-8d825f54 TRD-007: `validateConformance(adapter, contracts)` in
 * packages/development/lib/toolchain/validate.js (PRD REQ-008, REQ-003, AC-008-1, AC-008-2).
 *
 * `validateConformance` takes an already-parsed adapter manifest and the category-contract map
 * returned by `loadContracts()` (keyed by file name, e.g. `'tracker.yaml'`); these tests build
 * minimal fixture contracts directly (rather than the real `packages/development/toolchain/
 * categories/*.yaml` files) so each case can control `addedInMinor`/`required` precisely.
 */

const { validateConformance } = require('../../packages/development/lib/toolchain/validate');

function validAdapter(overrides = {}) {
  return {
    adapter: 'example-tracker',
    version: '1.0.0',
    categories: ['tracker'],
    contract: { tracker: '1.0' },
    binaries: ['example-tool'],
    allowlist: [{ bin: 'example-tool', sub: ['show'] }],
    env: [],
    health: [],
    detect: [],
    capabilities: {
      'tracker.show': {
        run: ['example-tool', 'show', '--id', '${id}']
      }
    },
    ...overrides
  };
}

function trackerContract(overrides = {}) {
  return {
    'tracker.yaml': {
      category: 'tracker',
      version: '1.1',
      capabilities: {
        'tracker.show': {
          description: 'Read a single work item by id.',
          inputs: ['id'],
          outputs: ['id', 'title'],
          required: true,
          sideEffect: false
        },
        'tracker.create': {
          description: 'Create a new work item.',
          inputs: ['title'],
          outputs: ['id'],
          required: true,
          sideEffect: true,
          addedInMinor: 1
        },
        ...overrides.capabilities
      },
      ...overrides.topLevel
    }
  };
}

describe('TRD-007-TEST: AC-008-1 missing required capability fails naming it', () => {
  test('a manifest for category tracker lacking required capability tracker.show fails naming it', () => {
    const adapter = validAdapter({ capabilities: {} });

    const result = validateConformance(adapter, trackerContract());

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('tracker.show'))).toBe(true);
  });
});

describe('TRD-007-TEST: AC-008-2 fully conformant manifest returns {ok:true, errors:[]}', () => {
  test('a manifest implementing every required capability at a compatible contract version returns {ok:true, errors:[]}', () => {
    const adapter = validAdapter();

    const result = validateConformance(adapter, trackerContract());

    expect(result).toEqual({ ok: true, errors: [] });
  });
});

describe('TRD-007-TEST: AC-008-3 major contract mismatch surfaces checkCompat\'s message verbatim', () => {
  test('a manifest targeting a different major contract fails with a message naming both versions', () => {
    const adapter = validAdapter({ contract: { tracker: '2.0' } });

    const result = validateConformance(adapter, trackerContract());

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('2.0') && error.includes('1.1'))).toBe(true);
  });
});

describe('TRD-007-TEST: edge cases', () => {
  test('a declared category with no matching loaded contract fails naming the category', () => {
    const adapter = validAdapter();

    const result = validateConformance(adapter, {});

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('tracker') && error.includes('tracker.yaml'))).toBe(true);
  });

  test('a required capability unavailable at the adapter\'s targeted minor (addedInMinor) is not reported missing', () => {
    // tracker.create is required but addedInMinor:1; the adapter only targets 1.0 and does not
    // implement tracker.create, so it must not be flagged missing (it is unavailable, not
    // conformance-breaking).
    const adapter = validAdapter();

    const result = validateConformance(adapter, trackerContract());

    expect(result.ok).toBe(true);
    expect(result.errors.some((error) => error.includes('tracker.create'))).toBe(false);
  });

  test('a run template placeholder not declared as a contract input fails naming the adapter, capability and input', () => {
    const adapter = validAdapter({
      capabilities: {
        'tracker.show': {
          run: ['example-tool', 'show', '--id', '${id}', '--bogus', '${bogusInput}']
        }
      }
    });

    const result = validateConformance(adapter, trackerContract());

    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (error) => error.includes('example-tracker') && error.includes('tracker.show') && error.includes('bogusInput')
      )
    ).toBe(true);
  });

  test('a parse.map output field not declared as a contract output fails naming the adapter, capability and output', () => {
    const adapter = validAdapter({
      capabilities: {
        'tracker.show': {
          run: ['example-tool', 'show', '--id', '${id}'],
          parse: { format: 'json', root: '$', map: { id: '$.id', bogusOutput: '$.nope' } }
        }
      }
    });

    const result = validateConformance(adapter, trackerContract());

    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (error) => error.includes('example-tracker') && error.includes('tracker.show') && error.includes('bogusOutput')
      )
    ).toBe(true);
  });

  test('a variants run template placeholder not declared as a contract input fails naming the adapter, capability and input', () => {
    const adapter = validAdapter({
      capabilities: {
        'tracker.show': {
          run: ['example-tool', 'show', '--id', '${id}'],
          variants: {
            format: {
              json: ['example-tool', 'show', '--id', '${id}', '--as', '${bogusVariantInput}']
            }
          }
        }
      }
    });

    const result = validateConformance(adapter, trackerContract());

    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (error) =>
          error.includes('example-tracker') && error.includes('tracker.show') && error.includes('bogusVariantInput')
      )
    ).toBe(true);
  });
});
