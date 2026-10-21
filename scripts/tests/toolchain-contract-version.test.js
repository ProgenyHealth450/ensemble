'use strict';
/**
 * Tests for TRD-2026-8d825f54 TRD-002: per-category contract versioning,
 * `checkCompat()` and `checkAdditiveOnly()` in
 * packages/development/lib/toolchain/contracts.js (PRD REQ-003, AC-003-1, AC-003-2, AC-003-3).
 */

const { checkCompat, checkAdditiveOnly } = require('../../packages/development/lib/toolchain/contracts');

describe('checkCompat', () => {
  test('AC-003-1: adapter targeting an earlier minor sees a later-minor capability as unavailable but ok', () => {
    const contract = {
      version: '1.1',
      capabilities: {
        base: { inputs: ['in'], outputs: ['out'], required: true },
        x: { inputs: ['in'], outputs: ['out'], required: false, addedInMinor: 1 }
      }
    };

    const result = checkCompat('1.0', contract);

    expect(result.ok).toBe(true);
    expect(result.unavailableCapabilities).toContain('x');
    expect(result.missingCapabilities).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test('AC-003-2: a major-version mismatch is not ok and names every missing capability plus both versions', () => {
    const contract = {
      version: '2.0',
      capabilities: {
        a: { inputs: ['in'], outputs: ['out'], required: true },
        b: { inputs: ['in'], outputs: ['out'], required: false }
      }
    };

    const result = checkCompat('1.3', contract);

    expect(result.ok).toBe(false);
    expect(new Set(result.missingCapabilities)).toEqual(new Set(['a', 'b']));
    expect(result.errors[0]).toEqual(expect.stringContaining('1.3'));
    expect(result.errors[0]).toEqual(expect.stringContaining('2.0'));
  });

  test('AC-003-3 (isolation): bumping an unrelated tracker contract to 2.0 does not affect host/workflow checkCompat results', () => {
    const hostContract = {
      version: '1.0',
      capabilities: {
        start: { inputs: ['in'], outputs: ['out'], required: true }
      }
    };
    const workflowContract = {
      version: '1.0',
      capabilities: {
        run: { inputs: ['in'], outputs: ['out'], required: true }
      }
    };

    const hostResultBefore = checkCompat('1.0', hostContract);
    const workflowResultBefore = checkCompat('1.0', workflowContract);

    // Construct a separately-versioned tracker contract fixture, bumped to a new major.
    const trackerContract = {
      version: '2.0',
      capabilities: {
        track: { inputs: ['in'], outputs: ['out'], required: true }
      }
    };
    checkCompat('1.0', trackerContract);

    const hostResultAfter = checkCompat('1.0', hostContract);
    const workflowResultAfter = checkCompat('1.0', workflowContract);

    expect(hostResultAfter).toEqual(hostResultBefore);
    expect(workflowResultAfter).toEqual(workflowResultBefore);
  });
});

describe('checkAdditiveOnly', () => {
  test('AC-003-3: removing a capability within the same major fails and names the removed capability', () => {
    const previousContract = {
      version: '1.0',
      capabilities: {
        a: { inputs: ['in'], outputs: ['out'], required: true },
        b: { inputs: ['in'], outputs: ['out'], required: true }
      }
    };
    const nextContract = {
      version: '1.1',
      capabilities: {
        a: { inputs: ['in'], outputs: ['out'], required: true }
      }
    };

    const result = checkAdditiveOnly(previousContract, nextContract);

    expect(result.ok).toBe(false);
    expect(result.errors.some((message) => message.includes("'b'"))).toBe(true);
  });

  test('flipping a capability required flag within the same major fails and names that capability', () => {
    const previousContract = {
      version: '1.0',
      capabilities: {
        a: { inputs: ['in'], outputs: ['out'], required: true }
      }
    };
    const nextContract = {
      version: '1.1',
      capabilities: {
        a: { inputs: ['in'], outputs: ['out'], required: false }
      }
    };

    const result = checkAdditiveOnly(previousContract, nextContract);

    expect(result.ok).toBe(false);
    expect(result.errors.some((message) => message.includes("'a'"))).toBe(true);
  });

  test('adding only a new optional capability within the same major passes', () => {
    const previousContract = {
      version: '1.0',
      capabilities: {
        a: { inputs: ['in'], outputs: ['out'], required: true }
      }
    };
    const nextContract = {
      version: '1.1',
      capabilities: {
        a: { inputs: ['in'], outputs: ['out'], required: true },
        x: { inputs: ['in'], outputs: ['out'], required: false, addedInMinor: 1 }
      }
    };

    const result = checkAdditiveOnly(previousContract, nextContract);

    expect(result).toEqual({ ok: true, errors: [] });
  });
});
