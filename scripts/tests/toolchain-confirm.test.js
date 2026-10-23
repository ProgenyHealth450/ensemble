'use strict';
/**
 * Tests for TRD-2026-8d825f54 TRD-017: `confirmStatus`/`recordConfirmation` in
 * packages/development/lib/toolchain/confirm.js, and the `CONFIRMATION_REQUIRED` gate they
 * enable in `packages/development/lib/toolchain-cli.js`'s `run` subcommand (PRD REQ-011,
 * AC-011-1..5).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const { confirmStatus, recordConfirmation } = require('../../packages/development/lib/toolchain/confirm');
const { main } = require('../../packages/development/lib/toolchain-cli');
const { runPreflight } = require('../../packages/development/lib/toolchain/preflight');
const {
  makeMutantToolchainRoot,
  mutateAndRequire
} = require('./fixtures/toolchain/mutant-toolchain-copy');

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function mkTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function confirmationsDir(projectRoot) {
  return path.join(projectRoot, '.ensemble', 'state', 'toolchain', 'confirmations');
}

function mkProjectConfig(projectRoot, categoryToAdapter) {
  const ensembleDir = path.join(projectRoot, '.ensemble');
  fs.mkdirSync(ensembleDir, { recursive: true });
  const lines =
    Object.entries(categoryToAdapter)
      .map(([category, adapterId]) => `${category}: ${adapterId}`)
      .join('\n') + '\n';
  fs.writeFileSync(path.join(ensembleDir, 'toolchain.yaml'), lines);
}

/** Installed-origin adapter (never subject to the repo-local trust gate). */
function mkInstalledAdapter(projectRoot, adapterId, overrides = {}) {
  const skillDir = path.join(projectRoot, 'packages', 'fixture-pkg', 'skills', adapterId);
  fs.mkdirSync(skillDir, { recursive: true });
  const manifest = {
    adapter: adapterId,
    version: '1.0.0',
    categories: ['tracker'],
    contract: { tracker: '1.0' },
    binaries: [process.execPath],
    allowlist: [{ bin: process.execPath, sub: ['-e'] }],
    env: [],
    health: [],
    detect: [],
    capabilities: {},
    ...overrides
  };
  fs.writeFileSync(path.join(skillDir, 'adapter.yaml'), yaml.dump(manifest));
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `# ${adapterId}\n`);
  return skillDir;
}

async function captureStdout(fn) {
  let stdout = '';
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    stdout += chunk;
    return true;
  };
  try {
    const returned = await fn();
    return { returned, stdout };
  } finally {
    process.stdout.write = original;
  }
}

describe('AC-011-1: unconfirmed -> record -> confirmed shape', () => {
  test('an unconfirmed sideEffect capability returns confirmed:false with adapter/source; after recordConfirmation a second call for the same category returns confirmed:true', () => {
    const projectRoot = mkTempDir('confirm-ac1-');
    const ctx = {
      projectRoot,
      env: {},
      sideEffect: true,
      adapter: 'fixture-tracker',
      source: 'project',
      runId: 'r1'
    };

    const before = confirmStatus('tracker', ctx);
    expect(before).toEqual({ confirmed: false, adapter: 'fixture-tracker', source: 'project' });

    const recorded = recordConfirmation('tracker', ctx);
    expect(recorded).toEqual({ confirmed: true });

    const after = confirmStatus('tracker', ctx);
    expect(after).toEqual({ confirmed: true });
  });
});

describe('AC-011-4: a config change re-requires confirmation', () => {
  test('after a config edit that changes the resolved precedence tier (project -> detection) for the same adapter, configHash changes and confirmStatus returns confirmed:false again', () => {
    const projectRoot = mkTempDir('confirm-ac4-');
    const baseCtx = {
      projectRoot,
      env: {},
      sideEffect: true,
      adapter: 'fixture-tracker',
      runId: 'r1'
    };

    // Confirm once while the adapter is resolved from project config.
    recordConfirmation('tracker', { ...baseCtx, source: 'project' });
    expect(confirmStatus('tracker', { ...baseCtx, source: 'project' })).toEqual({
      confirmed: true
    });

    // Config change: the project toolchain.yaml entry for 'tracker' is removed, so the SAME
    // adapter id is now resolved through a different precedence tier (detection instead of
    // project config) -- configHash(adapter, source) depends on both fields, so this alone
    // changes the hash and must re-require confirmation even though the adapter name itself
    // did not change.
    const afterChange = confirmStatus('tracker', { ...baseCtx, source: 'detection' });
    expect(afterChange).toEqual({
      confirmed: false,
      adapter: 'fixture-tracker',
      source: 'detection'
    });
  });
});

describe('AC-011-3: explicit non-interactive signals auto-confirm and log adapter/source', () => {
  test('ctx.nonInteractive === true auto-confirms without writing or reading a record, and logs the adapter/source', () => {
    const projectRoot = mkTempDir('confirm-ac3a-');
    const spy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = confirmStatus('tracker', {
        projectRoot,
        env: {},
        nonInteractive: true,
        sideEffect: true,
        adapter: 'fixture-tracker',
        source: 'project'
      });

      expect(result).toEqual({ confirmed: true, prompt: false });
      expect(spy).toHaveBeenCalledTimes(1);
      const logged = spy.mock.calls[0][0];
      expect(logged).toContain('fixture-tracker');
      expect(logged).toContain('project');
      expect(fs.existsSync(confirmationsDir(projectRoot))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test('env.ENSEMBLE_NON_INTERACTIVE === "1" auto-confirms and logs the adapter/source', () => {
    const projectRoot = mkTempDir('confirm-ac3b-');
    const spy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = confirmStatus('tracker', {
        projectRoot,
        env: { ENSEMBLE_NON_INTERACTIVE: '1' },
        sideEffect: true,
        adapter: 'fixture-tracker',
        source: 'env-compat'
      });

      expect(result).toEqual({ confirmed: true, prompt: false });
      const logged = spy.mock.calls[0][0];
      expect(logged).toContain('fixture-tracker');
      expect(logged).toContain('env-compat');
    } finally {
      spy.mockRestore();
    }
  });
});

describe("AC: absence of a TTY alone never counts as non-interactive", () => {
  test('with no explicit signal and a deliberately empty env (never the real test-runner process.env, so CI=true/etc. from the actual runner can never leak in), confirmStatus still returns confirmed:false for an unconfirmed adapter', () => {
    const projectRoot = mkTempDir('confirm-ac-tty-');
    const ctx = {
      projectRoot,
      env: {}, // explicitly empty -- never process.env -- so this can never accidentally
      // inherit CI=true/ENSEMBLE_NON_INTERACTIVE=1/FOREMAN_TASK_TITLE from whatever
      // environment is actually running this test suite.
      sideEffect: true,
      adapter: 'fixture-tracker',
      source: 'project',
      // A runId is supplied so this reaches the ordinary (record-match) unconfirmed path, not
      // the keyless NO_CONFIRM_KEY path (PR 4 review Finding 3) -- this test is about TTY
      // absence, not about keying.
      runId: 'r-ac-tty'
      // nonInteractive intentionally omitted: isNonInteractive() has no TTY-based path to
      // becoming true, so the only way this test could wrongly report confirmed:true is a
      // real environment-leakage bug, which this empty env object rules out.
    };

    const result = confirmStatus('tracker', ctx);
    expect(result).toEqual({ confirmed: false, adapter: 'fixture-tracker', source: 'project' });
  });
});

describe('Concurrency: two categories confirmed at the same instant never collide', () => {
  test('two recordConfirmation calls for different categories, run concurrently, each produce their own distinct, valid-JSON file', async () => {
    const projectRoot = mkTempDir('confirm-concurrency-');
    const ctxFor = (runId) => ({
      projectRoot,
      env: {},
      adapter: 'fixture-tracker',
      source: 'project',
      runId
    });

    const [resultA, resultB] = await Promise.all([
      Promise.resolve().then(() => recordConfirmation('tracker', ctxFor('r-tracker'))),
      Promise.resolve().then(() => recordConfirmation('workflow', ctxFor('r-workflow')))
    ]);

    expect(resultA).toEqual({ confirmed: true });
    expect(resultB).toEqual({ confirmed: true });

    const dir = confirmationsDir(projectRoot);
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(2);

    const categories = files.map((file) => {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      expect(parsed.adapter).toBe('fixture-tracker');
      return parsed.category;
    });
    expect(categories.sort()).toEqual(['tracker', 'workflow']);
  });
});

describe('Non-sideEffect/local-only short-circuit, and allowlist pass-through', () => {
  test('a non-sideEffect capability returns required:false without touching the filesystem; an unconfirmed sideEffect status passes ctx.allowlist through unchanged', () => {
    const projectRoot = mkTempDir('confirm-ac6-');

    const notRequired = confirmStatus('lint', {
      projectRoot,
      env: {},
      sideEffect: false,
      adapter: 'fixture-lint'
    });
    expect(notRequired).toEqual({ required: false });
    expect(fs.existsSync(confirmationsDir(projectRoot))).toBe(false);

    const allowlist = [{ bin: '/usr/bin/eslint', sub: ['--fix'] }];
    const unconfirmed = confirmStatus('tracker', {
      projectRoot,
      env: {},
      sideEffect: true,
      adapter: 'fixture-tracker',
      source: 'project',
      runId: 'r-ac6',
      allowlist
    });
    expect(unconfirmed).toEqual({
      confirmed: false,
      adapter: 'fixture-tracker',
      source: 'project',
      allowlist
    });
  });
});

describe('production wiring: toolchain-cli run uses the real confirmStatus via its unmodified default ctx', () => {
  // These vars could theoretically leak from the real host running this suite and silently
  // flip the CLI into non-interactive auto-confirm, or select a different adapter via a
  // user-level config file / env-compat fallback, defeating the CONFIRMATION_REQUIRED
  // assertion below -- explicitly cleared for the duration of this describe block so the test
  // is deterministic regardless of the actual CI/host environment. XDG_CONFIG_HOME/
  // ENSEMBLE_PR_BACKEND/ENSEMBLE_BRANCHING_STRATEGY can never actually change these tests'
  // outcome (every test here sets a project-level `tracker` entry via mkProjectConfig, which
  // `resolveCategory` always prefers over the user config or env-compat fallback) but are
  // cleared anyway since doing so is free and keeps the isolation list exhaustive.
  const CONTROLLED_ENV_VARS = [
    'CI',
    'ENSEMBLE_NON_INTERACTIVE',
    'FOREMAN_TASK_TITLE',
    'CLAUDE_SESSION_ID',
    'ENSEMBLE_SESSION_ID',
    'XDG_CONFIG_HOME',
    'ENSEMBLE_PR_BACKEND',
    'ENSEMBLE_BRANCHING_STRATEGY'
  ];
  let savedVars;

  beforeEach(() => {
    savedVars = CONTROLLED_ENV_VARS.map((name) => [name, process.env[name]]);
    for (const name of CONTROLLED_ENV_VARS) {
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const [name, value] of savedVars) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test("main(['run', ...]) with no injected ctx returns CONFIRMATION_REQUIRED for an unconfirmed real adapter with a passing preflight record, then succeeds after recordConfirmation against the same session key the CLI computed", async () => {
    const projectRoot = mkTempDir('confirm-wiring-');
    mkProjectConfig(projectRoot, { tracker: 'fixture-confirm-tracker' });
    mkInstalledAdapter(projectRoot, 'fixture-confirm-tracker', {
      capabilities: {
        'tracker.create': { run: [process.execPath, '-e', 'process.stdout.write("{}")'] }
      }
    });

    const runId = 'confirm-wiring-r1';
    const originalCwd = process.cwd();
    try {
      process.chdir(projectRoot);

      // A real passing preflight record (hasPassingPreflightRecord's production caller is
      // already proven elsewhere; this test only needs a passing record to exist so the
      // confirmation gate -- not the earlier preflight gate -- is what's under test).
      const preflight = await runPreflight(
        { categories: ['tracker'], runId },
        { projectRoot, env: process.env }
      );
      expect(preflight.ok).toBe(true);

      // 1) Unconfirmed: main() with NO second argument uses its own real default ctx
      // (`{projectRoot: process.cwd(), env: process.env, detect: detectAdapter}`), so this
      // exercises confirmStatus exactly as a real shell invocation would.
      const { returned: codeA, stdout: stdoutA } = await captureStdout(() =>
        main(['run', 'tracker.create', '--run-id', runId, '--json'])
      );
      expect(codeA).toBe(1);
      const parsedA = JSON.parse(stdoutA.trim());
      expect(parsedA).toEqual({
        ok: false,
        error: { code: 'CONFIRMATION_REQUIRED', message: expect.any(String) }
      });
      expect(parsedA.error.message).toContain('fixture-confirm-tracker');

      // 2) Confirm directly against the SAME session key the CLI will compute: --non-interactive
      // was not passed and CLAUDE_SESSION_ID/ENSEMBLE_SESSION_ID are unset (cleared above), so
      // resolveSessionKey() returns null and effectiveSessionKey() falls back to --run-id
      // ('confirm-wiring-r1') -- exactly the runId this call supplies. adapter/source
      // ('fixture-confirm-tracker'/'project') match what resolveCategory resolves for this
      // project's toolchain.yaml.
      const recorded = recordConfirmation('tracker', {
        projectRoot,
        env: process.env,
        adapter: 'fixture-confirm-tracker',
        source: 'project',
        runId
      });
      expect(recorded).toEqual({ confirmed: true });

      // 3) Now the real, unmodified CLI path succeeds end to end.
      const { returned: codeB, stdout: stdoutB } = await captureStdout(() =>
        main(['run', 'tracker.create', '--run-id', runId, '--json'])
      );
      expect(codeB).toBe(0);
      const parsedB = JSON.parse(stdoutB.trim());
      expect(parsedB.ok).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test('AC-011-2: a confirmed category stays confirmed for a 2nd and 3rd main() call in the same session, with no new confirmation record written', async () => {
    const projectRoot = mkTempDir('confirm-wiring-repeat-');
    mkProjectConfig(projectRoot, { tracker: 'fixture-confirm-tracker-repeat' });
    mkInstalledAdapter(projectRoot, 'fixture-confirm-tracker-repeat', {
      capabilities: {
        'tracker.create': { run: [process.execPath, '-e', 'process.stdout.write("{}")'] }
      }
    });

    const runId = 'confirm-wiring-repeat-r1';
    const originalCwd = process.cwd();
    try {
      process.chdir(projectRoot);

      const preflight = await runPreflight(
        { categories: ['tracker'], runId },
        { projectRoot, env: process.env }
      );
      expect(preflight.ok).toBe(true);

      const { returned: confirmCode, stdout: confirmStdout } = await captureStdout(() =>
        main(['confirm-record', 'tracker.create', '--run-id', runId, '--json'])
      );
      expect(confirmCode).toBe(0);
      expect(JSON.parse(confirmStdout.trim()).ok).toBe(true);

      const dir = confirmationsDir(projectRoot);
      // Prove the equality check below is proven against real content, not an empty directory.
      expect(fs.readdirSync(dir)).toHaveLength(1);
      const snapshot = () =>
        fs
          .readdirSync(dir)
          .sort()
          .map((file) => [file, fs.statSync(path.join(dir, file)).mtimeMs]);
      const before = snapshot();

      // A 2nd AND a 3rd real main() call for the same confirmed category, each its own
      // process-level confirmStatus() read -- neither may re-prompt or write a new record.
      for (let i = 0; i < 2; i += 1) {
        const { returned: code, stdout } = await captureStdout(() =>
          main(['run', 'tracker.create', '--run-id', runId, '--json'])
        );
        expect(code).toBe(0);
        expect(JSON.parse(stdout.trim()).ok).toBe(true);
      }

      expect(snapshot()).toEqual(before);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test.each([
    ['the --non-interactive flag', (argv) => [...argv, '--non-interactive'], {}],
    ['ENSEMBLE_NON_INTERACTIVE=1', (argv) => argv, { ENSEMBLE_NON_INTERACTIVE: '1' }],
    ['a non-empty FOREMAN_TASK_TITLE', (argv) => argv, { FOREMAN_TASK_TITLE: 'some-task' }],
    ['CI=true', (argv) => argv, { CI: 'true' }]
  ])(
    "AC-011-3: a real unconfirmed adapter with a passing preflight record auto-confirms via main() with %s -- ok:true, logs adapter/source, never writes a confirmation record",
    async (_label, mutateArgv, envOverrides) => {
      const projectRoot = mkTempDir('confirm-wiring-nonint-');
      mkProjectConfig(projectRoot, { tracker: 'fixture-confirm-tracker-nonint' });
      mkInstalledAdapter(projectRoot, 'fixture-confirm-tracker-nonint', {
        capabilities: {
          'tracker.create': { run: [process.execPath, '-e', 'process.stdout.write("{}")'] }
        }
      });

      const runId = 'confirm-wiring-nonint-r1';
      const originalCwd = process.cwd();
      const originalEnvValues = Object.keys(envOverrides).map((name) => [name, process.env[name]]);
      for (const [name, value] of Object.entries(envOverrides)) {
        process.env[name] = value;
      }
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        process.chdir(projectRoot);

        const preflight = await runPreflight(
          { categories: ['tracker'], runId },
          { projectRoot, env: process.env }
        );
        expect(preflight.ok).toBe(true);

        // Zero recordConfirmation calls -- auto-confirm must come entirely from the
        // non-interactive signal, never a stale record.
        const argv = mutateArgv(['run', 'tracker.create', '--run-id', runId, '--json']);
        const { returned: code, stdout } = await captureStdout(() => main(argv));

        expect(code).toBe(0);
        expect(JSON.parse(stdout.trim()).ok).toBe(true);

        const logged = stderrSpy.mock.calls.map((call) => call[0]).join('');
        expect(logged).toContain('fixture-confirm-tracker-nonint');
        expect(logged).toContain('project');

        expect(fs.existsSync(confirmationsDir(projectRoot))).toBe(false);
      } finally {
        stderrSpy.mockRestore();
        process.chdir(originalCwd);
        for (const [name, value] of originalEnvValues) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    }
  );

  test('AC-011-4: a config edit that selects a DIFFERENT adapter for the same category re-requires confirmation on the next main() call', async () => {
    const projectRoot = mkTempDir('confirm-wiring-cfgchange-');
    mkProjectConfig(projectRoot, { tracker: 'fixture-confirm-tracker-cfg-a' });
    mkInstalledAdapter(projectRoot, 'fixture-confirm-tracker-cfg-a', {
      capabilities: {
        'tracker.create': { run: [process.execPath, '-e', 'process.stdout.write("{}")'] }
      }
    });
    mkInstalledAdapter(projectRoot, 'fixture-confirm-tracker-cfg-b', {
      capabilities: {
        'tracker.create': { run: [process.execPath, '-e', 'process.stdout.write("{}")'] }
      }
    });

    const runId = 'confirm-wiring-cfgchange-r1';
    const originalCwd = process.cwd();
    try {
      process.chdir(projectRoot);

      const preflight = await runPreflight(
        { categories: ['tracker'], runId },
        { projectRoot, env: process.env }
      );
      expect(preflight.ok).toBe(true);

      const { returned: confirmCode, stdout: confirmStdout } = await captureStdout(() =>
        main(['confirm-record', 'tracker.create', '--run-id', runId, '--json'])
      );
      expect(confirmCode).toBe(0);
      expect(JSON.parse(confirmStdout.trim()).ok).toBe(true);

      const { returned: codeA, stdout: stdoutA } = await captureStdout(() =>
        main(['run', 'tracker.create', '--run-id', runId, '--json'])
      );
      expect(codeA).toBe(0);
      expect(JSON.parse(stdoutA.trim()).ok).toBe(true);

      // Config change: the project toolchain.yaml's `tracker` entry now selects a genuinely
      // different adapter id -- resolveCategory still returns source:'project', but
      // configHash(adapter, source) depends on `adapter` too, so the stale record for adapter
      // A is never matched for adapter B.
      mkProjectConfig(projectRoot, { tracker: 'fixture-confirm-tracker-cfg-b' });

      const { returned: codeB, stdout: stdoutB } = await captureStdout(() =>
        main(['run', 'tracker.create', '--run-id', runId, '--json'])
      );
      expect(codeB).toBe(1);
      const parsedB = JSON.parse(stdoutB.trim());
      expect(parsedB).toEqual({
        ok: false,
        error: { code: 'CONFIRMATION_REQUIRED', message: expect.any(String) }
      });
      expect(parsedB.error.message).toContain('fixture-confirm-tracker-cfg-b');
    } finally {
      process.chdir(originalCwd);
    }
  });

  test('AC-011-5: a read-only (sideEffect:false) capability needs no confirmation or preflight record via main()', async () => {
    const projectRoot = mkTempDir('confirm-wiring-readonly-');
    mkProjectConfig(projectRoot, { tracker: 'fixture-confirm-tracker-ro' });
    mkInstalledAdapter(projectRoot, 'fixture-confirm-tracker-ro', {
      capabilities: {
        'tracker.show': { run: [process.execPath, '-e', 'process.stdout.write("{}")'] }
      }
    });

    const originalCwd = process.cwd();
    try {
      process.chdir(projectRoot);

      // No runPreflight call, no recordConfirmation call: tracker.show is sideEffect:false per
      // the shipped packages/development/toolchain/categories/tracker.yaml contract, so run()
      // must never reach the PREFLIGHT_REQUIRED or CONFIRMATION_REQUIRED gates for it at all.
      const { returned: code, stdout } = await captureStdout(() =>
        main(['run', 'tracker.show', '--json'])
      );

      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim()).ok).toBe(true);
      expect(fs.existsSync(confirmationsDir(projectRoot))).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe('mutation-proof branches', () => {
  test('isNonInteractive: deleting the ctx.nonInteractive===true branch makes an explicit --non-interactive request fall through to the (unconfirmed) record check instead of auto-confirming', () => {
    const mutantRoot = makeMutantToolchainRoot();
    try {
      const needle = 'if (ctx && ctx.nonInteractive === true) {\n    return true;\n  }';
      const replacement = "if (ctx && ctx.nonInteractive === 'never-matches') {\n    return true;\n  }";
      const mutated = mutateAndRequire(mutantRoot.confirmPath, needle, replacement);

      const projectRoot = mkTempDir('confirm-mutant-nonint-');
      const result = mutated.confirmStatus('tracker', {
        projectRoot,
        env: {},
        nonInteractive: true,
        sideEffect: true,
        adapter: 'fixture-tracker',
        source: 'project',
        runId: 'r-mutant-nonint'
      });

      // With the branch disabled, an explicit nonInteractive:true request is no longer
      // auto-confirmed -- it falls through to the record check and (with no record written)
      // reports confirmed:false, exactly what the real (unmutated) AC-011-3 test above
      // disproves.
      expect(result).toEqual({ confirmed: false, adapter: 'fixture-tracker', source: 'project' });
    } finally {
      mutantRoot.cleanup();
    }
  });

  test('isNonInteractive: deleting the CI===\'true\' branch makes a CI run fall through to the (unconfirmed) record check instead of auto-confirming', () => {
    const mutantRoot = makeMutantToolchainRoot();
    try {
      const needle = "if (env.CI === 'true') {\n    return true;\n  }";
      const replacement = "if (env.CI === 'never-matches') {\n    return true;\n  }";
      const mutated = mutateAndRequire(mutantRoot.confirmPath, needle, replacement);

      const projectRoot = mkTempDir('confirm-mutant-ci-');
      const result = mutated.confirmStatus('tracker', {
        projectRoot,
        env: { CI: 'true' },
        sideEffect: true,
        adapter: 'fixture-tracker',
        source: 'project',
        runId: 'r-mutant-ci'
      });

      expect(result).toEqual({ confirmed: false, adapter: 'fixture-tracker', source: 'project' });
    } finally {
      mutantRoot.cleanup();
    }
  });

  test('confirmStatus: short-circuiting the record-match check to always return confirmed:true removes the CONFIRMATION_REQUIRED deny path entirely', () => {
    const mutantRoot = makeMutantToolchainRoot();
    try {
      const needle =
        '  if (\n' +
        '    parsed &&\n' +
        '    parsed.category === category &&\n' +
        '    parsed.adapter === ctx.adapter &&\n' +
        '    parsed.configHash === hash\n' +
        '  ) {\n' +
        '    return { confirmed: true };\n' +
        '  }';
      const replacement =
        '  return { confirmed: true };\n' +
        '  // eslint-disable-next-line no-unreachable\n' +
        '  if (\n' +
        '    parsed &&\n' +
        '    parsed.category === category &&\n' +
        '    parsed.adapter === ctx.adapter &&\n' +
        '    parsed.configHash === hash\n' +
        '  ) {\n' +
        '    return { confirmed: true };\n' +
        '  }';
      const mutated = mutateAndRequire(mutantRoot.confirmPath, needle, replacement);

      const projectRoot = mkTempDir('confirm-mutant-deny-');
      // Never confirmed for this (category, adapter) pair -- no recordConfirmation call at all.
      const result = mutated.confirmStatus('tracker', {
        projectRoot,
        env: {},
        sideEffect: true,
        adapter: 'fixture-tracker',
        source: 'project',
        runId: 'r-mutant-deny'
      });

      // With the deny path short-circuited away, an UNCONFIRMED adapter is wrongly reported
      // confirmed -- exactly what the real (unmutated) AC-011-1 "before" assertion above
      // disproves.
      expect(result).toEqual({ confirmed: true });
    } finally {
      mutantRoot.cleanup();
    }
  });

  test("isNonInteractive: deleting the ENSEMBLE_NON_INTERACTIVE==='1' branch makes that signal fall through to the (unconfirmed) record check instead of auto-confirming", () => {
    const mutantRoot = makeMutantToolchainRoot();
    try {
      const needle = "if (env.ENSEMBLE_NON_INTERACTIVE === '1') {\n    return true;\n  }";
      const replacement =
        "if (env.ENSEMBLE_NON_INTERACTIVE === 'never-matches') {\n    return true;\n  }";
      const mutated = mutateAndRequire(mutantRoot.confirmPath, needle, replacement);

      const projectRoot = mkTempDir('confirm-mutant-envni-');
      const result = mutated.confirmStatus('tracker', {
        projectRoot,
        env: { ENSEMBLE_NON_INTERACTIVE: '1' },
        sideEffect: true,
        adapter: 'fixture-tracker',
        source: 'project',
        runId: 'r-mutant-envni'
      });

      // With the branch disabled, this explicit AC-011-3 signal is no longer auto-confirmed --
      // it falls through to the (unconfirmed) record check, exactly what the real (unmutated)
      // production-wiring "ENSEMBLE_NON_INTERACTIVE=1" test above disproves.
      expect(result).toEqual({ confirmed: false, adapter: 'fixture-tracker', source: 'project' });
    } finally {
      mutantRoot.cleanup();
    }
  });

  test('isNonInteractive: deleting the FOREMAN_TASK_TITLE branch makes a set task title fall through to the (unconfirmed) record check instead of auto-confirming', () => {
    const mutantRoot = makeMutantToolchainRoot();
    try {
      const needle =
        "if (typeof env.FOREMAN_TASK_TITLE === 'string' && env.FOREMAN_TASK_TITLE.trim() !== '') {\n    return true;\n  }";
      const replacement =
        "if (typeof env.FOREMAN_TASK_TITLE === 'string' && env.FOREMAN_TASK_TITLE.trim() === 'never-matches') {\n    return true;\n  }";
      const mutated = mutateAndRequire(mutantRoot.confirmPath, needle, replacement);

      const projectRoot = mkTempDir('confirm-mutant-foreman-');
      const result = mutated.confirmStatus('tracker', {
        projectRoot,
        env: { FOREMAN_TASK_TITLE: 'some task' },
        sideEffect: true,
        adapter: 'fixture-tracker',
        source: 'project',
        runId: 'r-mutant-foreman'
      });

      // With the branch disabled, this explicit AC-011-3 signal is no longer auto-confirmed --
      // it falls through to the (unconfirmed) record check, exactly what the real (unmutated)
      // production-wiring "a non-empty FOREMAN_TASK_TITLE" test above disproves.
      expect(result).toEqual({ confirmed: false, adapter: 'fixture-tracker', source: 'project' });
    } finally {
      mutantRoot.cleanup();
    }
  });

  test("toolchain-cli run(): forcing the side-effect-only confirmStatus gate to always run would wrongly require confirmation for a sideEffect:false capability", async () => {
    const mutantRoot = makeMutantToolchainRoot();
    try {
      const needle = 'if (sideEffect) {\n    const confirmation = confirmAdapterStatus(category, {';
      const replacement = 'if (true) {\n    const confirmation = confirmAdapterStatus(category, {';
      const mutated = mutateAndRequire(mutantRoot.cliPath, needle, replacement);

      const projectRoot = mkTempDir('confirm-mutant-cli-gate-');
      mkProjectConfig(projectRoot, { tracker: 'fixture-tracker-mutant-gate' });
      mkInstalledAdapter(projectRoot, 'fixture-tracker-mutant-gate', {
        capabilities: {
          'tracker.show': { run: [process.execPath, '-e', 'process.stdout.write("{}")'] }
        }
      });

      const code = await mutated.main(['run', 'tracker.show', '--json'], {
        projectRoot,
        env: {}
      });

      // With the `if (sideEffect)` gate forced always-on, a genuinely read-only
      // (sideEffect:false) capability now routes through confirmAdapterStatus too and, with no
      // confirmation record, is wrongly denied -- exactly what the real (unmutated) AC-011-5
      // "read-only capability needs no confirmation" test above disproves.
      expect(code).toBe(1);
    } finally {
      mutantRoot.cleanup();
    }
  });
});

/**
 * TRD-2026-8d825f54 PR 4 review Finding 3: `effectiveSessionKey` no longer falls back to the
 * literal string `'no-session'` when neither a session id nor a run id is available. With
 * neither key available, `confirmStatus` fails closed to a NAMED unconfirmed reason
 * (`NO_CONFIRM_KEY`) and `recordConfirmation` throws a NAMED error, writing nothing.
 */
describe('Keyless rejection (PR 4 review Finding 3): no shared no-session bucket', () => {
  test('confirmStatus with no session id and no run id returns an unconfirmed, named-reason result and never touches the filesystem', () => {
    const projectRoot = mkTempDir('confirm-keyless-status-');
    const result = confirmStatus('tracker', {
      projectRoot,
      env: {},
      sideEffect: true,
      adapter: 'fixture-tracker',
      source: 'project'
      // runId intentionally omitted.
    });
    expect(result).toEqual({
      confirmed: false,
      required: true,
      reason: 'NO_CONFIRM_KEY',
      adapter: 'fixture-tracker',
      source: 'project'
    });
    expect(fs.existsSync(confirmationsDir(projectRoot))).toBe(false);
  });

  test('recordConfirmation with no session id and no run id throws CONFIRM_KEY_REQUIRED and writes nothing', () => {
    const projectRoot = mkTempDir('confirm-keyless-record-');
    expect(() =>
      recordConfirmation('tracker', {
        projectRoot,
        env: {},
        adapter: 'fixture-tracker',
        source: 'project'
      })
    ).toThrow(expect.objectContaining({ code: 'CONFIRM_KEY_REQUIRED' }));
    expect(fs.existsSync(confirmationsDir(projectRoot))).toBe(false);
  });

  test('a record written under run id A never satisfies a gate checked under run id B', () => {
    const projectRoot = mkTempDir('confirm-runid-isolation-');
    const ctxFor = (runId) => ({
      projectRoot,
      env: {},
      sideEffect: true,
      adapter: 'fixture-tracker',
      source: 'project',
      runId
    });

    const recorded = recordConfirmation('tracker', ctxFor('run-A'));
    expect(recorded).toEqual({ confirmed: true });

    expect(confirmStatus('tracker', ctxFor('run-A'))).toEqual({ confirmed: true });
    expect(confirmStatus('tracker', ctxFor('run-B'))).toEqual({
      confirmed: false,
      adapter: 'fixture-tracker',
      source: 'project'
    });
  });

  test('through the real CLI: confirm-record with neither --run-id nor a session env var is refused with CONFIRM_KEY_REQUIRED, exit 1', async () => {
    const projectRoot = mkTempDir('confirm-keyless-cli-record-');
    mkProjectConfig(projectRoot, { tracker: 'fixture-keyless-cli-tracker' });
    mkInstalledAdapter(projectRoot, 'fixture-keyless-cli-tracker');

    const { returned: code, stdout } = await captureStdout(() =>
      main(['confirm-record', 'tracker.create', '--json'], {
        projectRoot,
        env: {} // no CLAUDE_SESSION_ID/ENSEMBLE_SESSION_ID, no --run-id
      })
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed).toEqual({
      ok: false,
      error: { code: 'CONFIRM_KEY_REQUIRED', message: expect.any(String) }
    });
    expect(fs.existsSync(confirmationsDir(projectRoot))).toBe(false);
  });

  test('through the real CLI: confirm-status with neither --run-id nor a session env var is ok:true with an unconfirmed, named-reason data payload -- never throws', async () => {
    const projectRoot = mkTempDir('confirm-keyless-cli-status-');
    mkProjectConfig(projectRoot, { tracker: 'fixture-keyless-cli-status-tracker' });
    mkInstalledAdapter(projectRoot, 'fixture-keyless-cli-status-tracker');

    const { returned: code, stdout } = await captureStdout(() =>
      main(['confirm-status', 'tracker.create', '--json'], { projectRoot, env: {} })
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual({
      confirmed: false,
      required: true,
      reason: 'NO_CONFIRM_KEY',
      adapter: 'fixture-keyless-cli-status-tracker',
      source: 'project'
    });
  });
});

/**
 * TRD-2026-8d825f54 PR 4 review Finding 3: `confirmStatus`/`recordConfirmation` reject a
 * missing/empty `ctx.adapter`/`ctx.source` BEFORE `configHash` is ever called -- `configHash`
 * is never invoked with a null/undefined operand.
 */
describe('Unknown-selection rejection (PR 4 review Finding 3): never hash a null/undefined source', () => {
  test('confirmStatus with an undefined source fails closed with a named reason, never reaching the filesystem', () => {
    const projectRoot = mkTempDir('confirm-unknown-source-status-');
    const result = confirmStatus('tracker', {
      projectRoot,
      env: {},
      sideEffect: true,
      adapter: 'fixture-tracker',
      source: undefined,
      runId: 'r1'
    });
    expect(result).toEqual({
      confirmed: false,
      required: true,
      reason: 'ADAPTER_SOURCE_REQUIRED',
      adapter: 'fixture-tracker',
      source: undefined
    });
    expect(fs.existsSync(confirmationsDir(projectRoot))).toBe(false);
  });

  test('confirmStatus with an empty-string adapter fails closed with a named reason', () => {
    const result = confirmStatus('tracker', {
      projectRoot: mkTempDir('confirm-unknown-adapter-status-'),
      env: {},
      sideEffect: true,
      adapter: '',
      source: 'project',
      runId: 'r1'
    });
    expect(result.confirmed).toBe(false);
    expect(result.reason).toBe('ADAPTER_SOURCE_REQUIRED');
  });

  test('recordConfirmation with a missing source throws ADAPTER_SOURCE_REQUIRED and writes nothing', () => {
    const projectRoot = mkTempDir('confirm-unknown-source-record-');
    expect(() =>
      recordConfirmation('tracker', {
        projectRoot,
        env: {},
        adapter: 'fixture-tracker',
        runId: 'r1'
        // source intentionally omitted.
      })
    ).toThrow(expect.objectContaining({ code: 'ADAPTER_SOURCE_REQUIRED' }));
    expect(fs.existsSync(confirmationsDir(projectRoot))).toBe(false);
  });
});

/**
 * TRD-2026-8d825f54 PR 4 review Finding 3: a session-key candidate (`ENSEMBLE_SESSION_ID`,
 * `CLAUDE_SESSION_ID`, `ctx.runId`) failing basic shape validation (a NUL byte, an absurd
 * length) is treated exactly like an absent one -- never used, never thrown on.
 */
describe('Session-key validation (PR 4 review Finding 3): NUL bytes and absurd lengths are rejected', () => {
  test('a CLAUDE_SESSION_ID containing a NUL byte is ignored -- with no run id, the result is the keyless NO_CONFIRM_KEY shape, proving the NUL value was never used as a key', () => {
    const projectRoot = mkTempDir('confirm-session-nul-');
    const result = confirmStatus('tracker', {
      projectRoot,
      env: { CLAUDE_SESSION_ID: 'abc\u0000def' },
      sideEffect: true,
      adapter: 'fixture-tracker',
      source: 'project'
    });
    expect(result.reason).toBe('NO_CONFIRM_KEY');
  });

  test('a CLAUDE_SESSION_ID far exceeding the length bound is ignored -- with no run id, the result is the keyless NO_CONFIRM_KEY shape', () => {
    const projectRoot = mkTempDir('confirm-session-oversize-');
    const result = confirmStatus('tracker', {
      projectRoot,
      env: { CLAUDE_SESSION_ID: 'x'.repeat(5000) },
      sideEffect: true,
      adapter: 'fixture-tracker',
      source: 'project'
    });
    expect(result.reason).toBe('NO_CONFIRM_KEY');
  });

  test('a normal, valid CLAUDE_SESSION_ID is used as the session key end to end (record then gate)', () => {
    const projectRoot = mkTempDir('confirm-session-valid-');
    const ctx = {
      projectRoot,
      env: { CLAUDE_SESSION_ID: 'a-real-session-id-123' },
      sideEffect: true,
      adapter: 'fixture-tracker',
      source: 'project'
    };
    expect(recordConfirmation('tracker', ctx)).toEqual({ confirmed: true });
    expect(confirmStatus('tracker', ctx)).toEqual({ confirmed: true });
  });
});

describe('mutation-proof branches: Finding 3 (keyless rejection, unknown-selection rejection, session-key validation)', () => {
  test("restoring the old 'no-session' shared bucket makes two UNRELATED keyless record/status calls collide, even though the real (unmutated) code refuses to record anything keyless at all", () => {
    const mutantRoot = makeMutantToolchainRoot();
    try {
      const needle = '  if (isValidSessionKeyCandidate(ctx.runId)) {\n    return ctx.runId;\n  }\n  return null;';
      const replacement =
        "  if (isValidSessionKeyCandidate(ctx.runId)) {\n    return ctx.runId;\n  }\n  return 'no-session';";
      const mutated = mutateAndRequire(mutantRoot.confirmPath, needle, replacement);

      const projectRootA = mkTempDir('confirm-mutant-nosession-a-');
      const projectRootB = mkTempDir('confirm-mutant-nosession-b-');

      // Two entirely independent keyless contexts (different projectRoot each, standing in for
      // two unrelated callers) recording/checking the SAME (category, adapter, source) tuple.
      const recordedA = mutated.recordConfirmation('tracker', {
        projectRoot: projectRootA,
        env: {},
        adapter: 'fixture-shared-tracker',
        source: 'project'
      });
      expect(recordedA).toEqual({ confirmed: true });

      // projectRootB never recorded anything itself, yet with the shared 'no-session' bucket
      // restored, its confirmationRecordPath hashes to the SAME file (sessionKey is now the
      // literal 'no-session' for both, and `confirmationRecordPath` depends only on
      // (sessionKey, category, adapter, configHash) -- not on projectRoot's identity, only on
      // the path it is read FROM, which differs; so to prove the cross-contamination within one
      // shared state root, check the SAME projectRoot instead.
      const statusSameRoot = mutated.confirmStatus('tracker', {
        projectRoot: projectRootA,
        env: {},
        sideEffect: true,
        adapter: 'fixture-shared-tracker',
        source: 'project'
        // No runId here either -- a SECOND, unrelated keyless caller against the same
        // projectRoot's state dir.
      });
      // With the shared bucket restored, this second, entirely independent keyless caller is
      // wrongly reported confirmed -- exactly what the real (unmutated) "keyless confirmStatus
      // returns NO_CONFIRM_KEY, never confirmed:true" test above disproves.
      expect(statusSameRoot).toEqual({ confirmed: true });
    } finally {
      mutantRoot.cleanup();
    }
  });

  test('removing the keyless check in confirmStatus lets a keyless call fall through to the filesystem path instead of failing closed', () => {
    const mutantRoot = makeMutantToolchainRoot();
    try {
      const needle =
        "  if (effectiveSessionKey(ctx) === null) {\n" +
        "    return {\n" +
        "      confirmed: false,\n" +
        "      required: true,\n" +
        "      reason: 'NO_CONFIRM_KEY',\n" +
        "      adapter: ctx.adapter,\n" +
        "      source: ctx.source,\n" +
        "      ...(ctx.allowlist ? { allowlist: ctx.allowlist } : {})\n" +
        "    };\n" +
        "  }\n";
      const replacement = '';
      const mutated = mutateAndRequire(mutantRoot.confirmPath, needle, replacement);

      const projectRoot = mkTempDir('confirm-mutant-keyless-check-');
      const result = mutated.confirmStatus('tracker', {
        projectRoot,
        env: {},
        sideEffect: true,
        adapter: 'fixture-tracker',
        source: 'project'
        // No runId: with the check removed, `effectiveSessionKey` itself still returns `null`,
        // but `confirmationRecordPath(projectRoot, null, ...)` is now called with a `null`
        // sessionKey, producing a DIFFERENT shape than the real code's NO_CONFIRM_KEY result --
        // exactly what the real (unmutated) "keyless confirmStatus returns NO_CONFIRM_KEY" test
        // above disproves.
      });
      expect(result.reason).not.toBe('NO_CONFIRM_KEY');
    } finally {
      mutantRoot.cleanup();
    }
  });

  test('removing the hasValidSelection check in recordConfirmation lets a missing source be recorded instead of refused', () => {
    const mutantRoot = makeMutantToolchainRoot();
    try {
      const needle =
        "  if (!hasValidSelection(ctx)) {\n" +
        "    const error = new Error(\n" +
        "      `recordConfirmation: category '${category}' needs a resolved adapter and source before ` +\n" +
        "        `it can be recorded (got adapter=${JSON.stringify(ctx.adapter)}, ` +\n" +
        "        `source=${JSON.stringify(ctx.source)})`\n" +
        "    );\n" +
        "    error.code = 'ADAPTER_SOURCE_REQUIRED';\n" +
        "    throw error;\n" +
        "  }\n";
      const replacement = '';
      const mutated = mutateAndRequire(mutantRoot.confirmPath, needle, replacement);

      const projectRoot = mkTempDir('confirm-mutant-selection-check-');
      // With the check removed, this no longer throws -- exactly what the real (unmutated)
      // "recordConfirmation with a missing source throws ADAPTER_SOURCE_REQUIRED" test above
      // disproves.
      expect(() =>
        mutated.recordConfirmation('tracker', {
          projectRoot,
          env: {},
          adapter: 'fixture-tracker',
          runId: 'r1'
        })
      ).not.toThrow();
    } finally {
      mutantRoot.cleanup();
    }
  });

  test('removing the session-key length/NUL validation lets an oversized CLAUDE_SESSION_ID be used directly as a key', () => {
    const mutantRoot = makeMutantToolchainRoot();
    try {
      const needle =
        '  if (isValidSessionKeyCandidate(env.CLAUDE_SESSION_ID)) {\n' +
        '    return env.CLAUDE_SESSION_ID;\n' +
        '  }\n' +
        '  return null;';
      const replacement =
        "  if (typeof env.CLAUDE_SESSION_ID === 'string' && env.CLAUDE_SESSION_ID !== '') {\n" +
        '    return env.CLAUDE_SESSION_ID;\n' +
        '  }\n' +
        '  return null;';
      const mutated = mutateAndRequire(mutantRoot.confirmPath, needle, replacement);

      const projectRoot = mkTempDir('confirm-mutant-session-length-');
      const oversized = 'x'.repeat(5000);
      const result = mutated.confirmStatus('tracker', {
        projectRoot,
        env: { CLAUDE_SESSION_ID: oversized },
        sideEffect: true,
        adapter: 'fixture-tracker',
        source: 'project'
      });
      // With the length guard removed, the oversized value IS used as a real session key, so
      // this reaches the ordinary (record-match) unconfirmed path instead of the keyless
      // NO_CONFIRM_KEY shape -- exactly what the real (unmutated) "oversized CLAUDE_SESSION_ID
      // is ignored" test above disproves.
      expect(result.reason).toBeUndefined();
      expect(result).toEqual({ confirmed: false, adapter: 'fixture-tracker', source: 'project' });
    } finally {
      mutantRoot.cleanup();
    }
  });
});
