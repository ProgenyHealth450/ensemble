'use strict';

/**
 * Parity suite (TRD-2026-8d825f54 TRD-025): `runCapability` (async, `execFile`) and
 * `runCapabilitySync` (sync, `execFileSync`, TRD-025) share every guard in
 * `packages/development/lib/toolchain/runner.js` -- capability lookup, argv building, the
 * runtime allowlist re-check, child-environment filtering, `TOOL_FAILED` detail redaction, the
 * zero-exit stdout-error-envelope check, `mapOutput`, and the error taxonomy
 * (`NOT_ALLOWED`/`INVALID_ARG`/`TIMEOUT`/`TOOL_FAILED`/`BAD_OUTPUT`) -- because both call the
 * exact same extracted helper functions. Every test here calls BOTH entry points against the
 * SAME manifest/capability/args and asserts identical envelopes, proving the two can never
 * silently diverge.
 *
 * `faketool` (a tiny executable Node script under a throwaway temp dir, referenced by its
 * absolute path so no `PATH` lookup/mutation is involved) stands in for the real binary a
 * resolved adapter would declare; no real `br`/`bv` is ever invoked by this file.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { runCapability, runCapabilitySync } = require('../lib/toolchain/runner');

let dir;
let bin;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-sync-parity-'));
  bin = path.join(dir, 'faketool');
  fs.writeFileSync(
    bin,
    [
      '#!/usr/bin/env node',
      "'use strict';",
      'const cmd = process.argv[2];',
      "if (cmd === 'echo') {",
      "  process.stdout.write(JSON.stringify({ hello: 'world' }));",
      "} else if (cmd === 'wrapped') {",
      "  process.stdout.write(JSON.stringify({ items: [{ id: 'x' }] }));",
      "} else if (cmd === 'env') {",
      '  process.stdout.write(JSON.stringify(process.env));',
      "} else if (cmd === 'fail') {",
      "  process.stderr.write('boom from stderr');",
      '  process.exit(7);',
      "} else if (cmd === 'sleep') {",
      "  setTimeout(() => process.stdout.write('done'), 5000);",
      '} else {',
      "  process.stderr.write('unknown cmd ' + cmd);",
      '  process.exit(2);',
      '}',
      ''
    ].join('\n')
  );
  fs.chmodSync(bin, 0o755);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function adapter(overrides = {}) {
  return {
    adapter: 'faketool-adapter',
    binaries: [bin],
    allowlist: [{ bin, sub: ['echo', 'wrapped', 'env', 'fail', 'sleep'] }],
    env: ['FAKE_TOOL_TOKEN'],
    capabilities: {
      'test.echo': { run: [bin, 'echo'] },
      'test.wrapped': {
        run: [bin, 'wrapped'],
        parse: { format: 'json', root: '$', map: { items: '$.items' } }
      },
      'test.env': { run: [bin, 'env'] },
      'test.fail': { run: [bin, 'fail'] },
      'test.sleep': { run: [bin, 'sleep'] },
      'test.badarg': { run: [bin, 'echo', '{missingArg}'] },
      'test.unlisted-binary': { run: ['/definitely/not/on/the/allowlist', 'x'] },
      ...overrides
    }
  };
}

describe('runCapability vs runCapabilitySync: identical envelopes for every guard', () => {
  test('capability not declared by the adapter -> same NOT_ALLOWED envelope', async () => {
    const a = await runCapability(adapter(), 'test.nope', {}, {});
    const s = runCapabilitySync(adapter(), 'test.nope', {}, {});
    expect(s).toEqual(a);
    expect(a).toEqual({
      ok: false,
      error: { code: 'NOT_ALLOWED', message: "capability 'test.nope' is not declared by adapter 'faketool-adapter'" }
    });
  });

  test('missing required arg (no default) -> same INVALID_ARG envelope', async () => {
    const a = await runCapability(adapter(), 'test.badarg', {}, {});
    const s = runCapabilitySync(adapter(), 'test.badarg', {}, {});
    expect(s).toEqual(a);
    expect(a).toEqual({
      ok: false,
      error: { code: 'INVALID_ARG', message: "'missingArg': no value supplied and the contract declares no default" }
    });
  });

  test('argv resolves to a binary outside allowlist -> same NOT_ALLOWED envelope (runtime allowlist re-check)', async () => {
    const a = await runCapability(adapter(), 'test.unlisted-binary', {}, {});
    const s = runCapabilitySync(adapter(), 'test.unlisted-binary', {}, {});
    expect(s).toEqual(a);
    expect(a.ok).toBe(false);
    expect(a.error.code).toBe('NOT_ALLOWED');
    expect(a.error.message).toMatch(/not declared in 'binaries'/);
  });

  test('success, no parse block -> same ok:true envelope with raw stdout as data', async () => {
    const a = await runCapability(adapter(), 'test.echo', {}, { source: 'default' });
    const s = runCapabilitySync(adapter(), 'test.echo', {}, { source: 'default' });
    expect(s).toEqual(a);
    expect(a).toEqual({
      ok: true,
      capability: 'test.echo',
      adapter: 'faketool-adapter',
      source: 'default',
      data: '{"hello":"world"}'
    });
  });

  test('success, with a parse block (non-tracker category, no schema gate) -> same mapped data', async () => {
    const a = await runCapability(adapter(), 'test.wrapped', {}, {});
    const s = runCapabilitySync(adapter(), 'test.wrapped', {}, {});
    expect(s).toEqual(a);
    expect(a).toEqual({
      ok: true,
      capability: 'test.wrapped',
      adapter: 'faketool-adapter',
      source: null,
      data: { items: [{ id: 'x' }] }
    });
  });

  test('non-zero exit with stderr -> same TOOL_FAILED envelope, redacted/bounded detail included verbatim', async () => {
    const a = await runCapability(adapter(), 'test.fail', {}, {});
    const s = runCapabilitySync(adapter(), 'test.fail', {}, {});
    expect(s).toEqual(a);
    expect(a).toEqual({
      ok: false,
      error: { code: 'TOOL_FAILED', message: "faketool-adapter: capability 'test.fail' failed: boom from stderr" }
    });
  });

  test('env filtering: only BASE_ENV_ALLOWLIST + declared env[] names reach the child, identically for both entry points', async () => {
    const parentEnv = {
      PATH: process.env.PATH,
      FAKE_TOOL_TOKEN: 'secret-value',
      UNRELATED_SECRET: 'should-not-pass'
    };
    const a = await runCapability(adapter(), 'test.env', {}, { parentEnv });
    const s = runCapabilitySync(adapter(), 'test.env', {}, { parentEnv });
    expect(a.ok).toBe(true);
    expect(s.ok).toBe(true);
    const envA = JSON.parse(a.data);
    const envS = JSON.parse(s.data);
    expect(envA.FAKE_TOOL_TOKEN).toBe('secret-value');
    expect(envS.FAKE_TOOL_TOKEN).toBe('secret-value');
    expect(envA.UNRELATED_SECRET).toBeUndefined();
    expect(envS.UNRELATED_SECRET).toBeUndefined();
    // Same allowed KEY SET from both entry points given the identical parentEnv/manifest.
    expect(Object.keys(envS).sort()).toEqual(Object.keys(envA).sort());
  });

  test(
    'timeout -> same TIMEOUT envelope naming the adapter, capability and configured timeout',
    async () => {
      const a = await runCapability(adapter(), 'test.sleep', {}, { timeoutMs: 200 });
      const s = runCapabilitySync(adapter(), 'test.sleep', {}, { timeoutMs: 200 });
      expect(s).toEqual(a);
      expect(a).toEqual({
        ok: false,
        error: {
          code: 'TIMEOUT',
          message: "faketool-adapter: capability 'test.sleep' exceeded its timeout of 200ms and was killed"
        }
      });
    },
    15000
  );
});
