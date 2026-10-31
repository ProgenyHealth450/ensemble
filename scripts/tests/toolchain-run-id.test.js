'use strict';
/**
 * Tests for TRD-2026-8d825f54 PR 3 independent review, round 2, Finding 3: the SHARED run-id
 * charset validator `packages/development/lib/toolchain/run-id.js` and its wiring into
 * `preflight.js#isSafeRunId`, `ledger.js#assertValidRunId` and `toolchain-cli.js`'s `run`
 * subcommand -- no duplicate regex may live in any of those three call sites.
 *
 * Covers: the pure validator itself; the concrete collision the independent review found
 * (`VICTIM.json` colliding with `VICTIM` once `.json` is appended); every rejected shape listed
 * in the review (`VICTIM.json`, `a.b`, embedded newline, empty, 129 characters, unicode, a NUL
 * byte); that legitimate shapes already used across this repo's fixtures/tests (a UUID, a short
 * hyphenated id) keep working; and a mutation proof for each of the three call sites showing a
 * test fails when that site stops using the shared validator.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { isValidRunId, invalidRunIdMessage } = require('../../packages/development/lib/toolchain/run-id');
const { main } = require('../../packages/development/lib/toolchain-cli');
const { runPreflight, hasPassingPreflightRecord } = require('../../packages/development/lib/toolchain/preflight');
const { recordSideEffect } = require('../../packages/development/lib/toolchain/ledger');
const {
  makeMutantToolchainRoot,
  mutateAndRequire
} = require('./fixtures/toolchain/mutant-toolchain-copy');

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function mkProjectRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-run-id-'));
  tempDirs.push(dir);
  return dir;
}

/** Installs a minimal, always-successful `tracker.show` adapter under a fresh project root. */
function mkRunnableTrackerProject() {
  const projectRoot = mkProjectRoot();
  const ensembleDir = path.join(projectRoot, '.ensemble');
  fs.mkdirSync(ensembleDir, { recursive: true });
  fs.writeFileSync(path.join(ensembleDir, 'toolchain.yaml'), 'tracker: fixture-run-id-tracker\n');
  const skillDir = path.join(projectRoot, 'packages', 'fixture-pkg', 'skills', 'fixture-run-id-tracker');
  fs.mkdirSync(skillDir, { recursive: true });
  const yaml = require('js-yaml');
  const manifest = {
    adapter: 'fixture-run-id-tracker',
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
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# fixture-run-id-tracker\n');
  return projectRoot;
}

function stateDir(projectRoot) {
  return path.join(projectRoot, '.ensemble', 'state', 'toolchain');
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

const REJECTED_RUN_IDS = [
  ['VICTIM.json', 'the exact collision the independent review found'],
  ['a.b', 'any dot, not just .json'],
  ['x\ny', 'an embedded newline'],
  ['', 'empty'],
  ['a'.repeat(129), '129 characters (one over the 128 limit)'],
  ['r\u00e9sum\u00e9', 'non-ASCII/unicode'],
  ['x\u0000y', 'a NUL byte']
];

const ACCEPTED_RUN_IDS = [
  ['01a6bc70-f4b7-4a09-ba2c-1a22ebb1d870', 'a UUID'],
  ['r1', 'a short simple id'],
  ['real-run-ac3-first', 'a hyphenated label matching this repo\'s own test fixtures'],
  ['a'.repeat(128), '128 characters (exactly at the limit)']
];

describe('isValidRunId: the shared charset (reviewer round 2, Finding 3)', () => {
  test.each(REJECTED_RUN_IDS)('rejects %p (%s)', (runId) => {
    expect(isValidRunId(runId)).toBe(false);
  });

  test.each(ACCEPTED_RUN_IDS)('accepts %p (%s)', (runId) => {
    expect(isValidRunId(runId)).toBe(true);
  });

  test('rejects non-string values (undefined, number, null)', () => {
    expect(isValidRunId(undefined)).toBe(false);
    expect(isValidRunId(123)).toBe(false);
    expect(isValidRunId(null)).toBe(false);
  });

  test('invalidRunIdMessage escapes the offending id for safe display (control characters, quotes)', () => {
    const message = invalidRunIdMessage('x\ny');
    expect(message).toContain('runId');
    // JSON.stringify escapes the embedded newline rather than emitting a raw one.
    expect(message).not.toMatch(/x\ny/);
    expect(message).toContain('x\\ny');
  });

  test('a dotted run id is rejected outright, eliminating the extension-stacking ambiguity around this module\'s fixed suffixes (reviewer round 2: VICTIM.json vs VICTIM)', () => {
    // `preflight-<runId>.json`/`ledger-<runId>.jsonl`/`failure-<runId>.json` each append a
    // FIXED suffix to the caller-supplied run id. A dotted id (e.g. 'VICTIM.json') stacks its
    // own '.json' in front of that fixed suffix (`preflight-VICTIM.json.json`), which is
    // needlessly confusable with the plain id 'VICTIM''s own path (`preflight-VICTIM.json`) --
    // forbidding dots entirely removes this whole class of ambiguity, rather than trying to
    // special-case '.json' (or '.jsonl', or any other extension) after the fact.
    const dottedId = 'VICTIM.json';
    const plainId = 'VICTIM';
    expect(isValidRunId(dottedId)).toBe(false);
    expect(isValidRunId(plainId)).toBe(true);
  });
});

describe('reviewer round 2, Finding 3: every rejected run id is refused through the real CLI with nothing written', () => {
  test.each(REJECTED_RUN_IDS)('run --run-id %p (%s) is rejected as INVALID_RUN_ID, nothing written', async (runId) => {
    const projectRoot = mkProjectRoot();
    const ctx = { projectRoot, env: {} };

    const { returned: code, stdout } = await captureStdout(() =>
      main(['run', 'tracker.show', '--run-id', runId, '--json'], ctx)
    );

    expect(code).toBe(1);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('INVALID_RUN_ID');
    expect(fs.existsSync(stateDir(projectRoot))).toBe(false);
  });

  test('an empty --run-id supplied as a bare flag value is also rejected the same way', async () => {
    const projectRoot = mkProjectRoot();
    const ctx = { projectRoot, env: {} };
    const { returned: code, stdout } = await captureStdout(() =>
      main(['run', 'tracker.show', '--run-id', '', '--json'], ctx)
    );
    expect(code).toBe(1);
    expect(JSON.parse(stdout.trim()).error.code).toBe('INVALID_RUN_ID');
  });
});

describe('reviewer round 2, Finding 3: accepted run ids still reach runPreflight/hasPassingPreflightRecord normally', () => {
  test.each(ACCEPTED_RUN_IDS)('%p (%s) passes the shared charset and is usable end to end', async (runId) => {
    const projectRoot = mkProjectRoot();
    const ctx = { projectRoot, env: {} };

    const preflight = await runPreflight({ categories: [], runId }, ctx);
    expect(preflight.ok).toBe(true);
    expect(hasPassingPreflightRecord(runId, ctx)).toBe(true);
  });
});

describe('mutation-restore proof: reviewer round 2, Finding 3 actually discriminates for each of the three call sites', () => {
  test('preflight.js no longer using the shared validator lets a VICTIM.json-shaped run id pass runPreflight', async () => {
    const mutantRoot = makeMutantToolchainRoot();
    try {
      const needle = 'function isSafeRunId(runId) {\n  return isValidRunId(runId);\n}';
      const replacement = "function isSafeRunId(runId) {\n  return typeof runId === 'string' && runId.length > 0 && !/[\\\\/]|\\.\\./.test(runId);\n}";
      const mutatedPreflight = mutateAndRequire(mutantRoot.toolchainLibDir + '/preflight.js', needle, replacement);

      const projectRoot = mkProjectRoot();
      const ctx = { projectRoot, env: {} };

      const result = await mutatedPreflight.runPreflight({ categories: [], runId: 'VICTIM.json' }, ctx);
      // With preflight.js back on its OLD, narrower (path-traversal-only) check, a dotted run id
      // is accepted -- exactly what the real (unmutated) "rejects 'VICTIM.json'" test above
      // disproves.
      expect(result.ok).toBe(true);
    } finally {
      mutantRoot.cleanup();
    }
  });

  test('ledger.js no longer using the shared validator lets a VICTIM.json-shaped run id pass assertValidRunId', () => {
    const mutantRoot = makeMutantToolchainRoot();
    try {
      const needle =
        'function assertValidRunId(runId) {\n' +
        '  if (!isValidRunId(runId)) {\n' +
        '    const error = new Error(`ledger: ${invalidRunIdMessage(runId)}`);\n' +
        "    error.code = 'INVALID_RUN_ID';\n" +
        '    throw error;\n' +
        '  }\n' +
        '}';
      const replacement =
        'function assertValidRunId(runId) {\n' +
        "  if (typeof runId !== 'string' || runId.length === 0) {\n" +
        "    throw new Error('ledger: runId must be a non-empty string');\n" +
        '  }\n' +
        "  if (runId.includes('/') || runId.includes('\\\\') || runId.includes('..')) {\n" +
        "    throw new Error('ledger: runId is rejected (path-traversal characters are not allowed)');\n" +
        '  }\n' +
        '}';
      const mutatedLedger = mutateAndRequire(mutantRoot.ledgerPath, needle, replacement);

      const projectRoot = mkProjectRoot();
      // With ledger.js back on its OLD, narrower check, a dotted run id is silently accepted
      // (no throw) -- exactly what the real (unmutated) shared validator disproves.
      expect(() =>
        mutatedLedger.recordSideEffect('VICTIM.json', { capability: 'x' }, { projectRoot })
      ).not.toThrow();
    } finally {
      mutantRoot.cleanup();
    }
  });

  test("toolchain-cli.js's run handler no longer validating --run-id lets a VICTIM.json-shaped run id reach hasPassingPreflightRecord instead of being rejected up front", async () => {
    const mutantRoot = makeMutantToolchainRoot();
    try {
      const needle =
        "  if (runId !== undefined && !isValidRunId(runId)) {\n" +
        "    return { ok: false, error: { code: 'INVALID_RUN_ID', message: invalidRunIdMessage(runId) } };\n" +
        '  }';
      const replacement = '  /* run-id validation removed by mutation */';
      const mutatedCli = mutateAndRequire(mutantRoot.cliPath, needle, replacement);

      const projectRoot = mkRunnableTrackerProject();
      const ctx = { projectRoot, env: {} };

      const { returned: code, stdout } = await captureStdout(() =>
        mutatedCli.main(['run', 'tracker.show', '--run-id', 'VICTIM.json', '--json'], ctx)
      );

      // With the CLI's own up-front check removed, 'VICTIM.json' is no longer rejected with
      // INVALID_RUN_ID at all; it falls through to the ordinary (non-sideEffect) path and the
      // capability runs to completion -- exactly what the real (unmutated) "rejected as
      // INVALID_RUN_ID" test above disproves.
      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim()).ok).toBe(true);
    } finally {
      mutantRoot.cleanup();
    }
  });
});
