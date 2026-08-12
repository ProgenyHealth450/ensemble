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
  migrateOrCreate,
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

  test('persists options and recommendedOptionId on a question', () => {
    const source = writeSource();
    const sessionPath = path.join(tmp, 'opts.json');
    const { session } = createSession({
      sessionPath,
      kind: 'prd',
      sourcePath: source,
      questions: [
        {
          id: 'q1',
          prompt: 'Choose?',
          options: [
            { id: 'all', label: 'Address all', description: 'do everything' },
            { id: 'skip', label: 'Skip', description: 'do nothing' },
          ],
          recommendedOptionId: 'all',
        },
      ],
    });
    expect(session.questions[0].options).toEqual([
      { id: 'all', label: 'Address all', description: 'do everything' },
      { id: 'skip', label: 'Skip', description: 'do nothing' },
    ]);
    expect(session.questions[0].recommendedOptionId).toBe('all');
    expect(session.questions[0].selectedOptionId).toBeNull();
  });

  test('default options / recommendedOptionId / selectedOptionId are null when omitted', () => {
    const source = writeSource();
    const sessionPath = path.join(tmp, 'opts-null.json');
    const { session } = createSession({
      sessionPath,
      kind: 'prd',
      sourcePath: source,
      questions: [{ prompt: 'One?' }],
    });
    expect(session.questions[0].options).toBeNull();
    expect(session.questions[0].recommendedOptionId).toBeNull();
    expect(session.questions[0].selectedOptionId).toBeNull();
  });

  test('rejects recommendedOptionId that does not match any option.id', () => {
    const source = writeSource();
    expect(() =>
      createSession({
        sessionPath: path.join(tmp, 'opts-bad1.json'),
        kind: 'prd',
        sourcePath: source,
        questions: [
          {
            prompt: 'p',
            options: [{ id: 'a', label: 'A' }],
            recommendedOptionId: 'b',
          },
        ],
      }),
    ).toThrow(/recommendedOptionId/);
  });

  test('rejects options entry missing id', () => {
    const source = writeSource();
    expect(() =>
      createSession({
        sessionPath: path.join(tmp, 'opts-bad2.json'),
        kind: 'prd',
        sourcePath: source,
        questions: [
          { prompt: 'p', options: [{ label: 'no id' }] },
        ],
      }),
    ).toThrow(/options\[\]\.id/);
  });

  test('rejects duplicate option ids', () => {
    const source = writeSource();
    expect(() =>
      createSession({
        sessionPath: path.join(tmp, 'opts-bad3.json'),
        kind: 'prd',
        sourcePath: source,
        questions: [
          {
            prompt: 'p',
            options: [
              { id: 'a', label: 'A' },
              { id: 'a', label: 'A again' },
            ],
          },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  test('selectedOptionId is mutable through mutateSession', () => {
    const source = writeSource();
    const sessionPath = path.join(tmp, 'opts-mut.json');
    createSession({
      sessionPath,
      kind: 'prd',
      sourcePath: source,
      questions: [
        {
          id: 'q1',
          prompt: 'Pick',
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
          recommendedOptionId: 'a',
        },
      ],
    });
    const next = mutateSession({
      sessionPath,
      expectedRevision: 1,
      mutate(s) {
        s.questions[0].selectedOptionId = 'b';
        s.questions[0].status = 'answered';
        s.questions[0].answer = 'I chose B';
      },
    });
    expect(next.questions[0].selectedOptionId).toBe('b');
    expect(next.questions[0].status).toBe('answered');
    expect(next.questions[0].answer).toBe('I chose B');
  });

  test('rejects selectedOptionId that does not match any option.id', () => {
    const source = writeSource();
    const sessionPath = path.join(tmp, 'opts-bad-sel.json');
    createSession({
      sessionPath,
      kind: 'prd',
      sourcePath: source,
      questions: [
        {
          id: 'q1',
          prompt: 'Pick',
          options: [{ id: 'a', label: 'A' }],
        },
      ],
    });
    expect(() =>
      mutateSession({
        sessionPath,
        expectedRevision: 1,
        mutate(s) {
          s.questions[0].selectedOptionId = 'missing';
        },
      }),
    ).toThrow(/selectedOptionId/);
  });
});

describe('migrateOrCreate', () => {
  function setupSource(extra = '') {
    const src = path.join(tmp, 'doc.md');
    fs.writeFileSync(src, SAMPLE_MD + extra);
    const sessionPath = path.join(tmp, 'session.json');
    return { src, sessionPath };
  }

  test('creates a fresh session when none exists', () => {
    const { src, sessionPath } = setupSource();
    const questions = [
      { id: 'q1', prompt: 'first?', targetAnchor: { lineStart: 1, lineEnd: 2 }, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], recommendedOptionId: 'a' },
    ];
    const { session, token } = migrateOrCreate({ sessionPath, kind: 'prd', sourcePath: src, questions });
    expect(session.questions).toHaveLength(1);
    expect(session.questions[0].targetAnchor).toEqual({ lineStart: 1, lineEnd: 2 });
    expect(session.questions[0].options.map((o) => o.id)).toEqual(['a', 'b']);
    expect(session.questions[0].recommendedOptionId).toBe('a');
    expect(session.revision).toBe(1);
    expect(typeof token).toBe('string');
    expect(token).toHaveLength(64);
  });

  test('migrates an existing session additively without clobbering user state', () => {
    const { src, sessionPath } = setupSource();

    // Seed a "prior" session with no options (so selectedOptionId must be
    // null) and a pre-existing user answer on q1. This matches the real
    // scenario after a schema bump: prior questions had no options, so
    // users could only answer via free text.
    const seeded = createSession({
      sessionPath,
      kind: 'prd',
      sourcePath: src,
      questions: [
        { id: 'q1', prompt: 'first?' },
        { id: 'q2', prompt: 'second?' },
      ],
    });
    mutateSession({
      sessionPath,
      expectedRevision: 1,
      mutate(s) {
        const q = s.questions.find((x) => x.id === 'q1');
        q.status = 'answered';
        q.answer = 'user said yes';
        q.author = 'user';
        q.updatedAt = new Date().toISOString();
      },
    });

    const sessionIdBefore = seeded.session.sessionId;
    const revisionBefore = loadSession(sessionPath).revision;

    const { session, token } = migrateOrCreate({
      sessionPath,
      kind: 'prd',
      sourcePath: src,
      migrate(s) {
        const opts = [{ id: 'a', label: 'Yes' }, { id: 'b', label: 'No' }];
        for (const q of s.questions) {
          q.targetAnchor = { lineStart: 1, lineEnd: 2 };
          q.options = opts;
          q.recommendedOptionId = 'a';
        }
      },
    });

    expect(session.sessionId).toBe(sessionIdBefore);
    expect(session.revision).toBe(revisionBefore + 1);
    expect(token).toHaveLength(64);

    const q1 = session.questions.find((q) => q.id === 'q1');
    expect(q1.status).toBe('answered');
    expect(q1.answer).toBe('user said yes');
    expect(q1.selectedOptionId).toBeNull();
    expect(q1.author).toBe('user');
    expect(q1.targetAnchor).toEqual({ lineStart: 1, lineEnd: 2 });
    expect(q1.options.map((o) => o.id)).toEqual(['a', 'b']);
    expect(q1.recommendedOptionId).toBe('a');

    const q2 = session.questions.find((q) => q.id === 'q2');
    expect(q2.status).toBe('open');
    expect(q2.selectedOptionId).toBeNull();
    expect(q2.answer).toBeNull();
    expect(q2.options.map((o) => o.id)).toEqual(['a', 'b']);

    // After migration, selectedOptionId can be set through the normal
    // mutateSession path because options are now present.
    const finalSession = mutateSession({
      sessionPath,
      expectedRevision: session.revision,
      mutate(s) {
        s.questions.find((x) => x.id === 'q2').selectedOptionId = 'a';
      },
    });
  });

  test('returns a fresh token on each call (even without migration)', () => {
    const { src, sessionPath } = setupSource();
    const first = migrateOrCreate({
      sessionPath,
      kind: 'prd',
      sourcePath: src,
      questions: [{ id: 'q1', prompt: 'first?' }],
    });
    const second = migrateOrCreate({
      sessionPath,
      kind: 'prd',
      sourcePath: src,
      migrate(s) { /* no-op */ },
    });
    expect(first.token).not.toBe(second.token);
  });

  test('throws SESSION_COMPLETED on a frozen session', () => {
    const { src, sessionPath } = setupSource();
    createSession({
      sessionPath,
      kind: 'prd',
      sourcePath: src,
      questions: [{ id: 'q1', prompt: 'first?' }],
    });
    mutateSession({
      sessionPath,
      expectedRevision: 1,
      mutate(s) {
        s.completedAt = new Date().toISOString();
        s.completedBy = 'tester';
      },
    });

    expect(() =>
      migrateOrCreate({ sessionPath, kind: 'prd', sourcePath: src, migrate(s) {} }),
    ).toThrow(/completed/);
  });
});
