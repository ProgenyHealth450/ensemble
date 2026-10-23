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
const { execFile, execFileSync } = require('child_process');

const {
  buildArgv,
  runCapability,
  buildChildEnv,
  listProcessTable,
  killVerifiedPidsSafe
} = require('../../packages/development/lib/toolchain/runner');
const {
  makeMutantToolchainRoot,
  mutateAndRequire
} = require('./fixtures/toolchain/mutant-toolchain-copy');

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
  execFileSync.mockReset();
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

  test("TRD-033: a declared binary called with a subcommand that is only a prefix of a multi-word allowlist entry ('boards' vs 'boards work-item show') returns NOT_ALLOWED and spawns nothing (proves word-count is enforced, not a prefix match)", async () => {
    const adapter = minimalAdapter({
      binaries: ['az'],
      allowlist: [{ bin: 'az', sub: ['boards work-item show'] }],
      capabilities: {
        'tracker.list': {
          run: ['az', 'boards', '--output', 'json']
        }
      }
    });
    const result = await runCapability(adapter, 'tracker.list', {});
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_ALLOWED');
    expect(result.error.message).toContain('az boards');
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe('runCapability: runtime allowlist permits multi-word subcommand entries (TRD-033)', () => {
  test("a declared binary called with argv matching a multi-word allowlist entry ('boards work-item show') spawns the resolved argv", async () => {
    const adapter = minimalAdapter({
      binaries: ['az'],
      allowlist: [{ bin: 'az', sub: ['boards work-item show'] }],
      capabilities: {
        'tracker.show': {
          run: ['az', 'boards', 'work-item', 'show', '--id', '${id}', '--output', 'json']
        }
      }
    });
    execFile.mockImplementation((file, cmdArgs, options, callback) => {
      setImmediate(() => callback(null, '{}', ''));
    });

    const result = await runCapability(adapter, 'tracker.show', { id: 'AB-1' });

    expect(result.ok).toBe(true);
    expect(execFile).toHaveBeenCalledTimes(1);
    const [calledFile, calledArgs] = execFile.mock.calls[0];
    expect(calledFile).toBe('az');
    expect(calledArgs).toEqual(['boards', 'work-item', 'show', '--id', 'AB-1', '--output', 'json']);
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

  test('(v) parse present + the normalized schema itself fails to load (missing/unreadable/invalid JSON) -> TOOL_FAILED naming the schema-load failure, never throws/crashes uncaught (reviewer P2: getNormalizedValidator had no try/catch inside the execFile callback)', async () => {
    jest.resetModules();
    const actualReadFileSync = jest.requireActual('fs').readFileSync;
    const schemaReadError = new Error("EACCES: permission denied, open 'work-item.json'");
    const readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation((filePath, encoding) => {
      if (String(filePath).endsWith('work-item.json')) {
        throw schemaReadError;
      }
      return actualReadFileSync(filePath, encoding);
    });

    try {
      const { execFile: freshExecFile } = require('child_process');
      const { runCapability: freshRunCapability } = require('../../packages/development/lib/toolchain/runner');

      freshExecFile.mockImplementation((file, cmdArgs, options, callback) => {
        setImmediate(() => callback(null, JSON.stringify({ id: 'A-1', title: 'Fix the bug' }), ''));
      });

      const adapter = minimalAdapter({
        capabilities: {
          'tracker.show': {
            run: ['fixture-tool', 'show', '--id', '${id}'],
            parse: { format: 'json', root: '$', map: { id: '$.id', title: '$.title' } }
          }
        }
      });

      const result = await freshRunCapability(adapter, 'tracker.show', { id: 'A-1' });

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'TOOL_FAILED',
          message: expect.stringContaining(
            "fixture-tracker: capability 'tracker.show' could not load its normalized schema:"
          )
        }
      });
      expect(result).not.toHaveProperty('data');
    } finally {
      readSpy.mockRestore();
      jest.resetModules();
    }
  });

  test('(vi) a non-.show tracker capability (tracker.create) whose mapped output declares only id still validates against the shared normalized schema and resolves ok:true (reviewer P2: category-keyed validation is not falsely narrower than .show)', async () => {
    const stdout = JSON.stringify({ id: 'A-99' });
    execFile.mockImplementation((file, cmdArgs, options, callback) => {
      setImmediate(() => callback(null, stdout, ''));
    });

    const adapter = minimalAdapter({
      capabilities: {
        'tracker.create': {
          run: ['fixture-tool', 'create', '--title', '${title}'],
          parse: { format: 'json', root: '$', map: { id: '$.id' } }
        }
      }
    });

    const result = await runCapability(adapter, 'tracker.create', { title: 'New work item' });

    expect(result).toEqual({
      ok: true,
      capability: 'tracker.create',
      adapter: 'fixture-tracker',
      source: null,
      data: { id: 'A-99' }
    });
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

describe('buildChildEnv: child environment allowlist (reviewer Finding 1, TRD trust boundary 2)', () => {
  test('an undeclared parent secret never appears in the built child env', () => {
    const parentEnv = { PATH: '/usr/bin', MY_SECRET: 'SECRET-ABC-123' };
    const env = buildChildEnv([], parentEnv);
    expect(env).toEqual({ PATH: '/usr/bin' });
    expect(env.MY_SECRET).toBeUndefined();
  });

  test('a name the adapter declares in env[] IS passed through when the parent has it set', () => {
    const parentEnv = { PATH: '/usr/bin', GITHUB_TOKEN: 'ghp_realtoken' };
    const env = buildChildEnv(['GITHUB_TOKEN'], parentEnv);
    expect(env.GITHUB_TOKEN).toBe('ghp_realtoken');
  });

  test('a declared name absent from the parent is simply absent, never undefined-valued', () => {
    const parentEnv = { PATH: '/usr/bin' };
    const env = buildChildEnv(['GITHUB_TOKEN'], parentEnv);
    expect(Object.prototype.hasOwnProperty.call(env, 'GITHUB_TOKEN')).toBe(false);
  });

  test('base allowlist vars pass through when set; an arbitrary unrelated var does not', () => {
    const parentEnv = {
      PATH: '/bin',
      HOME: '/home/x',
      USER: 'x',
      LOGNAME: 'x',
      LANG: 'en_US.UTF-8',
      TMPDIR: '/tmp',
      TERM: 'xterm',
      TZ: 'UTC',
      OTHER: 'nope'
    };
    const env = buildChildEnv([], parentEnv);
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/home/x',
      USER: 'x',
      LOGNAME: 'x',
      LANG: 'en_US.UTF-8',
      TMPDIR: '/tmp',
      TERM: 'xterm',
      TZ: 'UTC'
    });
  });

  test('every LC_* variable passes through regardless of a fixed name list', () => {
    const parentEnv = { PATH: '/bin', LC_ALL: 'C', LC_CTYPE: 'en_US.UTF-8', NOT_LC: 'nope' };
    const env = buildChildEnv([], parentEnv);
    expect(env.LC_ALL).toBe('C');
    expect(env.LC_CTYPE).toBe('en_US.UTF-8');
    expect(env.NOT_LC).toBeUndefined();
  });

  test('a caller-supplied execFileOptions.env override can replace an already-allowed value but cannot widen the allowed set', () => {
    const parentEnv = { PATH: '/bin' };
    const env = buildChildEnv([], parentEnv, { PATH: '/custom/bin', MY_SECRET: 'leak-attempt' });
    expect(env.PATH).toBe('/custom/bin');
    expect(env.MY_SECRET).toBeUndefined();
  });

  test('a non-array adapterEnvNames (malformed manifest) is treated as no declared names, fail-closed', () => {
    const parentEnv = { PATH: '/bin', MY_SECRET: 'x' };
    const env = buildChildEnv('MY_SECRET', parentEnv);
    expect(env.MY_SECRET).toBeUndefined();
  });
});

describe('runCapability: the child env execFile receives is filtered, never the full parent env (reviewer Finding 1)', () => {
  test('execFile is called with a filtered env object excluding an undeclared real process.env secret', async () => {
    const originalSecret = process.env.FIXTURE_UNDECLARED_SECRET;
    process.env.FIXTURE_UNDECLARED_SECRET = 'SECRET-ABC-123';
    try {
      execFile.mockImplementation((file, cmdArgs, options, callback) => {
        setImmediate(() => callback(null, '{}', ''));
      });

      const adapter = minimalAdapter({ env: ['GITHUB_TOKEN'] });
      await runCapability(adapter, 'tracker.show', { id: 'bd-1' });

      const [, , calledOptions] = execFile.mock.calls[0];
      expect(calledOptions.env).toBeDefined();
      expect(calledOptions.env.FIXTURE_UNDECLARED_SECRET).toBeUndefined();
      expect(calledOptions.env.PATH).toBe(process.env.PATH);
    } finally {
      if (originalSecret === undefined) delete process.env.FIXTURE_UNDECLARED_SECRET;
      else process.env.FIXTURE_UNDECLARED_SECRET = originalSecret;
    }
  });

  test('execFile is called with a declared env name actually present when the parent process has it set', async () => {
    const originalToken = process.env.FIXTURE_DECLARED_TOKEN;
    process.env.FIXTURE_DECLARED_TOKEN = 'ghp_realvalue';
    try {
      execFile.mockImplementation((file, cmdArgs, options, callback) => {
        setImmediate(() => callback(null, '{}', ''));
      });

      const adapter = minimalAdapter({ env: ['FIXTURE_DECLARED_TOKEN'] });
      await runCapability(adapter, 'tracker.show', { id: 'bd-1' });

      const [, , calledOptions] = execFile.mock.calls[0];
      expect(calledOptions.env.FIXTURE_DECLARED_TOKEN).toBe('ghp_realvalue');
    } finally {
      if (originalToken === undefined) delete process.env.FIXTURE_DECLARED_TOKEN;
      else process.env.FIXTURE_DECLARED_TOKEN = originalToken;
    }
  });
});

describe('runCapability: TOOL_FAILED message is redacted and length-bounded (reviewer Finding 4)', () => {
  test('a secret-shaped value in stderr never reaches the envelope message verbatim', async () => {
    const secret = `ghp_${'x'.repeat(36)}`;
    execFile.mockImplementation((file, cmdArgs, options, callback) => {
      setImmediate(() => {
        const error = new Error('Command failed with exit code 1');
        callback(error, '', `fixture-tool: denied, saw credential ${secret}\n`);
      });
    });

    const adapter = minimalAdapter();
    const result = await runCapability(adapter, 'tracker.show', { id: 'bd-1' });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('TOOL_FAILED');
    expect(result.error.message).not.toContain(secret);
    expect(result.error.message).toContain('[REDACTED:');
  });

  test('an overly long stderr detail is truncated, not grown unbounded into the envelope message', async () => {
    const hugeStderr = 'x'.repeat(10000);
    execFile.mockImplementation((file, cmdArgs, options, callback) => {
      setImmediate(() => {
        const error = new Error('Command failed with exit code 1');
        callback(error, '', hugeStderr);
      });
    });

    const adapter = minimalAdapter();
    const result = await runCapability(adapter, 'tracker.show', { id: 'bd-1' });

    expect(result.ok).toBe(false);
    expect(result.error.message.length).toBeLessThan(hugeStderr.length);
    expect(result.error.message).toContain('[truncated]');
  });
});

describe('mutation-restore proof: reviewer Findings 1 and 4 actually discriminate', () => {
  test('bypassing buildChildEnv filtering lets an undeclared parent secret reach the child env', () => {
    const mutantRoot = makeMutantToolchainRoot();
    try {
      const needle = 'function buildChildEnv(adapterEnvNames, parentEnv, callerEnvOverride) {';
      const replacement = `${needle}\n  return { ...parentEnv };`;
      const mutatedRunner = mutateAndRequire(mutantRoot.runnerPath, needle, replacement);

      const env = mutatedRunner.buildChildEnv([], { PATH: '/bin', MY_SECRET: 'SECRET-ABC-123' });
      // With the filter bypassed, the undeclared secret leaks straight through -- exactly what
      // the real (unmutated) "an undeclared parent secret never appears" test above disproves.
      expect(env.MY_SECRET).toBe('SECRET-ABC-123');
    } finally {
      mutantRoot.cleanup();
    }
  });

  test('removing the adapter-declared-names loop lets a declared env name stop reaching the child', () => {
    const mutantRoot = makeMutantToolchainRoot();
    try {
      const needle =
        "  for (const name of Array.isArray(adapterEnvNames) ? adapterEnvNames : []) {\n" +
        "    if (typeof name === 'string') allowedNames.add(name);\n" +
        "  }";
      const replacement = '  // adapter-declared-names loop removed by mutation';
      const mutatedRunner = mutateAndRequire(mutantRoot.runnerPath, needle, replacement);

      const env = mutatedRunner.buildChildEnv(['GITHUB_TOKEN'], {
        PATH: '/bin',
        GITHUB_TOKEN: 'ghp_realtoken'
      });
      // With the declared-names loop removed, a name the adapter explicitly declares in
      // `env[]` no longer reaches the child -- exactly what the real (unmutated) "a name the
      // adapter declares in env[] IS passed through" test above disproves.
      expect(env.GITHUB_TOKEN).toBeUndefined();
    } finally {
      mutantRoot.cleanup();
    }
  });
});

describe('killVerifiedPidsSafe: identity-verified kill, never a bare recycled pid (reviewer round 2, P2)', () => {
  let killSpy;

  beforeEach(() => {
    killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {});
  });

  afterEach(() => {
    killSpy.mockRestore();
  });

  test('a pid present in the fresh table with the SAME startedAt identity is killed', () => {
    const identities = new Map([[123, 'Wed Oct 22 10:00:00 2026']]);
    const fakeTable = () => [{ pid: 123, ppid: 1, startedAt: 'Wed Oct 22 10:00:00 2026' }];

    const verified = killVerifiedPidsSafe(identities, fakeTable);

    expect(verified).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(123, 'SIGKILL');
  });

  test('a pid present in the fresh table with a DIFFERENT startedAt (reused by another process) is NOT killed', () => {
    const identities = new Map([[123, 'Wed Oct 22 10:00:00 2026']]);
    const fakeTable = () => [{ pid: 123, ppid: 1, startedAt: 'Wed Oct 22 10:05:00 2026' }];

    const verified = killVerifiedPidsSafe(identities, fakeTable);

    expect(verified).toBe(true);
    expect(killSpy).not.toHaveBeenCalled();
  });

  test('a pid absent from the fresh table (already exited) is skipped, not killed', () => {
    const identities = new Map([[123, 'Wed Oct 22 10:00:00 2026']]);
    const fakeTable = () => [{ pid: 999, ppid: 1, startedAt: 'Wed Oct 22 10:00:00 2026' }];

    const verified = killVerifiedPidsSafe(identities, fakeTable);

    expect(verified).toBe(true);
    expect(killSpy).not.toHaveBeenCalled();
  });

  test('a process-table read failure (empty result, e.g. ps unavailable) reports verification failure and kills nothing', () => {
    const identities = new Map([[123, 'Wed Oct 22 10:00:00 2026']]);
    const fakeTable = () => [];

    const verified = killVerifiedPidsSafe(identities, fakeTable);

    expect(verified).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();
  });

  test('an empty identities map is a trivial success with nothing to verify or kill (never calls the reader)', () => {
    const fakeTable = jest.fn(() => []);

    const verified = killVerifiedPidsSafe(new Map(), fakeTable);

    expect(verified).toBe(true);
    expect(fakeTable).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });

  test('multiple identities: only the ones whose identity still verifies are killed', () => {
    const identities = new Map([
      [1, 'A'],
      [2, 'B'],
      [3, 'C']
    ]);
    const fakeTable = () => [
      { pid: 1, ppid: 0, startedAt: 'A' }, // matches -> killed
      { pid: 2, ppid: 0, startedAt: 'DIFFERENT' } // mismatched -> not killed; pid 3 absent -> not killed
    ];

    const verified = killVerifiedPidsSafe(identities, fakeTable);

    expect(verified).toBe(true);
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(1, 'SIGKILL');
  });
});

describe('mutation-restore proof: reviewer round-2 Finding 1 (recycled-pid kill) actually discriminates', () => {
  test('removing the start-time comparison lets a recycled pid (present, different identity) be killed anyway', () => {
    const mutantRoot = makeMutantToolchainRoot();
    try {
      const needle =
        '    if (currentStartedAtByPid.get(pid) !== startedAt) {\n' +
        '      continue; // gone, or a different process now holds this pid -- never signal it.\n' +
        '    }';
      const replacement =
        '    if (!currentStartedAtByPid.has(pid)) {\n' +
        '      continue; // only "still present" is checked now -- identity is NOT verified.\n' +
        '    }';
      const mutatedRunner = mutateAndRequire(mutantRoot.runnerPath, needle, replacement);

      const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {});
      try {
        const identities = new Map([[123, 'Wed Oct 22 10:00:00 2026']]);
        // Same pid, but a DIFFERENT startedAt: the real process-table row now describes an
        // unrelated process the OS recycled this pid to.
        const fakeTable = () => [{ pid: 123, ppid: 1, startedAt: 'Wed Oct 22 11:30:00 2026' }];

        mutatedRunner.killVerifiedPidsSafe(identities, fakeTable);

        // With the start-time comparison removed, the recycled pid is signaled anyway --
        // exactly what the real (unmutated) "a pid present ... with a DIFFERENT startedAt ...
        // is NOT killed" test above disproves.
        expect(killSpy).toHaveBeenCalledWith(123, 'SIGKILL');
      } finally {
        killSpy.mockRestore();
      }
    } finally {
      mutantRoot.cleanup();
    }
  });
});

describe('listProcessTable: real ps-output parsing contract (reviewer round 3, P2)', () => {
  test('a real macOS-shaped ps line (pid, ppid, lstart with internal spaces) parses to one row', () => {
    execFileSync.mockReturnValue('  452     1 Fri Oct 16 08:43:48 2026\n');

    expect(listProcessTable()).toEqual([
      { pid: 452, ppid: 1, startedAt: 'Fri Oct 16 08:43:48 2026' }
    ]);
  });

  test('a real procps-ng-Linux-shaped ps line parses to one row', () => {
    execFileSync.mockReturnValue(' 7781  7780 Fri Oct 16 08:43:48 2026\n');

    expect(listProcessTable()).toEqual([
      { pid: 7781, ppid: 7780, startedAt: 'Fri Oct 16 08:43:48 2026' }
    ]);
  });

  test('non-empty ps output with no lstart column at all (every line malformed) returns null, never []', () => {
    // Simulates a `ps` that does not support the combined `pid=,ppid=,lstart=` invocation and
    // silently prints only the columns it understands instead of erroring (reviewer round 3,
    // P2) -- every line here has only 2 tokens, so every row fails the `tokens.length < 3`
    // check and none survive into the returned table.
    execFileSync.mockReturnValue('  452     1\n  453     1\n');

    expect(listProcessTable()).toBeNull();
  });

  test('ps throwing (missing binary, non-zero exit) returns null', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('spawn ps ENOENT');
    });

    expect(listProcessTable()).toBeNull();
  });
});

describe('killVerifiedPidsSafe: fails CLOSED when verification itself cannot be trusted (reviewer round 3, P2)', () => {
  let killSpy;

  beforeEach(() => {
    killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {});
  });

  afterEach(() => {
    killSpy.mockRestore();
  });

  test('reader returning null (e.g. a ps that cannot report lstart) reports verification failure and kills nothing', () => {
    const identities = new Map([[123, 'Wed Oct 22 10:00:00 2026']]);
    const fakeTable = () => null;

    const verified = killVerifiedPidsSafe(identities, fakeTable);

    expect(verified).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();
  });

  test('reader throwing synchronously never escapes this function and still reports verification failure', () => {
    const identities = new Map([[123, 'Wed Oct 22 10:00:00 2026']]);
    const fakeTable = () => {
      throw new Error('ps exploded');
    };

    let verified;
    expect(() => {
      verified = killVerifiedPidsSafe(identities, fakeTable);
    }).not.toThrow();

    expect(verified).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();
  });

  test('an identity with no recorded startedAt (undefined) can never be verified, even if the reader would otherwise succeed', () => {
    const identities = new Map([[123, undefined]]);
    const fakeTable = jest.fn(() => [{ pid: 123, ppid: 1, startedAt: 'Wed Oct 22 10:00:00 2026' }]);

    const verified = killVerifiedPidsSafe(identities, fakeTable);

    expect(verified).toBe(false);
    expect(fakeTable).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });

  test('an identity with an empty-string startedAt is treated the same as undefined', () => {
    const identities = new Map([[123, '']]);
    const fakeTable = jest.fn(() => [{ pid: 123, ppid: 1, startedAt: '' }]);

    const verified = killVerifiedPidsSafe(identities, fakeTable);

    expect(verified).toBe(false);
    expect(fakeTable).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });

  test('the round-2 happy-path behaviors are unaffected: a verified identity is still killed, a mismatched one is still left alone', () => {
    const identities = new Map([[123, 'Wed Oct 22 10:00:00 2026']]);
    const fakeTable = () => [{ pid: 123, ppid: 1, startedAt: 'Wed Oct 22 10:00:00 2026' }];

    expect(killVerifiedPidsSafe(identities, fakeTable)).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(123, 'SIGKILL');
  });
});

describe('mutation-restore proof: reviewer round-3 Finding 1 (fail-closed ps verification) actually discriminates', () => {
  test('removing the identity startedAt guard lets an unverifiable identity report success without even reading the table', () => {
    const mutantRoot = makeMutantToolchainRoot();
    try {
      const needle =
        '  for (const startedAt of identities.values()) {\n' +
        "    if (!startedAt) return false; // no recorded start time -- can never be verified.\n" +
        '  }\n' +
        '\n' +
        '  let currentRows;';
      const replacement = '  let currentRows;';
      const mutatedRunner = mutateAndRequire(mutantRoot.runnerPath, needle, replacement);

      const identities = new Map([[123, undefined]]);
      const fakeTable = jest.fn(() => []);

      const verified = mutatedRunner.killVerifiedPidsSafe(identities, fakeTable);

      // With the guard removed, the function falls through to the table read, which here comes
      // back empty and already correctly reports `false` for a DIFFERENT reason -- so flip the
      // fake table to a shape that WOULD otherwise verify, to prove the guard (not the
      // table-emptiness check) is what the real code relies on.
      const fakeTableThatWouldMatch = jest.fn(() => [{ pid: 123, ppid: 1, startedAt: undefined }]);
      const verifiedWithMatchingButUndefinedIdentity = mutatedRunner.killVerifiedPidsSafe(
        identities,
        fakeTableThatWouldMatch
      );

      expect(verified).toBe(false);
      expect(verifiedWithMatchingButUndefinedIdentity).toBe(true);
    } finally {
      mutantRoot.cleanup();
    }
  });

  test('removing the try/catch around the table read lets a throwing reader escape as an uncaught exception', () => {
    const mutantRoot = makeMutantToolchainRoot();
    try {
      const needle =
        '  let currentRows;\n' +
        '  try {\n' +
        '    currentRows = listProcessTableFn();\n' +
        '  } catch {\n' +
        '    return false; // the reader itself threw -- verification impossible, never let this escape.\n' +
        '  }';
      const replacement = '  const currentRows = listProcessTableFn();';
      const mutatedRunner = mutateAndRequire(mutantRoot.runnerPath, needle, replacement);

      const identities = new Map([[123, 'Wed Oct 22 10:00:00 2026']]);
      const fakeTable = () => {
        throw new Error('ps exploded');
      };

      // With the try/catch removed, the throw escapes this function entirely -- exactly what
      // the real (unmutated) "reader throwing synchronously never escapes" test above disproves.
      expect(() => mutatedRunner.killVerifiedPidsSafe(identities, fakeTable)).toThrow('ps exploded');
    } finally {
      mutantRoot.cleanup();
    }
  });

  test('removing the null-collapsing check in listProcessTable lets a ps with no usable lstart column return [] instead of null (real process)', () => {
    const mutantRoot = makeMutantToolchainRoot();
    try {
      const needle =
        '  // Non-empty `ps` output that did not yield even one valid row is indistinguishable from "ps\n' +
        '  // cannot do what we asked" (see header above) -- never return it as if it meant something.\n' +
        '  if (rows.length === 0) return null;\n' +
        '  return rows;';
      const replacement = '  return rows;';
      mutateAndRequire(mutantRoot.runnerPath, needle, replacement);

      const realChildProcess = jest.requireActual('child_process');
      const fakePsBinDir = path.join(
        __dirname,
        'fixtures',
        'toolchain',
        'real-timeout-containment',
        'fake-ps-bin'
      );
      const probeScript =
        `const r = require(${JSON.stringify(mutantRoot.runnerPath)});` +
        'process.stdout.write(JSON.stringify(r.listProcessTable()));';

      const mutatedOutput = realChildProcess.execFileSync(process.execPath, ['-e', probeScript], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${fakePsBinDir}${path.delimiter}${process.env.PATH}` }
      });

      // With the null-collapsing guard removed, a `ps` that cannot report `lstart` (every line
      // drops to 2 tokens, same fixture the real test above exercises via a mocked
      // `execFileSync`) makes `listProcessTable` return `[]` instead of `null` -- exactly what
      // the real (unmutated) "non-empty ps output with no lstart column ... returns null" test
      // above disproves.
      expect(JSON.parse(mutatedOutput)).toEqual([]);
    } finally {
      mutantRoot.cleanup();
    }
  });
});

function psLine(pid, ppid, startedAt) {
  return `  ${pid}   ${ppid} ${startedAt}`;
}

function psTable(rows) {
  return `${rows.map(({ pid, ppid, startedAt }) => psLine(pid, ppid, startedAt)).join('\n')}\n`;
}

describe('refreshIdentities: descendantIdentities must MERGE across polls, never be wiped by a transient empty ppid-walk (reviewer round 4 follow-up)', () => {
  test('a descendant discovered by an early poll, then no longer reachable via collectDescendants(root, ...) in a later poll (its row still exists in the table, just no longer ppid-linked to root -- the real-world cause: a poll racing the root\'s own death sees the kernel\'s already-reparented state), is still included in the final verify-and-kill', async () => {
    const rootPid = 9001;
    const descendantPid = 9002;
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {});

    let callCount = 0;
    execFileSync.mockImplementation(() => {
      callCount += 1;
      if (callCount <= 3) {
        return psTable([
          { pid: rootPid, ppid: 1, startedAt: 'R' },
          { pid: descendantPid, ppid: rootPid, startedAt: 'D' }
        ]);
      }
      // From here on, collectDescendants(rootPid, ...) can no longer reach this pid via the
      // ppid walk (it no longer points at root) -- but the pid's own row, and its startedAt,
      // are still genuinely present in the table (it never exited).
      return psTable([
        { pid: rootPid, ppid: 1, startedAt: 'R' },
        { pid: descendantPid, ppid: 999999, startedAt: 'D' }
      ]);
    });

    execFile.mockImplementation((file, cmdArgs, options, callback) => {
      setTimeout(() => {
        const error = new Error('killed');
        error.killed = true;
        callback(error, '', '');
      }, options.timeout);
      return { pid: rootPid, kill: jest.fn() };
    });

    try {
      const adapter = minimalAdapter();
      const result = await runCapability(adapter, 'tracker.show', { id: 'bd-1' }, { timeoutMs: 350 });

      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('TIMEOUT');
      expect(killSpy).toHaveBeenCalledWith(descendantPid, 'SIGKILL');
    } finally {
      killSpy.mockRestore();
    }
  }, 10000);
});
