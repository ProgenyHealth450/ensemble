'use strict';
/**
 * Tests for TRD-2026-8d825f54 TRD-011: `runCapability(adapter, capability, args, opts)` in
 * packages/development/lib/toolchain/runner.js — the runtime execution core that builds argv
 * via `buildArgv` (TRD-010), re-validates the resolved argv against the manifest's own
 * `binaries`/`allowlist` at runtime, and spawns exactly one `child_process.execFile` call per
 * invocation, returning the runner envelope (PRD REQ-023, AC-023-2).
 *
 * `child_process` is mocked throughout so no real process is ever spawned and no test needs a
 * real sleeping child to prove the timeout path.
 */

jest.mock('child_process');

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { execFile } = require('child_process');

const { buildArgv, runCapability } = require('../../packages/development/lib/toolchain/runner');

const GOOD_ADAPTER_FIXTURE_PATH = path.join(
  __dirname,
  'fixtures',
  'toolchain',
  'good-adapter',
  'adapter.yaml'
);

function loadGoodAdapterFixture() {
  return yaml.load(fs.readFileSync(GOOD_ADAPTER_FIXTURE_PATH, 'utf8'));
}

function minimalAdapter(overrides = {}) {
  return {
    adapter: 'fixture-tracker',
    binaries: ['fixture-tool'],
    allowlist: [{ bin: 'fixture-tool', sub: ['show', 'create'] }],
    capabilities: {
      'tracker.show': {
        run: ['fixture-tool', 'show', '--id', '${id}']
      }
    },
    ...overrides
  };
}

beforeEach(() => {
  execFile.mockReset();
});

describe('runCapability: unknown capability (Implementation AC 1)', () => {
  test('a capability absent from adapter.capabilities returns NOT_ALLOWED and spawns nothing', async () => {
    const adapter = minimalAdapter();
    const result = await runCapability(adapter, 'tracker.delete', {});
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'NOT_ALLOWED',
        message: "capability 'tracker.delete' is not declared by adapter 'fixture-tracker'"
      }
    });
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe('runCapability: buildArgv errors are converted, never thrown (TRD-011 boundary)', () => {
  test('a missing required placeholder value surfaces as INVALID_ARG and spawns nothing', async () => {
    const adapter = minimalAdapter();
    const result = await runCapability(adapter, 'tracker.show', {});
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_ARG');
    expect(execFile).not.toHaveBeenCalled();
  });

  test('an invalid variant selector surfaces as NOT_ALLOWED and spawns nothing', async () => {
    const adapter = minimalAdapter({
      capabilities: {
        'tracker.show': {
          run: ['fixture-tool', 'show'],
          variants: { format: { json: ['fixture-tool', 'show', '--json'] } }
        }
      }
    });
    const result = await runCapability(adapter, 'tracker.show', { format: 'xml' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_ALLOWED');
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe('runCapability: runtime allowlist denial (Implementation AC 1, TRD-011 AC 1)', () => {
  test('a manifest altered after validation to call "rm" returns NOT_ALLOWED and spawns nothing (spawn count 0)', async () => {
    const adapter = minimalAdapter({
      binaries: ['fixture-tool'],
      allowlist: [{ bin: 'fixture-tool', sub: ['show'] }],
      capabilities: {
        'tracker.show': {
          // Tampered: run now calls a binary never declared in `binaries`.
          run: ['rm', '-rf', '${id}']
        }
      }
    });
    const result = await runCapability(adapter, 'tracker.show', { id: 'bd-1' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_ALLOWED');
    expect(result.error.message).toContain('fixture-tracker');
    expect(result.error.message).toContain('rm');
    expect(execFile).not.toHaveBeenCalled();
  });

  test('a declared binary called with an undeclared subcommand returns NOT_ALLOWED and spawns nothing', async () => {
    const adapter = minimalAdapter({
      binaries: ['fixture-tool'],
      allowlist: [{ bin: 'fixture-tool', sub: ['show'] }],
      capabilities: {
        'tracker.show': {
          run: ['fixture-tool', 'delete', '--id', '${id}']
        }
      }
    });
    const result = await runCapability(adapter, 'tracker.show', { id: 'bd-1' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_ALLOWED');
    expect(result.error.message).toContain('fixture-tool');
    expect(result.error.message).toContain('delete');
    expect(execFile).not.toHaveBeenCalled();
  });

  test('a declared binary with no matching allowlist entry at all returns NOT_ALLOWED and spawns nothing', async () => {
    const adapter = minimalAdapter({
      binaries: ['fixture-tool'],
      allowlist: [],
      capabilities: {
        'tracker.show': {
          run: ['fixture-tool', 'show', '--id', '${id}']
        }
      }
    });
    const result = await runCapability(adapter, 'tracker.show', { id: 'bd-1' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_ALLOWED');
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe('runCapability: timeout (TRD-011 AC 2)', () => {
  test('a tool that exceeds timeoutMs returns TIMEOUT within 1000ms and the child is reported killed', async () => {
    execFile.mockImplementation((file, cmdArgs, options, callback) => {
      setImmediate(() => {
        const error = new Error('killed');
        error.killed = true;
        error.signal = 'SIGTERM';
        callback(error, '', '');
      });
    });

    const adapter = minimalAdapter();
    const started = Date.now();
    const result = await runCapability(adapter, 'tracker.show', { id: 'bd-1' }, { timeoutMs: 200 });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(1000);
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'TIMEOUT',
        message: expect.stringContaining('200ms')
      }
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    const [, , calledOptions] = execFile.mock.calls[0];
    expect(calledOptions.timeout).toBe(200);
    // TRD-011 AC 2 requires the child process is killed, not merely asked to exit: SIGTERM can
    // be trapped/ignored by a hostile or misbehaving tool (the Threat Model's "a hung tool
    // stalls a run" entry), so the runner always kills with SIGKILL, which cannot be trapped.
    expect(calledOptions.killSignal).toBe('SIGKILL');
  });

  test('error.killed alone (no error.signal reported) is still classified as TIMEOUT, not TOOL_FAILED', async () => {
    // Node does not guarantee both `killed` and `signal` are set together on every platform;
    // the runner must treat either one, alone, as proof the child was killed on timeout.
    execFile.mockImplementation((file, cmdArgs, options, callback) => {
      setImmediate(() => {
        const error = new Error('killed');
        error.killed = true;
        callback(error, '', '');
      });
    });

    const adapter = minimalAdapter();
    const result = await runCapability(adapter, 'tracker.show', { id: 'bd-1' }, { timeoutMs: 200 });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('TIMEOUT');
  });

  test('error.signal alone (no error.killed flag) is still classified as TIMEOUT, not TOOL_FAILED', async () => {
    execFile.mockImplementation((file, cmdArgs, options, callback) => {
      setImmediate(() => {
        const error = new Error('killed');
        error.signal = 'SIGKILL';
        callback(error, '', '');
      });
    });

    const adapter = minimalAdapter();
    const result = await runCapability(adapter, 'tracker.show', { id: 'bd-1' }, { timeoutMs: 200 });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('TIMEOUT');
  });

  test('timeoutMs defaults to 60000ms when opts.timeoutMs is not supplied (opts omitted entirely)', async () => {
    execFile.mockImplementation((file, cmdArgs, options, callback) => {
      setImmediate(() => callback(null, '{}', ''));
    });

    const adapter = minimalAdapter();
    await runCapability(adapter, 'tracker.show', { id: 'bd-1' });
    const [, , calledOptions] = execFile.mock.calls[0];
    // A dropped `|| DEFAULT_TIMEOUT_MS` fallback would leave this `undefined`, which execFile
    // treats as "no timeout" -- a silent denial-of-service regression (Threat Model: "a hung
    // tool stalls a run"), since almost every real caller omits opts.timeoutMs and relies on
    // the default.
    expect(calledOptions.timeout).toBe(60000);
  });
});
// No real, unmocked child-process integration test is added for the SIGKILL guarantee: this
// file mocks the entire `child_process` module for every test (see header comment), so proving
// `execFile` is always invoked with killSignal:'SIGKILL' (asserted above, and unoverridable --
// see "execFileOptions cannot override security-critical keys" below) is the discriminating
// assertion. SIGKILL is an OS-level guarantee Node's execFile cannot fail to deliver, unlike
// SIGTERM which a child can trap and survive, so no hand-rolled escalation/liveness-polling
// logic is needed. A real unmocked child-process test (spawn a Node script that traps SIGTERM
// and loops, assert it's gone within ~2s of a short timeoutMs) was considered but intentionally
// not added: it would need its own un-mocked test file and timing-sensitive process-liveness
// polling, adding CI flakiness risk for marginal extra confidence beyond the assertions above.

describe('runCapability: non-zero exit / spawn failure (TOOL_FAILED)', () => {
  test('a non-killed execFile error returns TOOL_FAILED naming the adapter and capability, including stderr', async () => {
    execFile.mockImplementation((file, cmdArgs, options, callback) => {
      setImmediate(() => {
        const error = new Error('Command failed with exit code 1');
        callback(error, '', 'fixture-tool: id not found\n');
      });
    });

    const adapter = minimalAdapter();
    const result = await runCapability(adapter, 'tracker.show', { id: 'bd-1' });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('TOOL_FAILED');
    expect(result.error.message).toContain('fixture-tracker');
    expect(result.error.message).toContain('tracker.show');
    expect(result.error.message).toContain('id not found');
  });

  test('a spawn error (e.g. ENOENT) with empty stderr falls back to error.message', async () => {
    execFile.mockImplementation((file, cmdArgs, options, callback) => {
      setImmediate(() => {
        const error = new Error('spawn fixture-tool ENOENT');
        callback(error, '', '');
      });
    });

    const adapter = minimalAdapter();
    const result = await runCapability(adapter, 'tracker.show', { id: 'bd-1' });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('TOOL_FAILED');
    expect(result.error.message).toContain('ENOENT');
  });
});

describe('runCapability: never spawns a shell (PRD REQ-023)', () => {
  test('execFile is invoked with shell explicitly set to false', async () => {
    execFile.mockImplementation((file, cmdArgs, options, callback) => {
      setImmediate(() => callback(null, '{}', ''));
    });

    const adapter = minimalAdapter();
    await runCapability(adapter, 'tracker.show', { id: 'bd-1' });

    expect(execFile).toHaveBeenCalledTimes(1);
    const [calledFile, calledArgs, calledOptions] = execFile.mock.calls[0];
    expect(calledFile).toBe('fixture-tool');
    expect(calledArgs).toEqual(['show', '--id', 'bd-1']);
    expect(calledOptions.shell).toBe(false);
  });
});

describe('runCapability: caller-supplied execFileOptions cannot override security-critical keys (PRD REQ-023, TRD-011 AC 2)', () => {
  test('shell:true, a weakened killSignal and a shortened timeout supplied via opts.execFileOptions are all silently overridden', async () => {
    execFile.mockImplementation((file, cmdArgs, options, callback) => {
      setImmediate(() => callback(null, '{}', ''));
    });

    const adapter = minimalAdapter();
    const maliciousOptions = { shell: true, killSignal: 'SIGHUP', timeout: 1 };
    const result = await runCapability(
      adapter,
      'tracker.show',
      { id: 'bd-1' },
      { execFileOptions: maliciousOptions, timeoutMs: 5000 }
    );

    expect(result.ok).toBe(true);
    expect(execFile).toHaveBeenCalledTimes(1);
    const [, , calledOptions] = execFile.mock.calls[0];
    // The three security-critical keys always win, no matter what a caller spreads in.
    expect(calledOptions.shell).toBe(false);
    expect(calledOptions.killSignal).toBe('SIGKILL');
    expect(calledOptions.timeout).toBe(5000);
  });

  test('a benign, non-conflicting execFileOptions key (e.g. cwd) still passes through', async () => {
    execFile.mockImplementation((file, cmdArgs, options, callback) => {
      setImmediate(() => callback(null, '{}', ''));
    });

    const adapter = minimalAdapter();
    const result = await runCapability(
      adapter,
      'tracker.show',
      { id: 'bd-1' },
      { execFileOptions: { cwd: '/tmp' } }
    );

    expect(result.ok).toBe(true);
    const [, , calledOptions] = execFile.mock.calls[0];
    expect(calledOptions.cwd).toBe('/tmp');
    expect(calledOptions.shell).toBe(false);
    expect(calledOptions.killSignal).toBe('SIGKILL');
  });
});

describe('runCapability: success path with the real good-adapter fixture (full envelope)', () => {
  test("resolves {ok:true, capability, adapter, source, data} with data mapped+validated per the fixture capability's parse block (TRD-012)", async () => {
    const adapter = loadGoodAdapterFixture();
    const canned = JSON.stringify({ id: 'A-1', title: 'x', status: 'open' });

    execFile.mockImplementation((file, cmdArgs, options, callback) => {
      setImmediate(() => callback(null, canned, ''));
    });

    const result = await runCapability(adapter, 'tracker.show', { id: 'A-1' }, { source: 'project-config' });

    expect(execFile).toHaveBeenCalledTimes(1);
    const [calledFile, calledArgs] = execFile.mock.calls[0];
    expect(calledFile).toBe('fixture-tool');
    expect(calledArgs).toEqual(['show', '--id', 'A-1']);

    // good-adapter's tracker.show declares parse:{format:json,map:{id,title}} (status is raw
    // stdout only, never in the map), so `data` is the mapped object, not the raw `canned`
    // JSON string -- this is the TRD-012 wiring this describe block now proves end to end.
    expect(result).toEqual({
      ok: true,
      capability: 'tracker.show',
      adapter: 'fixture-good-tracker',
      source: 'project-config',
      data: { id: 'A-1', title: 'x' }
    });
  });

  test('source defaults to null when opts.source is not supplied', async () => {
    const adapter = loadGoodAdapterFixture();
    execFile.mockImplementation((file, cmdArgs, options, callback) => {
      // Must include 'id' (the fixture's parse.map requires it to resolve), or mapping itself
      // would fail with BAD_OUTPUT before `source` is ever considered.
      setImmediate(() => callback(null, JSON.stringify({ id: 'A-1', title: 'y' }), ''));
    });

    const result = await runCapability(adapter, 'tracker.show', { id: 'A-1' });
    expect(result.ok).toBe(true);
    expect(result.source).toBeNull();
  });
});

describe('runCapability: output mapping + normalized schema validation when cap.parse is declared (TRD-012, PRD REQ-002 AC-002-2, REQ-022 AC-022-2)', () => {
  test('(i) parse present + mapped output validates against the normalized schema -> data is the mapped object, not raw stdout', async () => {
    const stdout = JSON.stringify({ id: 'A-1', title: 'Fix the bug', status: 'open', extra: 'ignored-by-map' });
    execFile.mockImplementation((file, cmdArgs, options, callback) => {
      setImmediate(() => callback(null, stdout, ''));
    });

    const adapter = minimalAdapter({
      capabilities: {
        'tracker.show': {
          run: ['fixture-tool', 'show', '--id', '${id}'],
          parse: { format: 'json', root: '$', map: { id: '$.id', title: '$.title' } }
        }
      }
    });

    const result = await runCapability(adapter, 'tracker.show', { id: 'A-1' });

    expect(result).toEqual({
      ok: true,
      capability: 'tracker.show',
      adapter: 'fixture-tracker',
      source: null,
      data: { id: 'A-1', title: 'Fix the bug' }
    });
  });

  test('(ii) parse present + mapOutput throws on malformed JSON stdout -> BAD_OUTPUT, no data key, error.code/message bubble from mapOutput unchanged', async () => {
    execFile.mockImplementation((file, cmdArgs, options, callback) => {
      setImmediate(() => callback(null, 'not valid json {{{', ''));
    });

    const adapter = minimalAdapter({
      capabilities: {
        'tracker.show': {
          run: ['fixture-tool', 'show', '--id', '${id}'],
          parse: { format: 'json', root: '$', map: { id: '$.id' } }
        }
      }
    });

    const result = await runCapability(adapter, 'tracker.show', { id: 'A-1' });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('BAD_OUTPUT');
    expect(result.error.message).toMatch(/malformed JSON/);
    expect(result).not.toHaveProperty('data');
  });

  test('(iii) parse present + mapped output fails Ajv schema validation (missing required id) -> BAD_OUTPUT naming the field, no data key', async () => {
    const stdout = JSON.stringify({ title: 'No id in this one' });
    execFile.mockImplementation((file, cmdArgs, options, callback) => {
      setImmediate(() => callback(null, stdout, ''));
    });

    // map projects only 'title', never 'id': mapOutput itself succeeds (every declared map
    // path resolves), but the mapped shape then fails the normalized schema's required:['id'].
    const adapter = minimalAdapter({
      capabilities: {
        'tracker.show': {
          run: ['fixture-tool', 'show', '--id', '${id}'],
          parse: { format: 'json', root: '$', map: { title: '$.title' } }
        }
      }
    });

    const result = await runCapability(adapter, 'tracker.show', { id: 'A-1' });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('BAD_OUTPUT');
    expect(result.error.message).toContain('id');
    expect(result).not.toHaveProperty('data');
  });

  test('(iv) parse absent -> data stays the unchanged raw stdout (regression guard: zero behavior change for every adapter shipped today)', async () => {
    const rawStdout = 'totally-unparsed raw output, not even JSON {{{';
    execFile.mockImplementation((file, cmdArgs, options, callback) => {
      setImmediate(() => callback(null, rawStdout, ''));
    });

    const adapter = minimalAdapter(); // default fixture's tracker.show declares no `parse`
    const result = await runCapability(adapter, 'tracker.show', { id: 'A-1' });

    expect(result.ok).toBe(true);
    expect(result.data).toBe(rawStdout);
  });
});

describe('runCapability: manifest ${name} placeholder translation (reconciles TRD-010/TRD-011 syntax)', () => {
  test('a manifest run template using ${name} substitutes correctly without needing {name} rewriting by the caller', async () => {
    execFile.mockImplementation((file, cmdArgs, options, callback) => {
      setImmediate(() => callback(null, '{}', ''));
    });

    const adapter = minimalAdapter({
      capabilities: {
        'tracker.show': { run: ['fixture-tool', 'show', '--id', '${id}'] }
      }
    });

    const result = await runCapability(adapter, 'tracker.show', { id: 'bd-42' });
    expect(result.ok).toBe(true);
    const [, calledArgs] = execFile.mock.calls[0];
    expect(calledArgs).toEqual(['show', '--id', 'bd-42']);
  });
});

describe('runCapability: uses the real buildArgv, not a reimplementation', () => {
  test('buildArgv is still directly exported and usable independently of runCapability', () => {
    const argv = buildArgv(['fixture-tool', 'show', '{id}'], { id: 'bd-1' }, { inputs: {} });
    expect(argv).toEqual(['fixture-tool', 'show', 'bd-1']);
  });
});

describe('runCapability: mutation-sweep coverage for malformed-manifest fail-open paths (reviewer Finding 3)', () => {
  test('a non-array capability.run (malformed manifest) surfaces as INVALID_ARG via the error.code fallback, not a thrown/uncoded error', async () => {
    // buildArgv's own type guard throws a plain TypeError with no `.code` property for a
    // non-array runTemplate; runCapability's catch must still return a coded INVALID_ARG
    // envelope via `error.code || 'INVALID_ARG'`, not an uncoded/undefined-code result.
    const adapter = minimalAdapter({
      capabilities: {
        'tracker.show': { run: 'fixture-tool show --id ${id}' }
      }
    });
    const result = await runCapability(adapter, 'tracker.show', { id: 'bd-1' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_ARG');
    expect(result.error.message).toContain('runTemplate must be an array');
    expect(execFile).not.toHaveBeenCalled();
  });

  test('a non-array adapter.binaries (malformed manifest) is treated as no declared binaries, not substring-matched (fail-closed)', async () => {
    // Dropping the `Array.isArray(adapter.binaries)` guard would let a string `binaries` value
    // pass through `(adapter && adapter.binaries) || []` unchanged; `String.prototype.includes`
    // is a SUBSTRING check, so e.g. binaries:'xfixture-toolx' would wrongly permit the real
    // binary 'fixture-tool' via substring match. The guard must instead fall back to `[]`,
    // denying everything.
    const adapter = minimalAdapter({ binaries: 'xfixture-toolx' });
    const result = await runCapability(adapter, 'tracker.show', { id: 'bd-1' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_ALLOWED');
    expect(execFile).not.toHaveBeenCalled();
  });

  test('a non-array adapter.allowlist (malformed manifest) is treated as no declared allowlist entries (fail-closed)', async () => {
    const adapter = minimalAdapter({ allowlist: 'bogus-non-array-allowlist' });
    const result = await runCapability(adapter, 'tracker.show', { id: 'bd-1' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_ALLOWED');
    expect(execFile).not.toHaveBeenCalled();
  });

  test('a non-array allowlist entry.sub (malformed manifest) is treated as no allowed subcommands, not substring-matched (fail-closed)', async () => {
    // Dropping the `Array.isArray(entry.sub)` guard would let a string `sub` value pass
    // through `entry.sub || []` unchanged; `.includes('show')` on the string 'showall' would
    // then wrongly permit a subcommand that was never exactly declared.
    const adapter = minimalAdapter({
      binaries: ['fixture-tool'],
      allowlist: [{ bin: 'fixture-tool', sub: 'showall' }],
      capabilities: {
        'tracker.show': { run: ['fixture-tool', 'show', '--id', '${id}'] }
      }
    });
    const result = await runCapability(adapter, 'tracker.show', { id: 'bd-1' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_ALLOWED');
    expect(execFile).not.toHaveBeenCalled();
  });

  test('a synchronous throw from execFile itself is caught and converted to TOOL_FAILED, never left unresolved', async () => {
    // Proves the outer try/catch around the execFile(...) call (as opposed to the try/catch
    // around buildArgv) actually does something: without it, a synchronous throw (e.g. a
    // native binding error) would leave the returned Promise permanently unresolved.
    execFile.mockImplementation(() => {
      throw new Error('synchronous spawn failure');
    });

    const adapter = minimalAdapter();
    const result = await runCapability(adapter, 'tracker.show', { id: 'bd-1' });
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'TOOL_FAILED',
        message: expect.stringContaining('could not be started')
      }
    });
    expect(result.error.message).toContain('synchronous spawn failure');
  });
});
