/**
 * Tests for the refinement-review server module.
 *
 * Uses real Node http clients (not supertest) so behavior is observed at
 * the same boundary the browser UI would see.
 */
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const sessionLib = require('../../lib/refinement-review/session');
const { startServer } = require('../../lib/refinement-review/server');

const SAMPLE_MD = [
  '# Sample PRD',
  '',
  '## Overview',
  '',
  'Intro paragraph for testing.',
  '',
  '### Acceptance Criteria',
  '',
  '- criterion A',
  '- criterion B',
  '',
  '## Open Questions',
  '',
].join('\n');

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-server-'));
});
afterEach(async () => {
  // Tear down every server created in this test so Jest can exit cleanly.
  // Each test calls setupServer() which returns a fresh server; without this
  // hook the suite leaks a TCP listener per test (Jest warns "did not exit").
  while (activeServers.length > 0) {
    const s = activeServers.pop();
    try { await s.stop(); } catch (_) { /* already closed */ }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeSource(content = SAMPLE_MD) {
  const p = path.join(tmp, 'doc.md');
  fs.writeFileSync(p, content);
  return p;
}

function writeUi() {
  const dir = path.join(tmp, 'ui');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>x</title>');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1)');
  return dir;
}

// Module-scoped list of servers awaiting teardown. Populated by setupServer
// and drained by the global afterEach above.
const activeServers = [];

async function setupServer(extra = {}) {
  const source = writeSource();
  const sessionPath = path.join(tmp, 'session.json');
  const { session, token } = sessionLib.createSession({
    sessionPath,
    kind: 'prd',
    sourcePath: source,
    questions: [{ id: 'q1', prompt: 'First?' }, { id: 'q2', prompt: 'Second?' }],
  });
  const uiDir = extra.uiDir !== false ? writeUi() : null;
  const server = await startServer({
    sessionPath,
    token,
    uiDir,
    log: () => {},
    logError: () => {},
  });
  activeServers.push(server);
  return { source, sessionPath, token, session, server, uiDir };
}

function request(server, method, path, { token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: server.host,
        port: server.port,
        method,
        path,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString('utf8');
          let json = null;
          const ct = (res.headers['content-type'] || '').toLowerCase();
          if (ct.includes('application/json')) {
            try {
              json = JSON.parse(text);
            } catch (_) {
              /* leave null */
            }
          }
          resolve({ status: res.statusCode, headers: res.headers, body: buf, text, json });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

describe('auth', () => {
  test('rejects missing token with 401', async () => {
    const { server } = await setupServer();
    const r = await request(server, 'GET', '/api/session');
    expect(r.status).toBe(401);
  });

  test('rejects wrong token with 401', async () => {
    const { server } = await setupServer();
    const r = await request(server, 'GET', '/api/session', { token: 'wrong' });
    expect(r.status).toBe(401);
  });

  test('accepts query token for SSE (event source cannot set headers)', async () => {
    const { server, token } = await setupServer();
    // The SSE endpoint is GET /api/events; we just check that token-in-query
    // is accepted (the connection itself is long-lived; verify 200 not 401).
    const r = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: server.host,
          port: server.port,
          method: 'GET',
          path: `/api/events?token=${encodeURIComponent(token)}`,
          headers: { accept: 'text/event-stream' },
        },
        (res) => {
          resolve({ status: res.statusCode });
          res.on('data', () => {});
          req.destroy();
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(r.status).toBe(200);
  });
});

describe('GET /api/session', () => {
  test('returns the envelope', async () => {
    const { server, token } = await setupServer();
    const r = await request(server, 'GET', '/api/session', { token });
    expect(r.status).toBe(200);
    expect(r.json.schemaVersion).toBe(1);
    expect(r.json.document.kind).toBe('prd');
    expect(r.json.questions).toHaveLength(2);
  });
});

describe('GET /api/document', () => {
  test('returns the markdown with ETag', async () => {
    const { server, token } = await setupServer();
    const r = await request(server, 'GET', '/api/document', { token });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/markdown/);
    expect(r.text).toBe(SAMPLE_MD);
    expect(r.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
  });

  test('honors If-None-Match → 304', async () => {
    const { server, token } = await setupServer();
    const first = await request(server, 'GET', '/api/document', { token });
    const etag = first.headers.etag;
    const second = await request(server, 'GET', '/api/document', {
      token,
      headers: { 'if-none-match': etag },
    });
    expect(second.status).toBe(304);
  });
});

describe('PATCH /api/questions/:id', () => {
  test('updates a question, bumps revision, returns envelope', async () => {
    const { server, token } = await setupServer();
    const r = await request(server, 'PATCH', '/api/questions/q1', {
      token,
      body: { revision: 1, status: 'answered', answer: 'A1', author: 'pm' },
    });
    expect(r.status).toBe(200);
    expect(r.json.revision).toBe(2);
    expect(r.json.questions[0].status).toBe('answered');
    expect(r.json.questions[0].answer).toBe('A1');
    expect(r.json.questions[0].author).toBe('pm');
  });

  test('rejects stale revision with 409', async () => {
    const { server, token } = await setupServer();
    const a = await request(server, 'PATCH', '/api/questions/q1', {
      token,
      body: { revision: 1, status: 'answered', answer: 'A1', author: 'pm' },
    });
    expect(a.status).toBe(200);
    const b = await request(server, 'PATCH', '/api/questions/q2', {
      token,
      body: { revision: 1, status: 'answered', answer: 'A2', author: 'pm' },
    });
    expect(b.status).toBe(409);
    expect(b.json.code).toBe('REVISION_CONFLICT');
    expect(b.json.currentRevision).toBe(2);
  });

  test('rejects unknown question with 404', async () => {
    const { server, token } = await setupServer();
    const r = await request(server, 'PATCH', '/api/questions/nope', {
      token,
      body: { revision: 1, status: 'answered', answer: 'x', author: 'pm' },
    });
    expect(r.status).toBe(404);
  });

  test('rejects invalid status with 400', async () => {
    const { server, token } = await setupServer();
    const r = await request(server, 'PATCH', '/api/questions/q1', {
      token,
      body: { revision: 1, status: 'bogus', answer: 'x', author: 'pm' },
    });
    expect(r.status).toBe(400);
  });
});

describe('POST /api/comments', () => {
  test('adds a comment, bumps revision', async () => {
    const { server, token } = await setupServer();
    const r = await request(server, 'POST', '/api/comments', {
      token,
      body: {
        revision: 1,
        body: 'Looks good',
        anchor: { section: '## Overview', lineStart: 1, lineEnd: 4, selectedText: '## Overview' },
        author: 'dev',
      },
    });
    expect(r.status).toBe(201);
    expect(r.json.revision).toBe(2);
    expect(r.json.comments).toHaveLength(1);
    expect(r.json.comments[0].body).toBe('Looks good');
  });

  test('rejects anchor with line out of bounds', async () => {
    const { server, token } = await setupServer();
    const r = await request(server, 'POST', '/api/comments', {
      token,
      body: {
        revision: 1,
        body: 'Bad',
        anchor: { section: null, lineStart: 9999, lineEnd: 9999, selectedText: null },
        author: 'dev',
      },
    });
    expect(r.status).toBe(400);
  });

  test('accepts null anchor (general comment)', async () => {
    const { server, token } = await setupServer();
    const r = await request(server, 'POST', '/api/comments', {
      token,
      body: { revision: 1, body: 'General', anchor: null, author: 'dev' },
    });
    expect(r.status).toBe(201);
    expect(r.json.comments[0].anchor).toBeNull();
  });
  // Regression: a comment anchored to a range that covers a markdown table
  // (header through last data row) must validate and persist. The earlier
  // round of tests only exercised heading-only ranges; the user-facing bug
  // surfaced when an NFR table review tried to anchor lines 457..469.
  test('accepts anchor whose lineEnd spans an entire table range', async () => {
    const TABLE_SOURCE = [
      '# PRD',                                  // line 1
      '',                                       // line 2
      '## NFR Section',                         // line 3
      '',                                       // line 4
      'Intro for NFRs.',                        // line 5
      '',                                       // line 6
      '| ID | Requirement | Target |',          // line 7  table header
      '|----|----|----|',                       // line 8  table separator
      '| NFR1.2 | Update latency | <500ms |',    // line 9
      '| NFR2.3 | State consistency | <5s |',    // line 10
      '| NFR3.1 | Audit log retention | 30d |', // line 11
    ].join('\n');

    const source = writeSource(TABLE_SOURCE);
    const sessionPath = path.join(tmp, 'session-table.json');
    const { token } = sessionLib.createSession({
      sessionPath,
      kind: 'prd',
      sourcePath: source,
      questions: [{ id: 'q-table', prompt: 'Verify NFR table range?' }],
    });
    const uiDir = writeUi();
    const server = await startServer({
      sessionPath,
      token,
      uiDir,
      log: () => {},
      logError: () => {},
    });

    // Anchor across the full 5-row table: lineStart at header, lineEnd at
    // last row. selectedText stays null because the range is multi-line.
    let r;
    try {
      r = await request(server, 'POST', '/api/comments', {
        token,
        body: {
          revision: 1,
          body: 'Verify NFR rows highlight together on nav',
          anchor: {
            section: '## NFR Section',
            lineStart: 7,
            lineEnd: 11,
            selectedText: null,
          },
          author: 'qa',
        },
      });
    } finally {
      await server.stop();
    }

    expect(r.status).toBe(201);
    expect(r.json.revision).toBe(2);
    expect(r.json.comments).toHaveLength(1);
    const stored = r.json.comments[0];
    expect(stored.author).toBe('qa');
    expect(stored.body).toBe('Verify NFR rows highlight together on nav');
    expect(stored.anchor.lineStart).toBe(7);
    expect(stored.anchor.lineEnd).toBe(11);
    expect(stored.anchor.lineEnd - stored.anchor.lineStart).toBe(4); // inclusive range
    expect(stored.anchor.selectedText).toBeNull();

    // validateAnchor (the underlying primitive) must accept the same shape
    // with no error for a table span whose lineEnd lands at the last row.
    const err = sessionLib.validateAnchor(
      { section: '## NFR Section', lineStart: 7, lineEnd: 11, selectedText: null },
      11
    );
    expect(err).toBeNull();
  });

});

describe('PATCH /api/comments/:id', () => {
  test('updates body and resolves', async () => {
    const { server, token } = await setupServer();
    const created = await request(server, 'POST', '/api/comments', {
      token,
      body: { revision: 1, body: 'Original', anchor: null, author: 'dev' },
    });
    const cid = created.json.comments[0].id;
    const patched = await request(server, 'PATCH', `/api/comments/${cid}`, {
      token,
      body: { revision: 2, body: 'Edited', resolved: true, author: 'pm' },
    });
    expect(patched.status).toBe(200);
    expect(patched.json.comments[0].body).toBe('Edited');
    expect(patched.json.comments[0].resolvedAt).not.toBeNull();
  });
});

describe('POST /api/complete', () => {
  test('freezes session, writes artifact, returns 410 afterwards', async () => {
    const { server, token } = await setupServer();
    await request(server, 'PATCH', '/api/questions/q1', {
      token,
      body: { revision: 1, status: 'answered', answer: 'A1', author: 'pm' },
    });
    const complete = await request(server, 'POST', '/api/complete', {
      token,
      body: { revision: 2, author: 'pm' },
    });
    expect(complete.status).toBe(200);
    expect(complete.json.artifactPath).toBeDefined();
    expect(fs.existsSync(complete.json.artifactPath)).toBe(true);
    const artifact = JSON.parse(fs.readFileSync(complete.json.artifactPath, 'utf8'));
    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.questions[0].answer).toBe('A1');

    // Subsequent mutations: 410
    const after = await request(server, 'PATCH', '/api/questions/q2', {
      token,
      body: { revision: 3, status: 'answered', answer: 'A2', author: 'pm' },
    });
    expect(after.status).toBe(410);

    // GET /api/session still returns the envelope but completedAt is set
    const sess = await request(server, 'GET', '/api/session', { token });
    expect(sess.json.completedAt).not.toBeNull();
  });

  test('rejects second complete', async () => {
    const { server, token } = await setupServer();
    const first = await request(server, 'POST', '/api/complete', {
      token,
      body: { revision: 1, author: 'pm' },
    });
    expect(first.status).toBe(200);
    const second = await request(server, 'POST', '/api/complete', {
      token,
      body: { revision: 2, author: 'pm' },
    });
    expect(second.status).toBe(410);
  });
});

describe('startServer.completed promise', () => {
  test('resolves with {artifactPath, session} when /api/complete succeeds', async () => {
    const { server, token, sessionPath } = await setupServer();
    // Kick off a race: POST /api/complete and await server.completed.
    const [completeResp, completed] = await Promise.all([
      request(server, 'POST', '/api/complete', {
        token,
        body: { revision: 1, author: 'pm' },
      }),
      Promise.race([
        server.completed,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('completed promise timed out')), 3000),
        ),
      ]),
    ]);
    expect(completeResp.status).toBe(200);
    expect(completed.artifactPath).toBe(completeResp.json.artifactPath);
    expect(fs.existsSync(completed.artifactPath)).toBe(true);
    expect(completed.session.schemaVersion).toBe(1);
    expect(completed.session.completedAt).not.toBeNull();
    expect(completed.session.completedBy).toBe('pm');
    expect(completed.session.questions).toHaveLength(2);
    expect(completed.session.questions[0].id).toBe('q1');

    // Sanity: artifact on disk matches what the promise resolved with.
    const onDisk = JSON.parse(fs.readFileSync(completed.artifactPath, 'utf8'));
    expect(onDisk.sessionId).toBe(completed.session.sessionId);
    expect(path.dirname(completed.artifactPath)).toBe(path.dirname(sessionPath));

    await server.stop();
  });

  test('completion artifact preserves targetAnchor on each question', async () => {
    // Build a session with targetAnchor on one question so we can verify it
    // survives the artifact write (both via server.completed and on disk).
    const source = writeSource();
    const sessionPath = path.join(tmp, 'ta-session.json');
    const { session, token } = sessionLib.createSession({
      sessionPath,
      kind: 'prd',
      sourcePath: source,
      questions: [
        {
          id: 'qa',
          prompt: 'Why?',
          targetAnchor: { lineStart: 3, lineEnd: 5, highlightText: 'fragment' },
        },
        { id: 'qb', prompt: 'How?' }, // no targetAnchor — must default to null
      ],
    });
    expect(session.questions[0].targetAnchor).toEqual({
      lineStart: 3,
      lineEnd: 5,
      highlightText: 'fragment',
    });
    expect(session.questions[1].targetAnchor).toBeNull();

    const server = await startServer({
      sessionPath,
      token,
      uiDir: writeUi(),
      log: () => {},
      logError: () => {},
    });
    try {
      // Trigger completion; the same request the UI makes.
      const resp = await request(server, 'POST', '/api/complete', {
        token,
        body: { revision: 1, author: 'pm' },
      });
      expect(resp.status).toBe(200);

      const completed = await Promise.race([
        server.completed,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('completed promise timed out')), 3000),
        ),
      ]);

      // Resolved via server.completed
      expect(completed.session.questions[0].targetAnchor).toEqual({
        lineStart: 3,
        lineEnd: 5,
        highlightText: 'fragment',
      });
      expect(completed.session.questions[1].targetAnchor).toBeNull();

      // And persisted to disk in the artifact JSON
      const onDisk = JSON.parse(fs.readFileSync(completed.artifactPath, 'utf8'));
      expect(onDisk.questions[0].targetAnchor).toEqual({
        lineStart: 3,
        lineEnd: 5,
        highlightText: 'fragment',
      });
      expect(onDisk.questions[1].targetAnchor).toBeNull();
    } finally {
      await server.stop();
    }
  });

  test('remains pending until /api/complete is called, then resolves', async () => {
    const { server, token } = await setupServer();
    // After setupServer, completed is still pending (no /api/complete yet).
    let settled = false;
    server.completed.then(() => { settled = true; }).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);

    await request(server, 'POST', '/api/complete', {
      token,
      body: { revision: 1, author: 'pm' },
      headers: { 'x-wait': '50' },
    }).catch(() => {});

    const result = await Promise.race([
      server.completed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('completed promise timed out')), 3000),
      ),
    ]);
    expect(result.artifactPath).toBeDefined();
    expect(result.session.completedAt).not.toBeNull();
    await server.stop();
  });
});

describe('two-client collaboration', () => {
  /**
   * Drive the canonical two-client scenario from the plan:
   *   A answers Q1, B observes via SSE, B comments, A stale, A reloads
   *   and answers Q2, complete, artifact matches.
   */
  test('A answers, B observes via SSE, B comments, A stale 409, A answers Q2, complete', async () => {
    const { server, token } = await setupServer();

    // Open B's SSE stream
    const events = [];
    let sseReq;
    const sseReady = new Promise((resolve, reject) => {
      sseReq = http.request(
        {
          hostname: server.host,
          port: server.port,
          method: 'GET',
          path: `/api/events?token=${encodeURIComponent(token)}`,
          headers: { accept: 'text/event-stream' },
        },
        (res) => {
          expect(res.statusCode).toBe(200);
          res.setEncoding('utf8');
          let buf = '';
          res.on('data', (chunk) => {
            buf += chunk;
            let idx;
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const frame = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              const lines = frame.split('\n');
              let event = 'message';
              let data = '';
              for (const line of lines) {
                if (line.startsWith('event:')) event = line.slice(6).trim();
                else if (line.startsWith('data:')) data += line.slice(5).trim();
              }
              if (event === 'session' && data) {
                try {
                  events.push(JSON.parse(data));
                } catch (_) {
                  /* ignore */
                }
              }
            }
          });
          res.on('end', () => resolve());
          res.on('error', reject);
          resolve();
        },
      );
      sseReq.on('error', reject);
      sseReq.end();
    });
    await sseReady;

    // A answers Q1 (revision 1 → 2)
    const a1 = await request(server, 'PATCH', '/api/questions/q1', {
      token,
      body: { revision: 1, status: 'answered', answer: 'A1', author: 'pm' },
    });
    expect(a1.status).toBe(200);

    // B observes the change via SSE
    await new Promise((r) => setTimeout(r, 50));
    expect(events.length).toBeGreaterThanOrEqual(1);
    const lastSeen = events[events.length - 1];
    expect(lastSeen.questions[0].answer).toBe('A1');
    expect(lastSeen.revision).toBe(2);

    // B adds an anchored comment (revision 2 → 3)
    const b1 = await request(server, 'POST', '/api/comments', {
      token,
      body: {
        revision: 2,
        body: 'B comment',
        anchor: { section: '## Overview', lineStart: 1, lineEnd: 4, selectedText: '## Overview' },
        author: 'dev',
      },
    });
    expect(b1.status).toBe(201);
    expect(b1.json.revision).toBe(3);

    // A attempts a stale PATCH (still thinks revision is 2)
    const stale = await request(server, 'PATCH', '/api/questions/q2', {
      token,
      body: { revision: 2, status: 'answered', answer: 'A2-stale', author: 'pm' },
    });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('REVISION_CONFLICT');
    expect(stale.json.currentRevision).toBe(3);

    // A reloads (we simulate by re-reading /api/session) and answers Q2 at rev 3
    const reloaded = await request(server, 'GET', '/api/session', { token });
    expect(reloaded.json.revision).toBe(3);
    const a2 = await request(server, 'PATCH', '/api/questions/q2', {
      token,
      body: { revision: 3, status: 'answered', answer: 'A2', author: 'pm' },
    });
    expect(a2.status).toBe(200);
    expect(a2.json.revision).toBe(4);
    expect(a2.json.questions[1].answer).toBe('A2');

    // Complete at revision 4
    const complete = await request(server, 'POST', '/api/complete', {
      token,
      body: { revision: 4, author: 'pm' },
    });
    expect(complete.status).toBe(200);

    // Artifact matches exactly what was submitted
    const artifact = JSON.parse(fs.readFileSync(complete.json.artifactPath, 'utf8'));
    expect(artifact.questions).toHaveLength(2);
    expect(artifact.questions[0]).toMatchObject({
      id: 'q1',
      status: 'answered',
      answer: 'A1',
      author: 'pm',
    });
    expect(artifact.questions[1]).toMatchObject({
      id: 'q2',
      status: 'answered',
      answer: 'A2',
      author: 'pm',
    });
    expect(artifact.comments).toHaveLength(1);
    expect(artifact.comments[0]).toMatchObject({
      body: 'B comment',
      author: 'dev',
      anchor: {
        section: '## Overview',
        lineStart: 1,
        lineEnd: 4,
        selectedText: '## Overview',
      },
    });
    expect(artifact.completedBy).toBe('pm');
    expect(artifact.completedAt).toBeDefined();

    sseReq.destroy();
    await server.stop();
  });
});

describe('static UI', () => {
  test('serves index.html at /', async () => {
    const { server, token } = await setupServer();
    const r = await request(server, 'GET', '/');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.text).toContain('<title>x</title>');
  });

  test('serves app.js with correct content type', async () => {
    const { server } = await setupServer();
    const r = await request(server, 'GET', '/app.js');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/javascript/);
  });

  test('rejects path traversal', async () => {
    const { server } = await setupServer();
    const r = await request(server, 'GET', '/../session.json');
    expect([403, 404]).toContain(r.status);
  });
});

describe('auto-open share URL', () => {
  // The opener is module-scoped inside server.js; mock it via jest.mock so
  // the assertion can capture exactly what `startServer` passes in. A real
  // platform-opener would attempt to spawn `open`/`xdg-open`/`cmd` which is
  // not appropriate in CI or unit-test runs.
  jest.mock('../../lib/refinement-review/opener', () => {
    const actual = jest.requireActual('../../lib/refinement-review/opener');
    return {
      ...actual,
      openUrl: jest.fn(() => Promise.resolve({ opened: true, command: 'open <url>' })),
    };
  });

  // Re-require AFTER the mock is installed so server.js picks up the stub.
  let openerMock;
  let startServerFresh;
  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../../lib/refinement-review/opener', () => {
      const actual = jest.requireActual('../../lib/refinement-review/opener');
      return {
        ...actual,
        openUrl: jest.fn(() => Promise.resolve({ opened: true, command: 'open <url>' })),
      };
    });
    openerMock = require('../../lib/refinement-review/opener');
    startServerFresh = require('../../lib/refinement-review/server').startServer;
  });

  test('open:true calls opener with encoded share URL; log sink is token-free', async () => {
    // Token deliberately includes every character whose encoding differs
    // between encodeURIComponent and the literal so the assertion catches
    // a forgotten encodeURIComponent call (a hex token would pass either way).
    const exoticToken = 'abc/&?token=x';
    const source = writeSource();
    const sessionPath = path.join(tmp, 'session.json');
    sessionLib.createSession({
      sessionPath,
      kind: 'prd',
      sourcePath: source,
      questions: [{ id: 'q1', prompt: 'First?' }],
    });
    const uiDir = writeUi();

    const logLines = [];
    const log = jest.fn((msg) => logLines.push(String(msg)));
    const logError = jest.fn();

    const server = await startServerFresh({
      sessionPath,
      token: exoticToken,
      uiDir,
      log,
      logError,
      open: true,
    });
    activeServers.push(server);

    // reviewUrl composes encodeURIComponent(token), proving the server
    // does NOT pass the raw token to the opener.
    const expectedReviewUrl = `${server.url}/?token=${encodeURIComponent(exoticToken)}`;
    expect(server.reviewUrl).toBe(expectedReviewUrl);

    // The opener was called exactly once with the encoded share URL and no
    // openerOpts.
    expect(openerMock.openUrl).toHaveBeenCalledTimes(1);
    expect(openerMock.openUrl).toHaveBeenCalledWith(expectedReviewUrl, {});

    // Wait for the fire-and-forget openResult to settle so we can inspect it.
    const openResult = await server.openResult;
    expect(openResult.opened).toBe(true);

    // Every line that flowed through `log` is token-free. The token, in
    // any of its forms (raw, partially encoded, fully encoded), must NOT
    // appear anywhere the log sink sees.
    expect(log).toHaveBeenCalled();
    for (const line of logLines) {
      expect(line).not.toContain(exoticToken);
      expect(line).not.toContain(encodeURIComponent(exoticToken));
      // The raw decoded token includes '/', '&', '?'; their presence in
      // the log line would indicate a leak even if the literal string
      // is not assembled.
      expect(line).not.toContain('abc/&?token=x');
    }

    // And the encoded form was never logged either (would indicate the
    // server copy-pasted the share URL into log).
    for (const line of logLines) {
      expect(line).not.toContain('abc%2F%26%3Ftoken%3Dx');
    }

    // logError was never called: a token-bearing log would have been
    // re-routed to logError first; assert no spurious errors.
    expect(logError).not.toHaveBeenCalled();

    await server.stop();
  });

  test('open:false (default) still returns reviewUrl for manual fallback but skips opener', async () => {
    const { server, token } = await setupServer();
    // Opener was NOT called because `open` was not passed.
    expect(openerMock.openUrl).not.toHaveBeenCalled();
    // reviewUrl is ALWAYS composed so the bootstrap can print the share URL
    // for manual fallback even when auto-open is suppressed (CI / --no-open /
    // non-TTY). It must equal the encoded share URL.
    expect(server.reviewUrl).toBe(`${server.url}/?token=${encodeURIComponent(token)}`);
    // openResult is null because the opener was not invoked.
    expect(server.openResult).toBeNull();
  });

  test('opener exception is captured in openResult (does not reject or throw)', async () => {
    // Swap the mock to throw synchronously from the Promise constructor so
    // the .catch on the server's openResult wrapper is exercised.
    openerMock.openUrl.mockImplementationOnce(() =>
      Promise.reject(new Error('opener blew up')),
    );
    const source = writeSource();
    const sessionPath = path.join(tmp, 'session.json');
    sessionLib.createSession({
      sessionPath,
      kind: 'prd',
      sourcePath: source,
      questions: [{ id: 'q1', prompt: 'First?' }],
    });
    const uiDir = writeUi();
    const server = await startServerFresh({
      sessionPath,
      token: 'hex',
      uiDir,
      log: () => {},
      logError: () => {},
      open: true,
    });
    activeServers.push(server);

    const openResult = await server.openResult;
    expect(openResult.opened).toBe(false);
    expect(openResult.reason).toBe('exception');
    expect(openResult.error).toMatch(/opener blew up/);
    await server.stop();
  });
});
