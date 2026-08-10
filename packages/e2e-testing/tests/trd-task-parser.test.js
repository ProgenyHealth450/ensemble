'use strict';

const { parseTrdTasks, normalizeLineEndings } = require('../lib/trd-task-parser');

const SAMPLE_TRD = `---
document_id: TRD-2026-fixture
---

# TRD-2026-fixture: Fixture TRD

## Master Task List

### PR 1: Fixture PR

- [x] **TRD-001**: Implement fixture feature (3h) [satisfies REQ-001] [depends: none]
  - Target Files: \`src/handlers/fixture.js\`, \`src/handlers/fixture-helper.js\`
  - Implementation AC:
    - Given a fixture, when it runs, then it works.

- [ ] **TRD-002**: Implement a second REQ (2h) [satisfies REQ-002, REQ-003] [depends: TRD-001]
  - Target File: \`src/handlers/second.js\`

- [ ] **TRD-003**: A task with no Target Files at all [satisfies REQ-004]
  - Implementation AC:
    - Given nothing, when it runs, then nothing happens.

## Team Configuration

Not part of the Master Task List scope.

- [ ] **TRD-999**: Should never be picked up — outside Master Task List scope [satisfies REQ-999]
  - Target File: \`should/not/appear.js\`
`;

describe('parseTrdTasks', () => {
  test('extracts satisfies and targetFiles for every task in the Master Task List', () => {
    const { tasksById } = parseTrdTasks(SAMPLE_TRD);
    expect(Object.keys(tasksById)).toEqual(['TRD-001', 'TRD-002', 'TRD-003']);

    expect(tasksById['TRD-001']).toEqual({
      id: 'TRD-001',
      satisfies: ['REQ-001'],
      targetFiles: ['src/handlers/fixture.js', 'src/handlers/fixture-helper.js'],
    });
    expect(tasksById['TRD-002']).toEqual({
      id: 'TRD-002',
      satisfies: ['REQ-002', 'REQ-003'],
      targetFiles: ['src/handlers/second.js'],
    });
  });

  test('a task with no Target Files line -> empty targetFiles array, not an error', () => {
    const { tasksById } = parseTrdTasks(SAMPLE_TRD);
    expect(tasksById['TRD-003'].targetFiles).toEqual([]);
  });

  test('a task outside the Master Task List section is never picked up', () => {
    const { tasksById } = parseTrdTasks(SAMPLE_TRD);
    expect(tasksById['TRD-999']).toBeUndefined();
  });

  test('a duplicate task id keeps the first occurrence', () => {
    const trd = `## Master Task List

- [ ] **TRD-001**: First (3h) [satisfies REQ-001]
  - Target File: \`a.js\`

- [ ] **TRD-001**: Duplicate (2h) [satisfies REQ-002]
  - Target File: \`b.js\`
`;
    const { tasksById } = parseTrdTasks(trd);
    expect(tasksById['TRD-001'].satisfies).toEqual(['REQ-001']);
    expect(tasksById['TRD-001'].targetFiles).toEqual(['a.js']);
  });

  test('no "## Master Task List" heading -> falls back to scanning the whole document', () => {
    const trd = `# A TRD with no Master Task List heading

- [ ] **TRD-001**: A task anyway (1h) [satisfies REQ-001]
  - Target File: \`a.js\`
`;
    const { tasksById } = parseTrdTasks(trd);
    expect(tasksById['TRD-001']).toEqual({
      id: 'TRD-001',
      satisfies: ['REQ-001'],
      targetFiles: ['a.js'],
    });
  });

  test('non-string/empty input -> empty tasksById, never throws', () => {
    expect(parseTrdTasks(null)).toEqual({ tasksById: {} });
    expect(parseTrdTasks(undefined)).toEqual({ tasksById: {} });
    expect(parseTrdTasks('')).toEqual({ tasksById: {} });
  });
});

describe('parseTrdTasks — CRLF line endings', () => {
  // Same bug class already fixed in trd-parser.js, prd-parser.js, and
  // prd-ac-parser.js: every heading/task-line regex is `$`-anchored, and JS
  // regex treats a lone trailing `\r` as its own line terminator that `.`
  // cannot consume, so a CRLF-sourced TRD (the norm on Windows checkouts with
  // core.autocrlf=true) would silently fail to match. Deliberately
  // constructed, independent of the checked-out fixture's own line endings.
  const CRLF_TRD = SAMPLE_TRD.replace(/\n/g, '\r\n');

  test('still extracts every task despite trailing \\r on heading/task lines', () => {
    const { tasksById } = parseTrdTasks(CRLF_TRD);
    expect(Object.keys(tasksById)).toEqual(['TRD-001', 'TRD-002', 'TRD-003']);
    expect(tasksById['TRD-001'].targetFiles).toEqual([
      'src/handlers/fixture.js',
      'src/handlers/fixture-helper.js',
    ]);
  });

  test('normalizeLineEndings strips CRLF/CR to LF', () => {
    expect(normalizeLineEndings('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });
});
