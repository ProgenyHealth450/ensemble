'use strict';
/**
 * Tests for the capability-id existence gate (TRD-022 Implementation AC 1/2):
 * scripts/lib/capability-ids-check.js cross-references a command YAML's
 * `metadata.capabilities.{required,optional}` ids against the real category
 * contracts in packages/development/toolchain/categories/*.yaml.
 *
 * Mutation proofs below operate on a fresh os.tmpdir() copy of
 * scripts/lib/capability-ids-check.js (never the live repo source), one per test, via
 * mutateAndRequireCheck -- mirroring scripts/tests/fixtures/toolchain/mutant-toolchain-copy.js's
 * mutateAndRequire pattern at the scale this single, dependency-free module needs.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadValidCapabilityIds, checkCapabilityIds, checkCapabilityInvocationDrift } = require('../lib/capability-ids-check');

const REAL_FILE = path.resolve(__dirname, '..', 'lib', 'capability-ids-check.js');

/**
 * Apply a single, mandatory string replacement to a fresh /tmp copy of
 * scripts/lib/capability-ids-check.js and `require()` the result. Throws if `needle` is not
 * found, so a mutation test fails loudly instead of silently no-op'ing when the real source
 * has since changed.
 */
function mutateAndRequireCheck(needle, replacement) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-ids-check-mutant-'));
  const nodeModulesLink = path.join(tmpDir, 'node_modules');
  try {
    // js-yaml is required at the top of the real file (unrelated to what any of these
    // mutations touch); symlink the repo's real, hoisted node_modules so it resolves -- same
    // pattern scripts/tests/fixtures/toolchain/mutant-toolchain-copy.js uses, at this
    // single-file scale.
    fs.symlinkSync(path.resolve(__dirname, '..', '..', 'node_modules'), nodeModulesLink, 'dir');

    const tmpFile = path.join(tmpDir, 'capability-ids-check.js');
    const original = fs.readFileSync(REAL_FILE, 'utf8');
    if (!original.includes(needle)) {
      throw new Error(`mutateAndRequireCheck: needle not found: ${JSON.stringify(needle)}`);
    }
    const mutated = original.replace(needle, replacement);
    if (mutated === original) {
      throw new Error('mutateAndRequireCheck: replacement produced no change');
    }
    fs.writeFileSync(tmpFile, mutated);
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(tmpFile);
  } finally {
    // Remove the symlink itself first (never follow it into the real node_modules it points
    // at), then the rest of the copy -- even when the body above threw (a stale needle, a
    // broken mutant), so a failing test never leaks a temp dir.
    try {
      fs.rmSync(nodeModulesLink, { force: true });
    } catch {
      // already gone
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const REAL_CATEGORIES_DIR = path.resolve(__dirname, '..', '..', 'packages', 'development', 'toolchain', 'categories');

describe('loadValidCapabilityIds', () => {
  test('collects real ids from every category contract, e.g. tracker.show and work-graph.ready', () => {
    const knownIds = loadValidCapabilityIds(REAL_CATEGORIES_DIR);
    expect(knownIds.has('tracker.show')).toBe(true);
    expect(knownIds.has('work-graph.ready')).toBe(true);
    expect(knownIds.has('tracker.nonexistent')).toBe(false);
  });
});

describe('checkCapabilityIds', () => {
  const validIds = new Set(['tracker.show', 'work-graph.ready']);

  // Implementation AC 1: a command declaring only known ids passes.
  test('passes when every required/optional id is known', () => {
    const commandData = {
      metadata: { capabilities: { required: ['tracker.show'], optional: ['work-graph.ready'] } }
    };
    expect(checkCapabilityIds(commandData, 'packages/development/commands/fix-issue.yaml', validIds)).toEqual([]);
  });

  test('passes when metadata.capabilities is absent entirely', () => {
    expect(checkCapabilityIds({ metadata: {} }, 'packages/development/commands/fix-issue.yaml', validIds)).toEqual([]);
  });

  // Implementation AC 2: an unknown id fails naming the command file and the id.
  test('fails naming the command file and the unknown id for an unknown required id', () => {
    const commandData = { metadata: { capabilities: { required: ['tracker.nonexistent'] } } };
    const failures = checkCapabilityIds(commandData, 'packages/development/commands/fix-issue.yaml', validIds);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('packages/development/commands/fix-issue.yaml');
    expect(failures[0]).toContain('tracker.nonexistent');
  });

  test('fails naming the command file and the unknown id for an unknown optional id', () => {
    const commandData = { metadata: { capabilities: { optional: ['lint.nonexistent'] } } };
    const failures = checkCapabilityIds(commandData, 'packages/development/commands/fix-issue.yaml', validIds);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('packages/development/commands/fix-issue.yaml');
    expect(failures[0]).toContain('lint.nonexistent');
  });

  test('reports one failure per unknown id, leaving known ids silently accepted', () => {
    const commandData = {
      metadata: { capabilities: { required: ['tracker.show', 'tracker.bogus'], optional: ['work-graph.ready', 'ci-local.bogus'] } }
    };
    const failures = checkCapabilityIds(commandData, 'f.yaml', validIds);
    expect(failures).toHaveLength(2);
    expect(failures.some(m => m.includes('tracker.bogus'))).toBe(true);
    expect(failures.some(m => m.includes('ci-local.bogus'))).toBe(true);
  });
});

describe('checkCapabilityIds: format check', () => {
  const validIds = new Set(['tracker.show']);

  test('fails naming the command file and the offending value for an id that does not match the <category>.<capability> pattern', () => {
    const commandData = { metadata: { capabilities: { required: ['Tracker.Show'] } } };
    const failures = checkCapabilityIds(commandData, 'f.yaml', validIds);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('f.yaml');
    expect(failures[0]).toContain('Tracker.Show');
    expect(failures[0]).toMatch(/not a valid/);
  });

  test('MUTATION PROOF: removing the format check lets a malformed id fall through to the unknown-id message instead of a format error', () => {
    const mutated = mutateAndRequireCheck(
      "typeof id !== 'string' || !CAPABILITY_ID_RE.test(id)",
      'false'
    );
    const commandData = { metadata: { capabilities: { required: ['Tracker.Show'] } } };
    const failures = mutated.checkCapabilityIds(commandData, 'f.yaml', validIds);
    // Without the format branch, the malformed id just flows into the unknown-id check instead
    // (validIds has no 'Tracker.Show' entry either) -- a DIFFERENT message than the real code's
    // format error, proving the real test above is sensitive to this mutation.
    expect(failures).toHaveLength(1);
    expect(failures[0]).not.toMatch(/not a valid/);
    expect(failures[0]).toContain('unknown capability id');
  });
});

describe('checkCapabilityIds: wrong type', () => {
  const validIds = new Set(['tracker.show']);

  test('fails naming the field and the actual typeof when required is a bare string instead of an array', () => {
    const commandData = { metadata: { capabilities: { required: 'tracker.show' } } };
    const failures = checkCapabilityIds(commandData, 'f.yaml', validIds);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('f.yaml');
    expect(failures[0]).toContain('metadata.capabilities.required');
    expect(failures[0]).toContain('must be an array');
    expect(failures[0]).toContain('string');
  });

  test('MUTATION PROOF: removing the Array.isArray guard lets a string required value crash downstream instead of reporting one clear type error', () => {
    const mutated = mutateAndRequireCheck('!Array.isArray(raw)', 'false');
    const commandData = { metadata: { capabilities: { required: 'tracker.show' } } };
    // Without the type guard, 'tracker.show' (a string) is assigned straight into
    // listsByField.required; the cross-list check further down calls
    // `listsByField.required.filter(...)`, which does not exist on a string and throws --
    // the real code never throws for this input (it returns one clear type-error message
    // instead), so this proves the real test above is sensitive to removing the guard.
    expect(() => mutated.checkCapabilityIds(commandData, 'f.yaml', validIds)).toThrow(/filter is not a function/);
  });
});

describe('checkCapabilityIds: duplicates within one list', () => {
  const validIds = new Set(['tracker.show']);

  test('fails naming the repeated id when required lists the same id twice', () => {
    const commandData = { metadata: { capabilities: { required: ['tracker.show', 'tracker.show'] } } };
    const failures = checkCapabilityIds(commandData, 'f.yaml', validIds);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('f.yaml');
    expect(failures[0]).toContain('tracker.show');
    expect(failures[0]).toContain('more than once');
  });

  test('MUTATION PROOF: removing the duplicate check accepts a repeated id silently', () => {
    const mutated = mutateAndRequireCheck('seen.has(id)', 'false');
    const commandData = { metadata: { capabilities: { required: ['tracker.show', 'tracker.show'] } } };
    const failures = mutated.checkCapabilityIds(commandData, 'f.yaml', validIds);
    expect(failures).toHaveLength(0);
  });
});

describe('checkCapabilityIds: an id declared in both required and optional is rejected (documented decision)', () => {
  const validIds = new Set(['tracker.show']);

  test('fails naming the id as contradictory when it appears in both lists', () => {
    const commandData = {
      metadata: { capabilities: { required: ['tracker.show'], optional: ['tracker.show'] } }
    };
    const failures = checkCapabilityIds(commandData, 'f.yaml', validIds);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('f.yaml');
    expect(failures[0]).toContain('tracker.show');
    expect(failures[0]).toContain('BOTH required and optional');
  });

  test('an id in only one list is never flagged as a cross-list contradiction', () => {
    const commandData = {
      metadata: { capabilities: { required: ['tracker.show'], optional: [] } }
    };
    expect(checkCapabilityIds(commandData, 'f.yaml', validIds)).toEqual([]);
  });

  test('MUTATION PROOF: removing the cross-list check silently accepts an id declared both required and optional', () => {
    const mutated = mutateAndRequireCheck("typeof id === 'string' && requiredIds.has(id)", 'false');
    const commandData = {
      metadata: { capabilities: { required: ['tracker.show'], optional: ['tracker.show'] } }
    };
    const failures = mutated.checkCapabilityIds(commandData, 'f.yaml', validIds);
    expect(failures).toEqual([]);
  });
});

describe('checkCapabilityInvocationDrift: every run/--require/confirm-status reference must be declared (PR 7 independent review item 7)', () => {
  test('a run <capability> invocation absent from declared capabilities fails, naming the file and the id', () => {
    const commandData = { metadata: { capabilities: { required: ['tracker.show'], optional: [] } } };
    const rawText = 'Run: node "$TOOLCHAIN_CLI" run tracker.list --json; print the result.';
    const failures = checkCapabilityInvocationDrift(commandData, 'f.yaml', rawText);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('f.yaml');
    expect(failures[0]).toContain('tracker.list');
  });

  test('a --require <capability> flag absent from declared capabilities fails, naming the file and the id', () => {
    const commandData = { metadata: { capabilities: { required: ['tracker.show'], optional: [] } } };
    const rawText = 'preflight --require tracker.show --require work-graph.plan --json';
    const failures = checkCapabilityInvocationDrift(commandData, 'f.yaml', rawText);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('work-graph.plan');
  });

  test('a confirm-status <capability> call absent from declared capabilities fails, naming the file and the id', () => {
    const commandData = { metadata: { capabilities: { required: ['tracker.create'], optional: [] } } };
    const rawText = 'run node "$TOOLCHAIN_CLI" confirm-status tracker.create --json; then confirm-status tracker.sync --json';
    const failures = checkCapabilityInvocationDrift(commandData, 'f.yaml', rawText);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('tracker.sync');
  });

  test('every invoked id declared (required or optional) produces zero failures', () => {
    const commandData = {
      metadata: { capabilities: { required: ['tracker.show'], optional: ['work-graph.plan'] } }
    };
    const rawText = [
      'preflight --require tracker.show --json',
      'run node "$TOOLCHAIN_CLI" run work-graph.plan --json',
      'run node "$TOOLCHAIN_CLI" run tracker.show --arg id=<id> --json'
    ].join('\n');
    expect(checkCapabilityInvocationDrift(commandData, 'f.yaml', rawText)).toEqual([]);
  });

  test('a command with no metadata.capabilities block at all produces zero failures (nothing to compare against)', () => {
    const commandData = { metadata: {} };
    const rawText = 'run node "$TOOLCHAIN_CLI" run tracker.list --json';
    expect(checkCapabilityInvocationDrift(commandData, 'f.yaml', rawText)).toEqual([]);
  });

  test('a declared-but-never-invoked optional capability is never flagged (one-directional: invocation -> declaration only)', () => {
    const commandData = {
      metadata: { capabilities: { required: ['tracker.show'], optional: ['work-graph.plan'] } }
    };
    const rawText = 'run node "$TOOLCHAIN_CLI" run tracker.show --arg id=<id> --json';
    expect(checkCapabilityInvocationDrift(commandData, 'f.yaml', rawText)).toEqual([]);
  });

  test('each undeclared id is reported only once even when invoked multiple times', () => {
    const commandData = { metadata: { capabilities: { required: [], optional: [] } } };
    const rawText = 'run tracker.list --json; later: run tracker.list --json again';
    const failures = checkCapabilityInvocationDrift(commandData, 'f.yaml', rawText);
    expect(failures).toHaveLength(1);
  });

  test('MUTATION PROOF: removing the RUN_CAPABILITY_RE scan silently stops catching an undeclared run <capability> invocation', () => {
    const mutated = mutateAndRequireCheck(
      'for (const re of [RUN_CAPABILITY_RE, PREFLIGHT_REQUIRE_ID_RE, CONFIRM_STATUS_ID_RE]) {',
      'for (const re of [PREFLIGHT_REQUIRE_ID_RE, CONFIRM_STATUS_ID_RE]) {'
    );
    const commandData = { metadata: { capabilities: { required: [], optional: [] } } };
    const rawText = 'run node "$TOOLCHAIN_CLI" run tracker.list --json';
    const failures = mutated.checkCapabilityInvocationDrift(commandData, 'f.yaml', rawText);
    expect(failures).toEqual([]);
  });

  test('MUTATION PROOF: removing the --require id scan silently stops catching an undeclared preflight --require reference', () => {
    const mutated = mutateAndRequireCheck(
      'for (const re of [RUN_CAPABILITY_RE, PREFLIGHT_REQUIRE_ID_RE, CONFIRM_STATUS_ID_RE]) {',
      'for (const re of [RUN_CAPABILITY_RE, CONFIRM_STATUS_ID_RE]) {'
    );
    const commandData = { metadata: { capabilities: { required: [], optional: [] } } };
    const rawText = 'preflight --require tracker.list --json';
    const failures = mutated.checkCapabilityInvocationDrift(commandData, 'f.yaml', rawText);
    expect(failures).toEqual([]);
  });

  test('MUTATION PROOF: making the declared-set check always pass silently accepts an undeclared id', () => {
    const mutated = mutateAndRequireCheck('if (!declared.has(id)) {', 'if (false) {');
    const commandData = { metadata: { capabilities: { required: [], optional: [] } } };
    const rawText = 'run node "$TOOLCHAIN_CLI" run tracker.list --json';
    const failures = mutated.checkCapabilityInvocationDrift(commandData, 'f.yaml', rawText);
    expect(failures).toEqual([]);
  });
});
