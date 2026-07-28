'use strict';

// TRD-039-TEST: Jest coverage for ado-test-suite.js's resolve-or-create
// decision logic (REQ-007's Test Suite half), including TRD-039's two
// additions found live-dogfooding this feature: (1) every suite call is now
// scoped to a required planId (TRD-038's ado-test-plan.js), since
// testplan_list_test_suites/testplan_create_test_suite both require one;
// (2) a QA-engineer-selected existing suite always wins over the automatic
// workItemId/name match, so a 'create' decision is never the only option
// presented when no match is found.

const { buildSuiteName, resolveOrCreateTestSuite, recordCreatedSuite } = require('../lib/ado-test-suite');

describe('buildSuiteName', () => {
  test('deterministic "Story {workItemId} - {storyTitle}" convention', () => {
    expect(buildSuiteName('12345', 'Claim intake validation')).toBe('Story 12345 - Claim intake validation');
  });
});

describe('resolveOrCreateTestSuite: resolving an existing suite', () => {
  test('resolves via a workItemId link match', () => {
    expect(
      resolveOrCreateTestSuite({
        planId: 900,
        workItemId: 12345,
        storyTitle: 'Claim intake validation',
        existingSuites: [
          { id: 999, name: 'Some other suite' },
          { id: 42, name: 'Story 12345 - Claim intake validation', workItemId: '12345' },
        ],
      })
    ).toEqual({
      action: 'resolve',
      planId: '900',
      suiteId: '42',
      suiteName: 'Story 12345 - Claim intake validation',
      workItemId: '12345',
    });
  });

  test('resolves via the deterministic-name fallback when no workItemId field is present', () => {
    expect(
      resolveOrCreateTestSuite({
        planId: 900,
        workItemId: 12345,
        storyTitle: 'Claim intake validation',
        existingSuites: [{ id: 7, name: 'Story 12345 - Claim intake validation' }],
      })
    ).toEqual({
      action: 'resolve',
      planId: '900',
      suiteId: '7',
      suiteName: 'Story 12345 - Claim intake validation',
      workItemId: '12345',
    });
  });

  test('a workItemId link match wins even when a differently-named suite also has that id', () => {
    expect(
      resolveOrCreateTestSuite({
        planId: 900,
        workItemId: 12345,
        storyTitle: 'Claim intake validation',
        existingSuites: [{ id: 55, name: 'Renamed by a human later', workItemId: '12345' }],
      })
    ).toEqual({
      action: 'resolve',
      planId: '900',
      suiteId: '55',
      suiteName: 'Renamed by a human later',
      workItemId: '12345',
    });
  });
});

describe('resolveOrCreateTestSuite: TRD-039 QA-engineer-selected suite override', () => {
  test('a selectedSuiteId wins over the automatic workItemId/name match', () => {
    expect(
      resolveOrCreateTestSuite({
        planId: 900,
        workItemId: 12345,
        storyTitle: 'Claim intake validation',
        existingSuites: [
          { id: 7, name: 'Story 12345 - Claim intake validation', workItemId: '12345' },
          { id: 999, name: 'Reused Regression Suite' },
        ],
        selectedSuiteId: 999,
      })
    ).toEqual({
      action: 'resolve',
      planId: '900',
      suiteId: '999',
      suiteName: 'Reused Regression Suite',
      workItemId: '12345',
    });
  });

  test('a selectedSuiteId resolves even when no automatic match exists at all', () => {
    expect(
      resolveOrCreateTestSuite({
        planId: 900,
        workItemId: 12345,
        storyTitle: 'Claim intake validation',
        existingSuites: [{ id: 999, name: 'Reused Regression Suite' }],
        selectedSuiteId: 999,
      })
    ).toEqual({
      action: 'resolve',
      planId: '900',
      suiteId: '999',
      suiteName: 'Reused Regression Suite',
      workItemId: '12345',
    });
  });

  test('a selectedSuiteId with no match in existingSuites throws, never trusted blindly', () => {
    expect(() =>
      resolveOrCreateTestSuite({
        planId: 900,
        workItemId: 12345,
        storyTitle: 'Claim intake validation',
        existingSuites: [{ id: 7 }],
        selectedSuiteId: 999,
      })
    ).toThrow(/does not match any of the fetched existingSuites/);
  });
});

describe('resolveOrCreateTestSuite: no match -> create decision', () => {
  test('no match at all produces a create decision carrying planId, no suiteId yet', () => {
    expect(
      resolveOrCreateTestSuite({
        planId: 900,
        workItemId: 12345,
        storyTitle: 'Claim intake validation',
        existingSuites: [{ id: 999, name: 'Unrelated suite' }],
      })
    ).toEqual({ action: 'create', planId: '900', suiteName: 'Story 12345 - Claim intake validation', workItemId: '12345' });
  });

  test('empty existingSuites also produces a create decision', () => {
    expect(resolveOrCreateTestSuite({ planId: 900, workItemId: 1, storyTitle: 'X', existingSuites: [] })).toEqual({
      action: 'create',
      planId: '900',
      suiteName: 'Story 1 - X',
      workItemId: '1',
    });
  });
});

describe('resolveOrCreateTestSuite: input validation', () => {
  test('missing input entirely throws', () => {
    expect(() => resolveOrCreateTestSuite()).toThrow(/input must be an object/);
  });

  test('planId is required -- every Test Suite belongs to a Test Plan', () => {
    expect(() => resolveOrCreateTestSuite({ workItemId: 1, storyTitle: 'X', existingSuites: [] })).toThrow(
      /planId must be a non-empty string or number/
    );
  });

  test('collects every missing/invalid field in one throw', () => {
    expect(() => resolveOrCreateTestSuite({})).toThrow(/planId.*workItemId.*storyTitle.*existingSuites/s);
  });

  test('existingSuites must be an array', () => {
    expect(() =>
      resolveOrCreateTestSuite({ planId: 900, workItemId: 1, storyTitle: 'X', existingSuites: 'not-an-array' })
    ).toThrow(/existingSuites must be an array/);
  });

  test('rejects an existingSuites entry with no usable id', () => {
    expect(() =>
      resolveOrCreateTestSuite({ planId: 900, workItemId: 1, storyTitle: 'X', existingSuites: [{ name: 'no id' }] })
    ).toThrow(/existingSuites\[0\]\.id must be a non-empty string or number/);
  });

  test('rejects an empty-string selectedSuiteId when present', () => {
    expect(() =>
      resolveOrCreateTestSuite({
        planId: 900,
        workItemId: 1,
        storyTitle: 'X',
        existingSuites: [{ id: 1 }],
        selectedSuiteId: '',
      })
    ).toThrow(/selectedSuiteId must be a non-empty string or number/);
  });
});

describe('recordCreatedSuite', () => {
  const createDecision = resolveOrCreateTestSuite({ planId: 900, workItemId: 1, storyTitle: 'X', existingSuites: [] });

  test('normalizes a valid MCP response, carrying planId through', () => {
    expect(recordCreatedSuite(createDecision, { id: 555, name: 'Story 1 - X' })).toEqual({
      suiteId: '555',
      suiteName: 'Story 1 - X',
      workItemId: '1',
      planId: '900',
    });
  });

  test('falls back to the decision suiteName when mcpResponse omits name', () => {
    expect(recordCreatedSuite(createDecision, { id: 555 })).toEqual({
      suiteId: '555',
      suiteName: 'Story 1 - X',
      workItemId: '1',
      planId: '900',
    });
  });

  test('rejects recording against a resolve decision -- nothing was created', () => {
    const resolveDecision = resolveOrCreateTestSuite({
      planId: 900,
      workItemId: 1,
      storyTitle: 'X',
      existingSuites: [{ id: 9, workItemId: '1' }],
    });
    expect(() => recordCreatedSuite(resolveDecision, { id: 555 })).toThrow(/nothing was created/);
  });

  test('rejects an mcpResponse with no usable id', () => {
    expect(() => recordCreatedSuite(createDecision, {})).toThrow(
      /mcpResponse\.id must be a non-empty string or number/
    );
  });

  test('rejects a non-object mcpResponse', () => {
    expect(() => recordCreatedSuite(createDecision, null)).toThrow(/mcpResponse must be an object/);
  });
});
