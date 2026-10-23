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
      source: 'project'
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
  // flip the CLI into non-interactive auto-confirm, defeating the CONFIRMATION_REQUIRED
  // assertion below -- explicitly cleared for the duration of this describe block so the test
  // is deterministic regardless of the actual CI/host environment.
  const CONTROLLED_ENV_VARS = [
    'CI',
    'ENSEMBLE_NON_INTERACTIVE',
    'FOREMAN_TASK_TITLE',
    'CLAUDE_SESSION_ID',
    'ENSEMBLE_SESSION_ID'
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
        source: 'project'
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
        source: 'project'
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
        source: 'project'
      });

      // With the deny path short-circuited away, an UNCONFIRMED adapter is wrongly reported
      // confirmed -- exactly what the real (unmutated) AC-011-1 "before" assertion above
      // disproves.
      expect(result).toEqual({ confirmed: true });
    } finally {
      mutantRoot.cleanup();
    }
  });
});
