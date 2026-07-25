'use strict';

// TRD-017-TEST: formalizes ado-test-case-sync.js's embedded
// require.main===module self-check into Jest, plus the delimiter-priority
// and word-boundary edge cases called out in the task. AC reference:
//   - AC-007-1 (Test Case half): synced steps read as plain English matching
//     the test's narration -- this file's main focus.

const {
  buildTestCaseTitle,
  renderStep,
  planTestCaseSync,
  recordSyncedTestCase,
} = require('../lib/ado-test-case-sync');
const { tagTestMethod, findAdoTestCaseTag, addAdoTestCaseTag } = require('../lib/traceability-tagger');
const { scaffoldNewSpecFile } = require('../lib/spec-writer');

describe('renderStep', () => {
  test('a plain sentence with no delimiter becomes the action, expectedResult defaults to "Passes"', () => {
    expect(renderStep('Click the "Submit" button')).toEqual({
      action: 'Click the "Submit" button',
      expectedResult: 'Passes',
    });
  });

  test.each(['->', '=>'])('an arrow delimiter (%s) splits action / expectedResult', (arrow) => {
    expect(renderStep(`Submit the form ${arrow} a confirmation banner is shown`)).toEqual({
      action: 'Submit the form',
      expectedResult: 'a confirmation banner is shown',
    });
  });

  test.each(['then', 'Then', 'THEN'])('a ", %s" delimiter is case-insensitive', (thenWord) => {
    expect(renderStep(`Fill in the claim ID field, ${thenWord} the search results update`)).toEqual({
      action: 'Fill in the claim ID field',
      expectedResult: 'the search results update',
    });
  });

  test.each(['Please strengthen the handshake protocol', 'Review the cable, lengthen it if needed'])(
    'word-boundary: does not treat "then" inside strengthen/lengthen as a ", then" delimiter (%s)',
    (stepText) => {
      expect(renderStep(stepText)).toEqual({ action: stepText, expectedResult: 'Passes' });
    }
  );

  test('a comma that merely precedes a word containing "then" (strengthen) is skipped in favor of the real ", then" later in the string', () => {
    expect(renderStep('Increase tension, strengthen the cable, then test the fit')).toEqual({
      action: 'Increase tension, strengthen the cable',
      expectedResult: 'test the fit',
    });
  });

  test('arrow wins priority when both an arrow and a ", then" clause are present in the same string', () => {
    expect(renderStep('Click submit -> confirmation shown, then check email')).toEqual({
      action: 'Click submit',
      expectedResult: 'confirmation shown, then check email',
    });
  });

  test('multiple arrows split only at the first occurrence', () => {
    expect(renderStep('A -> B -> C')).toEqual({ action: 'A', expectedResult: 'B -> C' });
  });

  test('multiple ", then" clauses split only at the first occurrence', () => {
    expect(renderStep('A, then B, then C')).toEqual({ action: 'A', expectedResult: 'B, then C' });
  });

  test('a trailing-only arrow (nothing after "->") falls through to the plain default rather than an empty group', () => {
    expect(renderStep('Click submit ->')).toEqual({ action: 'Click submit ->', expectedResult: 'Passes' });
  });

  test('a trailing-only ", then" (nothing after "then") falls through to the plain default rather than an empty group', () => {
    expect(renderStep('Fill in the form, then')).toEqual({
      action: 'Fill in the form, then',
      expectedResult: 'Passes',
    });
  });
});

describe('buildTestCaseTitle', () => {
  test('normal case: "${acId}: ${acText}"', () => {
    expect(buildTestCaseTitle('AC-007-1', 'A confirmation banner is shown.')).toBe(
      'AC-007-1: A confirmation banner is shown.'
    );
  });

  test('exactly 255 characters is returned unchanged, not truncated', () => {
    const acId = 'AC-001-1';
    const prefixLength = `${acId}: `.length;
    const acText = 'x'.repeat(255 - prefixLength);
    const raw = `${acId}: ${acText}`;
    expect(raw.length).toBe(255);

    const title = buildTestCaseTitle(acId, acText);
    expect(title).toBe(raw);
    expect(title.length).toBe(255);
    expect(title.endsWith('...')).toBe(false);
  });

  test('256 characters is truncated with a trailing "..." to exactly 255 characters total', () => {
    const acId = 'AC-001-1';
    const prefixLength = `${acId}: `.length;
    const acText = 'x'.repeat(256 - prefixLength);
    const raw = `${acId}: ${acText}`;
    expect(raw.length).toBe(256);

    const title = buildTestCaseTitle(acId, acText);
    expect(title.length).toBe(255);
    expect(title.endsWith('...')).toBe(true);
    expect(title).toBe(`${raw.slice(0, 252)}...`);
  });
});

describe('planTestCaseSync', () => {
  const validInput = () => ({
    acId: 'AC-007-1',
    acText: 'Given a test has been confirmed passing, when synced, then a Test Case exists.',
    steps: ['Click the "Submit" button', 'Submit the form -> a confirmation banner is shown'],
    suiteId: 42,
  });

  test('no existingAdoTestCaseId decides to create, and renders every step', () => {
    const decision = planTestCaseSync(validInput());
    expect(decision.action).toBe('create');
    expect(decision.testCaseId).toBeUndefined();
    expect(decision.suiteId).toBe('42');
    expect(decision.title).toBe(`AC-007-1: ${validInput().acText}`);
    expect(decision.steps).toEqual([
      { action: 'Click the "Submit" button', expectedResult: 'Passes' },
      { action: 'Submit the form', expectedResult: 'a confirmation banner is shown' },
    ]);
  });

  test('a present existingAdoTestCaseId decides to update, carrying testCaseId through', () => {
    const decision = planTestCaseSync({ ...validInput(), existingAdoTestCaseId: 555 });
    expect(decision.action).toBe('update');
    expect(decision.testCaseId).toBe('555');
    expect(decision.suiteId).toBe('42');
  });

  test('existingAdoTestCaseId: 0 is falsy but a valid id -- still decides to update, not create', () => {
    const decision = planTestCaseSync({ ...validInput(), existingAdoTestCaseId: 0 });
    expect(decision.action).toBe('update');
    expect(decision.testCaseId).toBe('0');
  });

  test.each([
    ['non-string entries', ['ok', 42], /steps\[1\] must be a non-empty string/],
    ['an empty array', [], /steps must contain at least one step description/],
    ['not an array', 'not an array', /steps must be an array of non-empty strings/],
  ])('rejects a malformed steps array (%s)', (_label, steps, expectedError) => {
    expect(() => planTestCaseSync({ ...validInput(), steps })).toThrow(expectedError);
  });

  test.each([
    ['missing', undefined],
    ['whitespace-only', '   '],
  ])('rejects a %s acId', (_label, acId) => {
    expect(() => planTestCaseSync({ ...validInput(), acId })).toThrow(/acId must be a non-empty string/);
  });

  test.each([
    ['missing', undefined],
    ['whitespace-only', '   '],
  ])('rejects a %s suiteId', (_label, suiteId) => {
    expect(() => planTestCaseSync({ ...validInput(), suiteId })).toThrow(
      /suiteId must be a non-empty string or number/
    );
  });
});

describe('recordSyncedTestCase', () => {
  const decision = { action: 'create', title: 'AC-007-1: Some AC text.', suiteId: '42' };

  test('normalizes a full mcpResponse', () => {
    expect(recordSyncedTestCase(decision, { id: 999, title: 'AC-007-1: Renamed by ADO' })).toEqual({
      testCaseId: '999',
      title: 'AC-007-1: Renamed by ADO',
      suiteId: '42',
    });
  });

  test('falls back to decision.title when mcpResponse.title is absent', () => {
    expect(recordSyncedTestCase(decision, { id: 999 })).toEqual({
      testCaseId: '999',
      title: decision.title,
      suiteId: '42',
    });
  });

  test('rejects a malformed decision (not a create/update decision from planTestCaseSync)', () => {
    expect(() => recordSyncedTestCase({ title: 'X', suiteId: '1' }, { id: 1 })).toThrow(
      /requires the decision returned by planTestCaseSync/
    );
  });

  test('rejects an mcpResponse missing a usable id', () => {
    expect(() => recordSyncedTestCase(decision, {})).toThrow(/mcpResponse\.id must be a non-empty string or number/);
  });
});

describe('AC-007-1 end-to-end: synced steps read as plain English matching the fed-in narration', () => {
  test('a small multi-step plan (plain / arrow / comma-then) renders each step back as natural plain English', () => {
    const decision = planTestCaseSync({
      acId: 'AC-007-1',
      acText: 'Given a claim search, when the user submits a claim id, then matching results are shown.',
      steps: [
        'Navigate to the claim search page',
        'Enter a valid claim ID -> the search button becomes enabled',
        'Click search, then the matching claim is displayed in the results table',
      ],
      suiteId: 7,
    });

    expect(decision.steps).toEqual([
      { action: 'Navigate to the claim search page', expectedResult: 'Passes' },
      { action: 'Enter a valid claim ID', expectedResult: 'the search button becomes enabled' },
      { action: 'Click search', expectedResult: 'the matching claim is displayed in the results table' },
    ]);

    // every rendered action/expectedResult reads back naturally -- no
    // leftover delimiter syntax and no truncation/garbling of the fed-in text
    decision.steps.forEach((step) => {
      expect(step.action).not.toMatch(/->|=>|,\s*then\b/i);
      expect(step.expectedResult).not.toMatch(/->|=>/);
    });
  });
});

// TRD-018-TEST / AC-007-2: the literal "re-sync updates the SAME Test Case in
// place" proof, chaining traceability-tagger.js's findAdoTestCaseTag/
// addAdoTestCaseTag (TRD-018) through this module's own planTestCaseSync
// (TRD-017) across two simulated sessions -- never a duplicate, never a
// title-match lookup.
describe('AC-007-2 integration: findAdoTestCaseTag -> planTestCaseSync -> addAdoTestCaseTag', () => {
  test('a full two-session flow: session 1 creates, session 2 re-syncs the SAME Test Case id (never a duplicate)', () => {
    // --- session 1: scaffold, tag, decide to create, simulate the MCP
    // response, then write the resulting id back onto the spec file ---
    const scaffolded = scaffoldNewSpecFile({
      className: 'ClaimSearchTests',
      baseClass: 'PageTest',
      acId: 'AC-007-2',
      testName: 'Should_Update_Same_Test_Case_On_Resync',
    });

    const acText =
      'Given a test has already synced, when it is re-synced, then the same Test Case is updated in place.';
    const tagged = tagTestMethod(scaffolded, {
      acId: 'AC-007-2',
      acText,
      reqId: 'REQ-007',
      documentId: 'PRD-2026-da72aa86',
    });

    expect(findAdoTestCaseTag(tagged, 'AC-007-2')).toBeNull(); // not yet synced

    const createDecision = planTestCaseSync({
      acId: 'AC-007-2',
      acText,
      steps: ['Re-run the already-synced test'],
      suiteId: 42,
    });
    expect(createDecision.action).toBe('create');
    expect(createDecision.testCaseId).toBeUndefined();

    const created = recordSyncedTestCase(createDecision, { id: 8675, title: createDecision.title });
    expect(created.testCaseId).toBe('8675');

    const syncedOnce = addAdoTestCaseTag(tagged, 'AC-007-2', created.testCaseId);
    expect(findAdoTestCaseTag(syncedOnce, 'AC-007-2')).toBe('8675');

    // --- session 2 (re-sync): re-read the tag off the (now-persisted)
    // content and feed it straight back into planTestCaseSync ---
    const rediscoveredId = findAdoTestCaseTag(syncedOnce, 'AC-007-2');
    expect(rediscoveredId).toBe('8675'); // the SAME id session 1 wrote

    // the AC's narration changed slightly between sessions (e.g. a step got
    // reworded) -- the re-sync decision must still key off the id alone
    const updateDecision = planTestCaseSync({
      acId: 'AC-007-2',
      acText: 'Given a test has already synced once, when re-synced again, then the same Test Case is updated, never duplicated.',
      steps: ['Re-run the already-synced test', 'Confirm no duplicate Test Case was created'],
      suiteId: 42,
      existingAdoTestCaseId: rediscoveredId,
    });

    expect(updateDecision.action).toBe('update'); // never 'create' on re-sync
    expect(updateDecision.testCaseId).toBe('8675'); // the exact same Test Case, in place

    // re-applying the tag with the id it already carries is the idempotent
    // no-op case -- confirms re-syncing never duplicates the tag either
    const syncedTwice = addAdoTestCaseTag(syncedOnce, 'AC-007-2', updateDecision.testCaseId);
    expect(syncedTwice).toBe(syncedOnce);
    expect((syncedTwice.match(/@ado-testcase:/g) || []).length).toBe(1);
  });

  test('the re-sync decision carries no title-match/lookup logic -- it is driven purely by the tag-derived id', () => {
    // shape-level: an 'update' decision carries testCaseId (a plain
    // passthrough of what the caller already knew), never a title-search
    // field of any kind.
    const decision = planTestCaseSync({
      acId: 'AC-007-2',
      acText: 'Completely different text than whatever synced previously.',
      steps: ['Some step'],
      suiteId: 1,
      existingAdoTestCaseId: 8675,
    });
    expect(decision).toEqual(expect.objectContaining({ action: 'update', testCaseId: '8675' }));
    expect(Object.keys(decision).sort()).toEqual(['action', 'steps', 'suiteId', 'testCaseId', 'title'].sort());

    // behavior-level: an entirely different acText still resolves to the
    // exact same testCaseId as long as the same existingAdoTestCaseId is fed
    // in -- proving the id, not the title, is what identifies the Test Case.
    const decisionWithDifferentText = planTestCaseSync({
      acId: 'AC-007-2',
      acText: 'Yet another totally unrelated piece of narration text.',
      steps: ['Some step'],
      suiteId: 1,
      existingAdoTestCaseId: 8675,
    });
    expect(decisionWithDifferentText.testCaseId).toBe(decision.testCaseId);
  });
});
