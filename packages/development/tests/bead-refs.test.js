'use strict';

/** Pure tests for lib/bead-refs.js (build/parse of the `## References` block). */

const {
  buildReferencesBlock,
  parseReferencesBlock,
  parseTitlePrefix,
  kindFromTitle,
  kindFromRefs,
} = require('../lib/bead-refs');

describe('buildReferencesBlock / parseReferencesBlock', () => {
  const full = {
    trdPath: 'docs/TRD/foo.md',
    trdTaskId: 'TRD-001-TEST',
    prdPath: 'docs/PRD/foo.md',
    reqIds: ['REQ-001', 'REQ-002'],
    acIds: ['AC-001-1', 'AC-001-2'],
    verifiesTaskId: 'TRD-001',
    parentEpicPrefix: '[trd:foo]',
  };

  test('round-trips every field', () => {
    const refs = parseReferencesBlock(`## Test Task: X\n${buildReferencesBlock(full)}\n\nSatisfies: REQ-001\nPRD ACs: nope`);
    expect(refs).toEqual({
      trd: 'docs/TRD/foo.md',
      trdTask: { path: 'docs/TRD/foo.md', id: 'trd-001-test' },
      prd: 'docs/PRD/foo.md',
      prdUnresolved: false,
      prdRequirements: [
        { path: 'docs/PRD/foo.md', id: 'req-001' },
        { path: 'docs/PRD/foo.md', id: 'req-002' },
      ],
      prdAcs: ['AC-001-1', 'AC-001-2'],
      verifiesTask: { path: 'docs/TRD/foo.md', id: 'trd-001' },
      parentEpic: '[trd:foo]',
    });
  });

  test('parsing stops at the blank line: lines after the block are not mistaken for references', () => {
    const refs = parseReferencesBlock(`${buildReferencesBlock({ trdPath: 'a.md' })}\n\nPRD ACs: AC-9-9\nTRD: other.md`);
    expect(refs.trd).toBe('a.md');
    expect(refs.prdAcs).toEqual([]);
  });

  test('omits optional lines; always ends with Read-first', () => {
    const block = buildReferencesBlock({ trdPath: 'docs\\TRD\\foo.md' });
    expect(block.split('\n')).toEqual([
      '## References',
      'TRD: docs/TRD/foo.md',
      expect.stringMatching(/^Read-first: /),
    ]);
  });

  test('unresolved PRD is flagged, keeps the raw reference, and emits no requirement lines', () => {
    const block = buildReferencesBlock({ trdPath: 't.md', prdPath: '../x/prd.md', prdUnresolved: true, reqIds: ['REQ-001'] });
    expect(block).toContain('PRD: ../x/prd.md (UNRESOLVED)');
    expect(block).not.toContain('PRD Requirement:');
    const refs = parseReferencesBlock(block);
    expect(refs.prd).toBe('../x/prd.md');
    expect(refs.prdUnresolved).toBe(true);
  });

  test('returns null when the description has no block', () => {
    expect(parseReferencesBlock('## Task: X\nTRD Reference: a.md#trd-001')).toBeNull();
    expect(parseReferencesBlock('')).toBeNull();
    expect(parseReferencesBlock(undefined)).toBeNull();
  });
});

describe('title prefix helpers', () => {
  test.each([
    ['[trd:foo] Implement TRD: X', 'epic'],
    ['[trd:foo:pr:2] PR 2: X', 'story'],
    ['[trd:foo:phase:1] Phase 1: X', 'story'],
    ['[trd:foo:task:TRD-001] Do', 'task'],
    ['[trd:foo:task:TRD-001-TEST] Test', 'test'],
    ['[trd:foo:task:TRD-001-TEST-S2] Sub', 'synth'],
    ['plain title', null],
  ])('%s -> %s', (title, kind) => {
    expect(kindFromTitle(title)).toBe(kind);
  });

  test('parseTitlePrefix extracts slug, task id and phase', () => {
    expect(parseTitlePrefix('[trd:foo:task:TRD-001] x')).toEqual({ kind: 'task', slug: 'foo', taskId: 'TRD-001' });
    expect(parseTitlePrefix('[trd:foo:pr:3] x')).toEqual({ kind: 'story', slug: 'foo', phaseN: 3 });
  });

  test('kindFromRefs derives a kind from block shape', () => {
    expect(kindFromRefs(parseReferencesBlock(buildReferencesBlock({ trdPath: 'a.md' })))).toBe('epic');
    expect(kindFromRefs(parseReferencesBlock(buildReferencesBlock({ trdPath: 'a.md', parentEpicPrefix: '[trd:a]' })))).toBe('story');
    expect(kindFromRefs(parseReferencesBlock(buildReferencesBlock({ trdPath: 'a.md', trdTaskId: 'T-1' })))).toBe('task');
    expect(kindFromRefs(parseReferencesBlock(buildReferencesBlock({ trdPath: 'a.md', trdTaskId: 'T-1', verifiesTaskId: 'T-0' })))).toBe('test');
    expect(kindFromRefs(null)).toBeNull();
  });
});
