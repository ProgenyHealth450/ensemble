/**
 * Tests for the refinement-review session module.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  SCHEMA_VERSION,
  newId,
  newToken,
  sha256Hex,
  extractSectionHeadings,
  validateAnchor,
  validateSession,
  loadSession,
  createSession,
  mutateSession,
} = require('../../lib/refinement-review/session');

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-session-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const SAMPLE_MD = [
  '# Refinement Sample',
  '',
  '## Overview',
  '',
  'Some intro paragraph.',
  '',
  '### Acceptance Criteria',
  '',
  '- one',
  '- two',
  '',
  '## Open Questions',
  '',
  '> clarifying questions go here',
  '',
].join('\n');

function writeSource(content = SAMPLE_MD) {
  const p = path.join(tmp, 'prd.md');
  fs.writeFileSync(p, content);
  return p;
}

describe('newId / newToken', () => {
  test('newId is hex and 32 chars', () => {
    const id = newId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
  test('newId is unique', () => {
    const a = newId();
    const b = newId();
    expect(a).not.toBe(b);
  });
  test('newToken is hex and 64 chars', () => {
    expect(newToken()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('sha256Hex', () => {
  test('matches known vector', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
  test('accepts Buffer', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe(sha256Hex('abc'));
  });
});

describe('extractSectionHeadings', () => {
  test('captures ordered headings', () => {
    expect(extractSectionHeadings(SAMPLE_MD)).toEqual([
      '# Refinement Sample',
      '## Overview',
      '### Acceptance Criteria',
      '## Open Questions',
    ]);
  });
  test('returns empty array on non-string', () => {
    expect(extractSectionHeadings(null)).toEqual([]);
    expect(extractSectionHeadings(42)).toEqual([]);
  });
  test('handles CRLF', () => {
    const crlf = SAMPLE_MD.replace(/\n/g, '\r\n');
    expect(extractSectionHeadings(crlf)).toEqual([
      '# Refinement Sample',
      '## Overview',
      '### Acceptance Criteria',
      '## Open Questions',
    ]);
  });
  test('strips trailing hashes', () => {
    expect(extractSectionHeadings('## Title ##\n')).toEqual(['## Title']);
  });
});

describe('validateAnchor', () => {
  test('null anchor is allowed', () => {
    expect(validateAnchor(null, 100)).toBeNull();
    expect(validateAnchor(undefined, 100)).toBeNull();
  });
  test('rejects non-object', () => {
    expect(validateAnchor('bad', 10)).toMatch(/object or null/);
  });
  test('rejects lineStart out of bounds', () => {
    expect(
      validateAnchor({ section: null, lineStart: 0, lineEnd: 1, selectedText: null }, 10),
    ).toMatch(/lineStart/);
    expect(
      validateAnchor({ section: null, lineStart: 11, lineEnd: 11, selectedText: null }, 10),
    ).toMatch(/lineStart/);
  });
  test('rejects lineEnd < lineStart', () => {
    expect(
      validateAnchor({ section: null, lineStart: 5, lineEnd: 4, selectedText: null }, 10),
    ).toMatch(/lineEnd/);
  });
  test('rejects lineEnd > totalLines', () => {
    expect(
      validateAnchor({ section: null, lineStart: 1, lineEnd: 11, selectedText: null }, 10),
    ).toMatch(/lineEnd/);
  });
  test('rejects non-string selectedText', () => {
    expect(
      validateAnchor({ section: null, lineStart: 1, lineEnd: 1, selectedText: 42 }, 10),
    ).toMatch(/selectedText/);
  });
  test('accepts a valid anchor', () => {
    expect(
      validateAnchor({ section: '## Overview', lineStart: 1, lineEnd: 5, selectedText: 'text' }, 20),
    ).toBeNull();
  });
});

describe('createSession', () => {
  test('persists a valid envelope and returns token', () => {
    const source = writeSource();
    const sessionPath = path.join(tmp, 'session.json');
    const { session, token } = createSession({
      sessionPath,
      kind: 'prd',
      sourcePath: source,
      questions: [{ id: 'q1', prompt: 'Why?' }, { prompt: 'How?' }],
    });
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(session.schemaVersion).toBe(SCHEMA_VERSION);
    expect(session.document.kind).toBe('prd');
    expect(session.document.sha256).toBe(sha256Hex(SAMPLE_MD));
    expect(session.document.sectionHeadings).toHaveLength(4);
    expect(session.questions).toHaveLength(2);
    expect(session.questions[0].id).toBe('q1');
    expect(session.questions[0].status).toBe('open');
    expect(session.questions[1].id).toMatch(/^[0-9a-f]{32}$/);
    expect(session.comments).toEqual([]);
    expect(session.revision).toBe(1);
    expect(fs.existsSync(sessionPath)).toBe(true);
  });

  test('rejects invalid kind', () => {
    expect(() =>
      createSession({
        sessionPath: path.join(tmp, 's.json'),
        kind: 'bad',
        sourcePath: writeSource(),
        questions: [{ prompt: 'x' }],
      }),
    ).toThrow(/kind/);
  });

  test('rejects empty questions', () => {
    expect(() =>
      createSession({
        sessionPath: path.join(tmp, 's.json'),
        kind: 'prd',
        sourcePath: writeSource(),
        questions: [],
      }),
    ).toThrow(/questions/);
  });

  test('rejects unreadable source', () => {
    expect(() =>
      createSession({
        sessionPath: path.join(tmp, 's.json'),
        kind: 'prd',
        sourcePath: path.join(tmp, 'missing.md'),
        questions: [{ prompt: 'x' }],
      }),
    ).toThrow();
  });
});

describe('mutateSession', () => {
  function setupSession(extraQuestions = []) {
    const source = writeSource();
    const sessionPath = path.join(tmp, 'session.json');
    const { session, token } = createSession({
      sessionPath,
      kind: 'prd',
      sourcePath: source,
      questions: [{ id: 'q1', prompt: 'Why?' }, ...extraQuestions],
    });
    return { session, token, sessionPath, source };
  }

  test('mutates, auto-bumps revision by 1, persists', () => {
    const { sessionPath } = setupSession();
    const q1 = loadSession(sessionPath).questions[0];
    const next = mutateSession({
      sessionPath,
      expectedRevision: 1,
      mutate(s) {
        s.questions[0].status = 'answered';
        s.questions[0].answer = 'Because.';
        s.questions[0].author = 'pm';
      },
    });
    expect(next.revision).toBe(2);
    expect(next.questions[0].status).toBe('answered');
    expect(next.questions[0].answer).toBe('Because.');
    expect(next.questions[0].author).toBe('pm');
    expect(typeof next.updatedAt).toBe('string');
    // Persisted on disk
    const onDisk = loadSession(sessionPath);
    expect(onDisk.revision).toBe(2);
    expect(onDisk.questions[0].answer).toBe('Because.');
    expect(q1.id).toBeDefined();
  });

  test('rejects stale revision', () => {
    const { sessionPath } = setupSession();
    // First write succeeds and bumps to 2
    mutateSession({
      sessionPath,
      expectedRevision: 1,
      mutate(s) {
        s.questions[0].status = 'skipped';
      },
    });
    // Second write with stale expected=1 must fail
    expect(() =>
      mutateSession({
        sessionPath,
        expectedRevision: 1,
        mutate(s) {
          s.questions[0].answer = 'stale';
        },
      }),
    ).toThrow(/revision conflict/);
  });

  test('rejects when source sha256 changes on disk', () => {
    const { sessionPath, source } = setupSession();
    fs.writeFileSync(source, '# totally different content\n');
    expect(() =>
      mutateSession({
        sessionPath,
        expectedRevision: 1,
        mutate(s) {
          s.questions[0].status = 'answered';
        },
      }),
    ).toThrow(/sha256 changed/);
  });

  test('rejects after completion', () => {
    const { sessionPath } = setupSession();
    mutateSession({
      sessionPath,
      expectedRevision: 1,
      mutate(s) {
        s.completedAt = new Date().toISOString();
        s.completedBy = 'pm';
      },
    });
    let caught;
    try {
      mutateSession({
        sessionPath,
        expectedRevision: 2,
        mutate(s) {
          s.questions[0].status = 'answered';
        },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('SESSION_COMPLETED');
    expect(caught.status).toBe(410);
  });

  test('rejects mutator that tampers with revision (REVISION_TAMPERED, 400)', () => {
    const { sessionPath } = setupSession();
    let caught;
    try {
      mutateSession({
        sessionPath,
        expectedRevision: 1,
        mutate(s) {
          s.questions[0].status = 'answered';
          s.revision = 99; // mutator must not touch revision
        },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('REVISION_TAMPERED');
    expect(caught.status).toBe(400);
  });

  test('every accepted mutation increments revision by exactly one', () => {
    const { sessionPath } = setupSession();
    let rev = 1;
    for (let i = 0; i < 5; i++) {
      const next = mutateSession({
        sessionPath,
        expectedRevision: rev,
        mutate(s) {
          s.questions[0].answer = `iter ${i}`;
        },
      });
      expect(next.revision).toBe(rev + 1);
      rev = next.revision;
    }
  });
});

describe('validateSession', () => {
  test('accepts a known-good envelope', () => {
    const source = writeSource();
    const sessionPath = path.join(tmp, 's.json');
    const { session } = createSession({
      sessionPath,
      kind: 'trd',
      sourcePath: source,
      questions: [{ prompt: 'p' }],
    });
    expect(() => validateSession(session)).not.toThrow();
  });

  test('rejects bad kind', () => {
    const session = {
      schemaVersion: 1,
      sessionId: 'x',
      revision: 1,
      createdAt: 'now',
      updatedAt: 'now',
      document: {
        kind: 'garbage',
        sourcePath: '/tmp/x',
        contentPath: '/tmp/x',
        sha256: 'h',
        sectionHeadings: [],
      },
      questions: [{ id: 'q', prompt: 'p', context: null, status: 'open', answer: null, author: null, updatedAt: null }],
      comments: [],
    };
    expect(() => validateSession(session)).toThrow(/kind/);
  });

  test('rejects empty question set', () => {
    const session = {
      schemaVersion: 1,
      sessionId: 'x',
      revision: 1,
      createdAt: 'now',
      updatedAt: 'now',
      document: {
        kind: 'prd',
        sourcePath: '/tmp/x',
        contentPath: '/tmp/x',
        sha256: 'h',
        sectionHeadings: [],
      },
      questions: [],
      comments: [],
    };
    expect(() => validateSession(session)).toThrow(/non-empty/);
  });

  test('rejects duplicate question ids', () => {
    const session = {
      schemaVersion: 1,
      sessionId: 'x',
      revision: 1,
      createdAt: 'now',
      updatedAt: 'now',
      document: {
        kind: 'prd',
        sourcePath: '/tmp/x',
        contentPath: '/tmp/x',
        sha256: 'h',
        sectionHeadings: [],
      },
      questions: [
        { id: 'q', prompt: 'p1', context: null, status: 'open', answer: null, author: null, updatedAt: null },
        { id: 'q', prompt: 'p2', context: null, status: 'open', answer: null, author: null, updatedAt: null },
      ],
      comments: [],
    };
    expect(() => validateSession(session)).toThrow(/duplicate question/);
  });

  test('persists targetAnchor when provided on a question', () => {
    const source = writeSource();
    const sessionPath = path.join(tmp, 'ta.json');
    const { session } = createSession({
      sessionPath,
      kind: 'prd',
      sourcePath: source,
      questions: [
        {
          id: 'q1',
          prompt: 'Why?',
          targetAnchor: { lineStart: 3, lineEnd: 5, highlightText: 'fragment' },
        },
        { prompt: 'How?', targetAnchor: { lineStart: 10 } },
      ],
    });
    expect(session.questions[0].targetAnchor).toEqual({
      lineStart: 3,
      lineEnd: 5,
      highlightText: 'fragment',
    });
    expect(session.questions[1].targetAnchor).toEqual({ lineStart: 10 });
  });

  test('default targetAnchor is null when omitted', () => {
    const source = writeSource();
    const sessionPath = path.join(tmp, 'ta-null.json');
    const { session } = createSession({
      sessionPath,
      kind: 'prd',
      sourcePath: source,
      questions: [{ prompt: 'Why?' }],
    });
    expect(session.questions[0].targetAnchor).toBeNull();
  });

  test('rejects targetAnchor with non-positive lineStart', () => {
    const source = writeSource();
    expect(() =>
      createSession({
        sessionPath: path.join(tmp, 'ta-bad1.json'),
        kind: 'prd',
        sourcePath: source,
        questions: [{ prompt: 'p', targetAnchor: { lineStart: 0 } }],
      })
    ).toThrow(/lineStart/);
  });

  test('rejects targetAnchor with lineEnd < lineStart', () => {
    const source = writeSource();
    expect(() =>
      createSession({
        sessionPath: path.join(tmp, 'ta-bad2.json'),
        kind: 'prd',
        sourcePath: source,
        questions: [
          { prompt: 'p', targetAnchor: { lineStart: 10, lineEnd: 5 } },
        ],
      })
    ).toThrow(/lineEnd/);
  });
});
