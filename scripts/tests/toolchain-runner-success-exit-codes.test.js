'use strict';
/**
 * Tests for `cap.successExitCodes` (TRD-2026-8d825f54 PR 10 fix round, item 3):
 * `packages/development/lib/toolchain/runner.js#runCapability` used to map ANY non-zero child
 * exit to `TOOL_FAILED` before ever parsing stdout, so a capability whose underlying tool
 * reports a FAILING result via a non-zero exit (every shipped test-runner per-language script
 * exits 1 on a failing suite, see `packages/development/skills/adapter-test-runner-default/
 * adapter.yaml`) could never surface the normalized `{success:false, failed, failures[]}`
 * shape the category contract promises -- only a fully passing (exit 0) run ever reached the
 * `parse`/mapping step at all.
 *
 * `child_process` is NOT mocked here: every capability below is really spawned via `node
 * <stub-file>.js`, a fresh stub script written under `os.tmpdir()` per test (never a real
 * external tool, nothing but the already-trusted `node` binary this test runner itself
 * executes under). `-e '<inline script>'` is deliberately NOT used: `buildArgv`'s placeholder
 * regex (`runner.js`'s `PLACEHOLDER_TEST_PATTERN = /\{[^{}]+\}/`) matches ANY `{...}` substring
 * in an argv template element, including literal JS object-literal braces inside an inline
 * script string (for example `{success:false,...}`) -- it is not anchored to the `${name}`/
 * `{name}` manifest-placeholder syntax specifically, so an inline script containing object
 * literals would be misparsed as unresolved capability placeholders. A real file path has no
 * braces at all, so this does not arise.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { runCapability } = require('../../packages/development/lib/toolchain/runner');
const { makeMutantToolchainRoot } = require('./fixtures/toolchain/mutant-toolchain-copy');

const NODE = process.execPath;
const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

/** Write `scriptBody` to a fresh stub `.js` file under `os.tmpdir()` and return its path. */
function writeStubScript(scriptBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-success-exit-codes-'));
  const filePath = path.join(dir, 'stub.js');
  fs.writeFileSync(filePath, scriptBody);
  tempDirs.push(dir);
  return filePath;
}

/**
 * A minimal, real adapter manifest with exactly one capability, `fixture.run`, whose `run`
 * template really spawns `node <stubPath>`.
 */
function makeFixtureAdapter(stubPath, { successExitCodes } = {}) {
  const capability = {
    run: [NODE, stubPath],
    parse: {
      format: 'json',
      map: {
        success: '$.success',
        passed: '$.passed',
        failed: '$.failed',
        total: '$.total',
        failures: '$.failures'
      }
    }
  };
  if (successExitCodes !== undefined) {
    capability.successExitCodes = successExitCodes;
  }
  return {
    adapter: 'fixture-success-exit-codes',
    binaries: [NODE],
    allowlist: [{ bin: NODE, sub: [stubPath] }],
    capabilities: { 'fixture.run': capability }
  };
}

const FAILING_SUITE_SCRIPT =
  'console.log(JSON.stringify({success:false,passed:2,failed:1,total:3,failures:[{file:"a.test.js",line:9}]}));\nprocess.exit(1);\n';
const PASSING_SUITE_SCRIPT =
  'console.log(JSON.stringify({success:true,passed:3,failed:0,total:3,failures:[]}));\nprocess.exit(0);\n';
const UNPARSEABLE_SCRIPT = "console.log('not json at all');\nprocess.exit(1);\n";

describe('runCapability: successExitCodes opt-in (real subprocess, no mock)', () => {
  test('a declared tolerated exit code (1) with valid, complete JSON stdout returns ok:true with data.success:false and failures[]', async () => {
    const stubPath = writeStubScript(FAILING_SUITE_SCRIPT);
    const adapter = makeFixtureAdapter(stubPath, { successExitCodes: [0, 1] });

    const result = await runCapability(adapter, 'fixture.run', {});

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      success: false,
      passed: 2,
      failed: 1,
      total: 3,
      failures: [{ file: 'a.test.js', line: 9 }]
    });
  });

  test('a fully passing run (exit 0) is unaffected by successExitCodes, regardless of whether it is declared', async () => {
    const stubPath = writeStubScript(PASSING_SUITE_SCRIPT);
    const adapter = makeFixtureAdapter(stubPath, { successExitCodes: [0, 1] });

    const result = await runCapability(adapter, 'fixture.run', {});

    expect(result.ok).toBe(true);
    expect(result.data.success).toBe(true);
  });

  test('regression: the SAME failing-suite exit (1) without successExitCodes declared stays TOOL_FAILED exactly as before this option existed', async () => {
    const stubPath = writeStubScript(FAILING_SUITE_SCRIPT);
    const adapter = makeFixtureAdapter(stubPath); // no successExitCodes at all

    const result = await runCapability(adapter, 'fixture.run', {});

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('TOOL_FAILED');
  });

  test('an exit code OUTSIDE the declared set (2, declared only [0,1]) stays TOOL_FAILED', async () => {
    const stubPath = writeStubScript(FAILING_SUITE_SCRIPT.replace('process.exit(1)', 'process.exit(2)'));
    const adapter = makeFixtureAdapter(stubPath, { successExitCodes: [0, 1] });

    const result = await runCapability(adapter, 'fixture.run', {});

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('TOOL_FAILED');
  });

  test('a declared tolerated exit code whose stdout does not parse as JSON at all stays TOOL_FAILED (indistinguishable from a real crash)', async () => {
    const stubPath = writeStubScript(UNPARSEABLE_SCRIPT);
    const adapter = makeFixtureAdapter(stubPath, { successExitCodes: [0, 1] });

    const result = await runCapability(adapter, 'fixture.run', {});

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('TOOL_FAILED');
    expect(result.error.message).toContain('does not parse as JSON');
  });

  test('a declared tolerated exit code whose stdout is valid JSON but missing a mapped field (e.g. a genuine crash that still prints SOME JSON) stays BAD_OUTPUT, never ok:true', async () => {
    const stubPath = writeStubScript(
      'console.log(JSON.stringify({success:false,error:"dotnet SDK not found"}));\nprocess.exit(1);\n'
    );
    const adapter = makeFixtureAdapter(stubPath, { successExitCodes: [0, 1] });

    const result = await runCapability(adapter, 'fixture.run', {});

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('BAD_OUTPUT');
  });

  test('a signal/timeout still resolves TIMEOUT, never influenced by successExitCodes', async () => {
    const stubPath = writeStubScript('setTimeout(() => {}, 2000);\n');
    const adapter = makeFixtureAdapter(stubPath, { successExitCodes: [0, 1] });

    const result = await runCapability(adapter, 'fixture.run', {}, { timeoutMs: 100 });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('TIMEOUT');
  }, 3000);

  test('the real shipped test-runner.run capability (adapter-test-runner-default) declares successExitCodes:[0,1]', () => {
    const yaml = require('js-yaml');
    const manifestPath = path.join(
      __dirname,
      '..',
      '..',
      'packages',
      'development',
      'skills',
      'adapter-test-runner-default',
      'adapter.yaml'
    );
    const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf8'));
    expect(manifest.capabilities['test-runner.run'].successExitCodes).toEqual([0, 1]);
  });

  describe('mutation proof (makeMutantToolchainRoot, never the real repo source)', () => {
    test('removing the toleratedExit check from a mutant copy of runCapability makes the same declared-successExitCodes failing-suite case regress to TOOL_FAILED', async () => {
      const mutantRoot = makeMutantToolchainRoot();
      try {
        const original = fs.readFileSync(mutantRoot.runnerPath, 'utf8');
        const needle =
          '            const toleratedExit =\n' +
          '              exitCode !== null && successExitCodes !== null && successExitCodes.includes(exitCode);\n';
        if (!original.includes(needle)) {
          throw new Error('mutation proof needle not found in mutant runner.js');
        }
        const mutated = original.replace(needle, '            const toleratedExit = false;\n');
        fs.writeFileSync(mutantRoot.runnerPath, mutated);
        // eslint-disable-next-line global-require, import/no-dynamic-require
        const mutantRunner = require(mutantRoot.runnerPath);

        const stubPath = writeStubScript(FAILING_SUITE_SCRIPT);
        const adapter = makeFixtureAdapter(stubPath, { successExitCodes: [0, 1] });
        const result = await mutantRunner.runCapability(adapter, 'fixture.run', {});

        // The tolerance check was forced to `false`: the exact same failing-suite exit that
        // returns ok:true/data.success:false above now wrongly resolves TOOL_FAILED again.
        expect(result.ok).toBe(false);
        expect(result.error.code).toBe('TOOL_FAILED');
      } finally {
        mutantRoot.cleanup();
      }
    });
  });
});
