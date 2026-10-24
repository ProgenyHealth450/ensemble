'use strict';
/**
 * Tests for TRD-2026-8d825f54 TRD-004: `resolve`/`explain` subcommands of
 * packages/development/lib/toolchain-cli.js (PRD REQ-012, AC-012-1, AC-012-2).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolve, explain, main } = require('../../packages/development/lib/toolchain-cli');
const {
  makeMutantToolchainRoot,
  mutateAndRequire
} = require('./fixtures/toolchain/mutant-toolchain-copy');

const CATEGORIES = [
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

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function mkProjectConfig(projectRoot, yamlContents) {
  const ensembleDir = path.join(projectRoot, '.ensemble');
  fs.mkdirSync(ensembleDir, { recursive: true });
  const configPath = path.join(ensembleDir, 'toolchain.yaml');
  fs.writeFileSync(configPath, yamlContents);
  return configPath;
}

/**
 * Write a fake `.git/config` with a `remote "origin"` URL, standing in for the real
 * repository's remote so an injected `detect` stub below can read it without this module
 * (or the test) building any real detection logic (TRD-016 is not built yet).
 */
function writeFakeGitRemote(projectRoot, remoteUrl) {
  const gitDir = path.join(projectRoot, '.git');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'config'), `[remote "origin"]\n\turl = ${remoteUrl}\n`);
}

/**
 * A test-only stand-in for the TRD-016 detection engine's `host` detection hook: it matches
 * the fake remote URL written by `writeFakeGitRemote` and reports `host:'github'` with
 * `source:'detection'`. Every other category returns `null` so `resolveCategory` falls through
 * to its normal project/user/env-compat/default precedence for them.
 */
function detectHostFromGitRemote(category, ctx) {
  if (category !== 'host') {
    return null;
  }
  const gitConfigPath = path.join(ctx.projectRoot, '.git', 'config');
  if (!fs.existsSync(gitConfigPath)) {
    return null;
  }
  const contents = fs.readFileSync(gitConfigPath, 'utf8');
  if (/github\.com/.test(contents)) {
    return { value: 'github', source: 'detection' };
  }
  return null;
}

function captureStdout(fn) {
  const chunks = [];
  const spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(chunk);
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join('');
}

function captureStderr(fn) {
  const chunks = [];
  const spy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    chunks.push(chunk);
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join('');
}

describe('resolve/explain envelope shape', () => {
  test('resolve(ctx) resolves every one of the 14 categories to the shipped default when no config or detection applies', () => {
    const tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-cli-defaults-'));
    tempDirs.push(tmpProjectDir);

    const result = resolve({ projectRoot: tmpProjectDir, env: {} });

    expect(result.ok).toBe(true);
    expect(Object.keys(result.data).sort()).toEqual([...CATEGORIES].sort());
    for (const category of CATEGORIES) {
      expect(typeof result.data[category].adapter).toBe('string');
      expect(typeof result.data[category].source).toBe('string');
    }
  });

  test('resolve(ctx) returns {ok:false, error:{code:"RESOLVE_FAILED", message}} instead of throwing when resolveCategory throws', () => {
    const tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-cli-invalid-'));
    tempDirs.push(tmpProjectDir);
    mkProjectConfig(tmpProjectDir, 'notACategory: nope\n');

    const result = resolve({ projectRoot: tmpProjectDir, env: {} });

    expect(result).toEqual({
      ok: false,
      error: { code: 'RESOLVE_FAILED', message: expect.any(String) }
    });
  });
});

/**
 * TRD-2026-8d825f54 TRD-004: explain output in human and machine-readable form (PRD REQ-012,
 * AC-012-1, AC-012-2).
 *
 * Scenario: Explain shows adapter and source -- Given a project with detection-resolved
 * adapters, When explain runs, Then each category shows adapter and source (for example
 * "detection").
 *
 * Scenario: Explain structured output -- Given the structured-output option, When explain runs,
 * Then the same fields appear in machine-readable form.
 */
describe('TRD-004-TEST: explain output in human and machine-readable form', () => {
  test('Scenario: Explain shows adapter and source -- host resolves via an injected detection hook with source "detection"', () => {
    const tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-cli-explain-detect-'));
    tempDirs.push(tmpProjectDir);
    writeFakeGitRemote(tmpProjectDir, 'git@github.com:acme/widget.git');

    const result = explain({
      projectRoot: tmpProjectDir,
      env: {},
      detect: detectHostFromGitRemote
    });

    expect(result.ok).toBe(true);
    expect(result.data.host).toEqual({ adapter: 'github', source: 'detection' });
  });

  test('Scenario: Explain structured output -- explain --json stdout parses as JSON and matches the human table for every category, including detection-sourced host', () => {
    const tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-cli-explain-json-'));
    tempDirs.push(tmpProjectDir);
    writeFakeGitRemote(tmpProjectDir, 'git@github.com:acme/widget.git');

    const ctx = { projectRoot: tmpProjectDir, env: {}, detect: detectHostFromGitRemote };

    let jsonCode;
    const jsonOutput = captureStdout(() => {
      jsonCode = main(['explain', '--json'], ctx);
    });
    expect(jsonCode).toBe(0);

    const parsed = JSON.parse(jsonOutput);
    expect(parsed.ok).toBe(true);
    expect(Object.keys(parsed.data).sort()).toEqual([...CATEGORIES].sort());
    expect(parsed.data.host).toEqual({ adapter: 'github', source: 'detection' });

    let humanCode;
    const humanOutput = captureStdout(() => {
      humanCode = main(['explain'], ctx);
    });
    expect(humanCode).toBe(0);
    expect(humanOutput).toMatch(/category\s+adapter\s+source/);

    for (const category of CATEGORIES) {
      const { adapter, source } = parsed.data[category];
      expect(humanOutput).toContain(category);
      expect(humanOutput).toContain(adapter);
      expect(humanOutput).toContain(source);
    }
  });
});

/**
 * TRD-2026-8d825f54 TRD-004: unknown subcommand handling (PRD REQ-012).
 *
 * Scenario: Unknown subcommand fails -- Given an unknown subcommand, When toolchain-cli runs,
 * Then it exits non-zero with a JSON error {ok:false,error:{code,message}} when --json is set,
 * and a human error line on stderr when it is not.
 */
describe('TRD-004-TEST: unknown subcommand handling', () => {
  test('Scenario: Unknown subcommand fails -- --json prints {ok:false,error:{code,message}} to stdout and returns 1', () => {
    let code;
    const output = captureStdout(() => {
      code = main(['bogus', '--json']);
    });

    expect(code).toBe(1);
    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error.code).toBe('string');
    expect(typeof parsed.error.message).toBe('string');
    expect(parsed.error.message).toContain('bogus');
  });

  test('Scenario: Unknown subcommand fails -- without --json prints a human error line to stderr and returns 1', () => {
    let code;
    const output = captureStderr(() => {
      code = main(['bogus']);
    });

    expect(code).toBe(1);
    expect(output).toContain('bogus');
  });

  test('Scenario: Unknown subcommand fails -- a missing subcommand is treated the same way', () => {
    let code;
    const output = captureStdout(() => {
      code = main(['--json']);
    });

    expect(code).toBe(1);
    const parsed = JSON.parse(output);
    expect(parsed).toEqual({
      ok: false,
      error: { code: 'UNKNOWN_SUBCOMMAND', message: expect.any(String) }
    });
  });
});

/**
 * TRD-2026-8d825f54 TRD-004: resolution performance budget (PRD REQ-012; Quality
 * Requirements: 500 ms resolution budget).
 *
 * Scenario: Resolution stays within budget -- Given a 1,000-file fixture repo with project
 * config, When resolve --json (no health checks) runs five times, Then the median duration
 * is under 500 ms.
 */
describe('TRD-004-TEST: resolve performance budget', () => {
  test('Scenario: Resolution stays within budget -- median of five resolve() calls over a 1,000-file fixture repo is under 500ms', () => {
    const tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-cli-perf-'));
    tempDirs.push(tmpProjectDir);

    mkProjectConfig(tmpProjectDir, 'tracker: beads\nhost: github\n');

    const fixtureFilesDir = path.join(tmpProjectDir, 'src');
    fs.mkdirSync(fixtureFilesDir, { recursive: true });
    for (let i = 0; i < 1000; i += 1) {
      fs.writeFileSync(path.join(fixtureFilesDir, `file-${i}.txt`), `fixture file ${i}\n`);
    }
    expect(fs.readdirSync(fixtureFilesDir).length).toBeGreaterThanOrEqual(1000);

    const ctx = { projectRoot: tmpProjectDir, env: {} };
    const durationsMs = [];

    for (let i = 0; i < 5; i += 1) {
      const start = process.hrtime.bigint();
      const result = resolve(ctx);
      const end = process.hrtime.bigint();
      expect(result.ok).toBe(true);
      durationsMs.push(Number(end - start) / 1e6);
    }

    const sorted = [...durationsMs].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    expect(median).toBeLessThan(500);
  }, 10000);
});

/**
 * Installs a minimal, always-successful `tracker.show` adapter under `projectRoot`, so a
 * `run` call that reaches adapter resolution (as a mutated, weakened `parseArgs` would wrongly
 * let through) actually completes `ok:true`/exit 0 -- making "did parseArgs stop this before
 * resolving anything" an observable `code` difference, not just an internal detail.
 */
function mkRunnableTrackerProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-cli-parseargs-'));
  tempDirs.push(projectRoot);
  mkProjectConfig(projectRoot, 'tracker: fixture-parseargs-tracker\n');
  const skillDir = path.join(projectRoot, 'packages', 'fixture-pkg', 'skills', 'fixture-parseargs-tracker');
  fs.mkdirSync(skillDir, { recursive: true });
  const yaml = require('js-yaml');
  const manifest = {
    adapter: 'fixture-parseargs-tracker',
    version: '1.0.0',
    categories: ['tracker'],
    contract: { tracker: '1.0' },
    binaries: [process.execPath],
    allowlist: [{ bin: process.execPath, sub: ['-e'] }],
    env: [],
    health: [],
    detect: [],
    capabilities: {
      'tracker.show': { run: [process.execPath, '-e', 'process.stdout.write("ok")'] }
    }
  };
  fs.writeFileSync(path.join(skillDir, 'adapter.yaml'), yaml.dump(manifest));
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# fixture-parseargs-tracker\n');
  return projectRoot;
}

describe('parseArgs (reviewer Finding 5): --run-id/--arg strict validation', () => {
  test('--run-id with nothing after it is INVALID_ARG naming the flag, not a silent undefined runId', async () => {
    const projectRoot = mkRunnableTrackerProject();
    let stdout = '';
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      stdout += chunk;
      return true;
    };
    let code;
    try {
      code = await main(['run', 'tracker.show', '--run-id', '--json'], { projectRoot, env: {} });
    } finally {
      process.stdout.write = original;
    }
    expect(code).toBe(1);
    // Asserting the exact code (not just a non-zero exit) matters here: `run()`'s OWN
    // charset check (reviewer Finding 3 round 2) would ALSO reject '--json' as a run id value
    // if it ever reached that far, but with a DIFFERENT code (INVALID_RUN_ID). This must be
    // parseArgs's own guard firing FIRST, before `run()` is ever called.
    expect(JSON.parse(stdout.trim()).error.code).toBe('INVALID_ARG');
  });

  test('--run-id immediately followed by another flag is INVALID_ARG, never silently takes the flag as its value', async () => {
    const projectRoot = mkRunnableTrackerProject();
    let stdout = '';
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      stdout += chunk;
      return true;
    };
    let code;
    try {
      code = await main(['run', 'tracker.show', '--run-id', '--arg', 'id=x', '--json'], {
        projectRoot,
        env: {}
      });
    } finally {
      process.stdout.write = original;
    }
    expect(code).toBe(1);
    expect(JSON.parse(stdout.trim()).error.code).toBe('INVALID_ARG');
  });

  test('--arg with nothing after it is INVALID_ARG, never silently dropped', async () => {
    const projectRoot = mkRunnableTrackerProject();
    const code = await main(['run', 'tracker.show', '--arg', '--json'], { projectRoot, env: {} });
    expect(code).toBe(1);
  });

  test("--arg 'oops' (no '=') is INVALID_ARG naming the malformed value, never silently dropped", async () => {
    const projectRoot = mkRunnableTrackerProject();
    const code = await main(['run', 'tracker.show', '--arg', 'oops', '--json'], {
      projectRoot,
      env: {}
    });
    expect(code).toBe(1);
  });

  test("--arg '=v' (empty key) is INVALID_ARG, never silently dropped", async () => {
    const projectRoot = mkRunnableTrackerProject();
    const code = await main(['run', 'tracker.show', '--arg', '=v', '--json'], {
      projectRoot,
      env: {}
    });
    expect(code).toBe(1);
  });

  test('a well-formed --run-id and --arg still work exactly as before (regression guard)', async () => {
    const projectRoot = mkRunnableTrackerProject();
    const code = await main(['run', 'tracker.show', '--run-id', 'r1', '--arg', 'id=x', '--json'], {
      projectRoot,
      env: {}
    });
    expect(code).toBe(0);
  });

  test('the JSON envelope for an INVALID_ARG error is printed when --json is present anywhere in argv', async () => {
    const projectRoot = mkRunnableTrackerProject();
    let stdout = '';
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      stdout += chunk;
      return true;
    };
    try {
      await main(['run', 'tracker.show', '--arg', 'oops', '--json'], { projectRoot, env: {} });
    } finally {
      process.stdout.write = original;
    }
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('INVALID_ARG');
  });
});

describe('mutation-restore proof: reviewer Finding 5 actually discriminates', () => {
  test("removing the --run-id flag-like-value guard lets parseArgs's own INVALID_ARG attribution disappear (reviewer Finding 3's later charset check still blocks it, but with a different code)", async () => {
    const mutantRoot = makeMutantToolchainRoot();
    try {
      const needle =
        "      const value = rest[i + 1];\n" +
        "      if (typeof value !== 'string' || value.startsWith('--')) {\n" +
        "        return invalidArg(\n" +
        "          `--run-id requires a value (got ${value === undefined ? 'nothing' : JSON.stringify(value)})`\n" +
        "        );\n" +
        "      }\n" +
        "      runId = value;";
      const replacement = "      const value = rest[i + 1];\n      runId = value;";
      const mutatedCli = mutateAndRequire(mutantRoot.cliPath, needle, replacement);

      const projectRoot = mkRunnableTrackerProject();
      let stdout = '';
      const original = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk) => {
        stdout += chunk;
        return true;
      };
      try {
        await mutatedCli.main(['run', 'tracker.show', '--run-id', '--json'], {
          projectRoot,
          env: {}
        });
      } finally {
        process.stdout.write = original;
      }
      // With parseArgs's own guard removed, `--run-id` silently swallows '--json' as its
      // "value"; the run() handler's separate charset check (reviewer Finding 3 round 2)
      // still rejects it defense-in-depth, but as 'INVALID_RUN_ID', never the 'INVALID_ARG'
      // parseArgs itself is supposed to report -- exactly what the real (unmutated) "INVALID_ARG
      // naming the flag" test above disproves (it asserts error.code === 'INVALID_ARG').
      expect(JSON.parse(stdout.trim()).error.code).toBe('INVALID_RUN_ID');
    } finally {
      mutantRoot.cleanup();
    }
  });

  test("removing the --arg malformed-pair guard lets 'oops' (no '=') silently proceed instead of erroring", async () => {
    const mutantRoot = makeMutantToolchainRoot();
    try {
      const needle =
        "      const pair = rest[i + 1];\n" +
        "      if (typeof pair !== 'string' || pair.startsWith('--')) {\n" +
        "        return invalidArg(\n" +
        "          `--arg requires a 'key=value' value (got ${pair === undefined ? 'nothing' : JSON.stringify(pair)})`\n" +
        "        );\n" +
        "      }\n" +
        "      const eqIndex = pair.indexOf('=');\n" +
        "      if (eqIndex <= 0) {\n" +
        "        return invalidArg(`--arg value ${JSON.stringify(pair)} is not in 'key=value' form`);\n" +
        "      }\n" +
        "      args[pair.slice(0, eqIndex)] = pair.slice(eqIndex + 1);";
      const replacement =
        "      const pair = rest[i + 1];\n" +
        "      if (typeof pair === 'string') {\n" +
        "        const eqIndex = pair.indexOf('=');\n" +
        "        if (eqIndex > 0) { args[pair.slice(0, eqIndex)] = pair.slice(eqIndex + 1); }\n" +
        "      }";
      const mutatedCli = mutateAndRequire(mutantRoot.cliPath, needle, replacement);

      const projectRoot = mkRunnableTrackerProject();
      const code = await mutatedCli.main(['run', 'tracker.show', '--arg', 'oops', '--json'], {
        projectRoot,
        env: {}
      });
      // With the guard removed, a malformed '--arg oops' is silently dropped (old behavior) and
      // the capability still runs to completion (exit 0) -- exactly what the real (unmutated)
      // "INVALID_ARG naming the malformed value" test above disproves.
      expect(code).toBe(0);
    } finally {
      mutantRoot.cleanup();
    }
  });
});
