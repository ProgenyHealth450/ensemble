'use strict';
/**
 * Tests for the capability-id existence gate (TRD-022 Implementation AC 1/2):
 * scripts/lib/capability-ids-check.js cross-references a command YAML's
 * `metadata.capabilities.{required,optional}` ids against the real category
 * contracts in packages/development/toolchain/categories/*.yaml.
 */

const path = require('path');
const { loadValidCapabilityIds, checkCapabilityIds } = require('../lib/capability-ids-check');

const REAL_CATEGORIES_DIR = path.resolve(__dirname, '..', '..', 'packages', 'development', 'toolchain', 'categories');

describe('loadValidCapabilityIds', () => {
  test('collects real ids from every category contract, e.g. tracker.show and work-graph.ready', () => {
    const ids = loadValidCapabilityIds(REAL_CATEGORIES_DIR);
    expect(ids.has('tracker.show')).toBe(true);
    expect(ids.has('work-graph.ready')).toBe(true);
    expect(ids.has('tracker.nonexistent')).toBe(false);
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
