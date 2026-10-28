'use strict';
/**
 * Tests for TRD-2026-8d825f54 TRD-013: `requireCapabilities(adapter, required, optional)` and
 * `lookupContractCapability(capabilityId, categoriesDir)` in
 * packages/development/lib/toolchain/resolve.js (PRD REQ-004, AC-004-1, AC-004-2), plus the
 * `runCapability` (`../../packages/development/lib/toolchain/runner.js`) `!cap` branch change
 * that surfaces an `unavailable:true`/`fallback` envelope for an optional capability the
 * adapter does not declare, when its category contract documents a fallback.
 *
 * `child_process` is mocked throughout so no real process is ever spawned; `requireCapabilities`
 * itself never touches `child_process` at all (it only reads `adapter.capabilities`), which the
 * first describe block below proves directly via `execFile`'s call count.
 *
 * These tests use the real, on-disk category contracts (`packages/development/toolchain/
 * categories/*.yaml`) via the real `loadContracts`, not fabricated fixture contracts, per the
 * assignment: `tracker.close` (required, no fallback), `work-graph.ready` (optional, fallback
 * `work-graph-links-fallback`) and `host.change-request-link-work-item` (optional, no fallback)
 * are real entries in those files as of this writing. `host.change-request-merge` is required
 * in the finalized TRD-035 host contract (TRD-2026-8d825f54), so it no longer serves as the
 * "optional, no fallback" example here.
 */

jest.mock('child_process');

const { execFile } = require('child_process');
const { runCapability } = require('../../packages/development/lib/toolchain/runner');
const {
  requireCapabilities,
  lookupContractCapability
} = require('../../packages/development/lib/toolchain/resolve');
const fs = require('fs');
const os = require('os');
const path = require('path');

function minimalAdapter(overrides = {}) {
  return {
    adapter: 'fixture-tracker',
    binaries: ['fixture-tool'],
    allowlist: [{ bin: 'fixture-tool', sub: ['show'] }],
    capabilities: {
      'tracker.show': {
        run: ['fixture-tool', 'show', '--id', '{id}']
      }
    },
    ...overrides
  };
}

beforeEach(() => {
  execFile.mockReset();
});

describe('requireCapabilities: required capability missing (AC-004-1)', () => {
  test('throws UNAVAILABLE naming the capability and the adapter, and never spawns anything', () => {
    const adapter = minimalAdapter();

    expect(() => requireCapabilities(adapter, ['tracker.close'], [])).toThrow(
      expect.objectContaining({
        code: 'UNAVAILABLE',
        message: expect.stringContaining("tracker.close")
      })
    );
    expect(() => requireCapabilities(adapter, ['tracker.close'], [])).toThrow(
      expect.objectContaining({ message: expect.stringContaining('fixture-tracker') })
    );
    expect(execFile).not.toHaveBeenCalled();
  });

  test('throws on the first missing required id, before considering later ones', () => {
    const adapter = minimalAdapter();
    expect(() => requireCapabilities(adapter, ['tracker.close', 'tracker.update'], [])).toThrow(
      expect.objectContaining({ message: expect.stringContaining('tracker.close') })
    );
  });
});

describe('requireCapabilities: required capability present (AC-004-1 happy path)', () => {
  test('does not throw when the adapter declares the required capability', () => {
    const adapter = minimalAdapter();
    expect(() => requireCapabilities(adapter, ['tracker.show'], [])).not.toThrow();
  });

  test('returns no unavailable flag for a required id that is also passed as optional and present', () => {
    const adapter = minimalAdapter();
    const result = requireCapabilities(adapter, [], ['tracker.show']);
    expect(result).toEqual({ 'tracker.show': { available: true } });
    expect(result['tracker.show'].unavailable).toBeUndefined();
  });
});

describe('requireCapabilities: optional capability absent with a documented contract fallback (AC-004-2)', () => {
  test('work-graph.ready reports unavailable:true with the contract fallback id and a message mentioning "fallback"', () => {
    const adapter = minimalAdapter();
    const result = requireCapabilities(adapter, [], ['work-graph.ready']);
    expect(result['work-graph.ready']).toEqual({
      available: false,
      unavailable: true,
      fallback: 'work-graph-links-fallback',
      message: expect.stringContaining('fallback')
    });
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe('requireCapabilities: optional capability absent with no documented contract fallback', () => {
  test('host.change-request-link-work-item (required:false, no fallback field) reports fallback:null', () => {
    const adapter = minimalAdapter();
    const result = requireCapabilities(adapter, [], ['host.change-request-link-work-item']);
    expect(result['host.change-request-link-work-item']).toEqual({
      available: false,
      unavailable: true,
      fallback: null,
      message: expect.stringContaining('no documented fallback')
    });
  });
});

describe('lookupContractCapability', () => {
  test('returns the full contract entry for a known capability id', () => {
    const entry = lookupContractCapability('tracker.close');
    expect(entry).toEqual({
      description: 'Close a work item.',
      inputs: ['id'],
      outputs: ['id', 'status'],
      required: true,
      sideEffect: true
    });
  });

  test('returns the fallback field for a known optional capability', () => {
    const entry = lookupContractCapability('work-graph.ready');
    expect(entry.fallback).toBe('work-graph-links-fallback');
  });

  test('returns null for a capability id not declared by any contract', () => {
    expect(lookupContractCapability('tracker.delete')).toBeNull();
  });

  test('returns null for a capability id whose category has no contract file at all', () => {
    expect(lookupContractCapability('no-such-category.thing')).toBeNull();
  });
});

describe('runCapability: optional capability absent from the adapter, with a documented fallback (AC-004-2 integration)', () => {
  test('returns ok:false, unavailable:true, fallback from the contract, and spawns nothing', async () => {
    const adapter = minimalAdapter();
    const result = await runCapability(adapter, 'work-graph.ready', {});

    expect(result).toEqual({
      ok: false,
      unavailable: true,
      fallback: 'work-graph-links-fallback',
      capability: 'work-graph.ready',
      adapter: 'fixture-tracker',
      error: {
        code: 'UNAVAILABLE',
        message: expect.stringContaining('fallback')
      }
    });
    expect(result.error.message).toEqual(expect.stringContaining('work-graph-links-fallback'));
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe('runCapability: mutation-proof coverage of the fallback-vs-NOT_ALLOWED branch', () => {
  test('a capability present on the adapter runs normally and the envelope carries no unavailable/fallback fields', async () => {
    execFile.mockImplementation((file, cmdArgs, options, callback) => {
      setImmediate(() => callback(null, 'stdout-data', ''));
    });
    const adapter = minimalAdapter();

    const result = await runCapability(adapter, 'tracker.show', { id: 'A-1' });

    expect(result.ok).toBe(true);
    expect(result.unavailable).toBeUndefined();
    expect(result.fallback).toBeUndefined();
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  test('a capability declared nowhere in any contract (declared === null) still returns plain NOT_ALLOWED', async () => {
    const adapter = minimalAdapter();
    const result = await runCapability(adapter, 'tracker.delete', {});

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'NOT_ALLOWED',
        message: "capability 'tracker.delete' is not declared by adapter 'fixture-tracker'"
      }
    });
    expect(result.unavailable).toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
  });

  test('a required:true contract capability missing from the adapter still returns plain NOT_ALLOWED, not UNAVAILABLE', async () => {
    const adapter = minimalAdapter();
    const result = await runCapability(adapter, 'tracker.close', {});

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'NOT_ALLOWED',
        message: "capability 'tracker.close' is not declared by adapter 'fixture-tracker'"
      }
    });
    expect(result.unavailable).toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
  });

  test('an optional contract capability with no fallback field missing from the adapter still returns plain NOT_ALLOWED', async () => {
    const adapter = minimalAdapter();
    const result = await runCapability(adapter, 'host.change-request-link-work-item', {});

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'NOT_ALLOWED',
        message: "capability 'host.change-request-link-work-item' is not declared by adapter 'fixture-tracker'"
      }
    });
    expect(result.unavailable).toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe('lookupContractCapability and runCapability are contract-driven, not an id whitelist (mutation-proof)', () => {
  // A synthetic category contract, isolated from the real on-disk contracts, with two
  // capabilities that would both be missed by a hardcoded "only work-graph.* has required:false
  // + fallback" assumption: `synthetic.readyThing` (required:false, with a fallback) proves the
  // fallback envelope is driven by reading the contract, not by matching a known capability id
  // string; `synthetic.mandatoryThing` (required:true, but ALSO declaring a fallback) proves the
  // fallback envelope is gated on `required === false` specifically, not merely on the presence
  // of a `fallback` field.
  const READY_FALLBACK = 'synthetic-fallback-id';
  const MANDATORY_FALLBACK = 'synthetic-fallback-id-2';
  let categoriesDir;

  beforeEach(() => {
    categoriesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-contract-fixture-'));
    fs.writeFileSync(
      path.join(categoriesDir, 'synthetic.yaml'),
      [
        'category: synthetic',
        'version: "1.0"',
        '',
        'capabilities:',
        '  synthetic.readyThing:',
        '    description: Synthetic optional capability with a documented fallback.',
        '    inputs: []',
        '    outputs: []',
        '    required: false',
        '    sideEffect: false',
        `    fallback: ${READY_FALLBACK}`,
        '',
        '  synthetic.mandatoryThing:',
        '    description: Synthetic required capability that also declares a fallback.',
        '    inputs: []',
        '    outputs: []',
        '    required: true',
        '    sideEffect: false',
        `    fallback: ${MANDATORY_FALLBACK}`,
        ''
      ].join('\n')
    );
  });

  afterEach(() => {
    fs.rmSync(categoriesDir, { recursive: true, force: true });
  });

  test('lookupContractCapability reads the fallback id straight from the synthetic contract, not from a known-id list', () => {
    const entry = lookupContractCapability('synthetic.readyThing', categoriesDir);
    expect(entry).toEqual({
      description: 'Synthetic optional capability with a documented fallback.',
      inputs: [],
      outputs: [],
      required: false,
      sideEffect: false,
      fallback: READY_FALLBACK
    });
  });

  test('runCapability resolves the required:false+fallback synthetic capability to the unavailable/fallback envelope', async () => {
    const adapter = minimalAdapter();
    const result = await runCapability(adapter, 'synthetic.readyThing', {}, { categoriesDir });

    expect(result).toEqual({
      ok: false,
      unavailable: true,
      fallback: READY_FALLBACK,
      capability: 'synthetic.readyThing',
      adapter: 'fixture-tracker',
      error: {
        code: 'UNAVAILABLE',
        message: expect.stringContaining(READY_FALLBACK)
      }
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  test('runCapability resolves the required:true+fallback synthetic capability to plain NOT_ALLOWED, never the fallback envelope', async () => {
    const adapter = minimalAdapter();
    const result = await runCapability(adapter, 'synthetic.mandatoryThing', {}, { categoriesDir });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'NOT_ALLOWED',
        message: "capability 'synthetic.mandatoryThing' is not declared by adapter 'fixture-tracker'"
      }
    });
    expect(result.unavailable).toBeUndefined();
    expect(result.fallback).toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
  });
});
