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
afterEach(() => {
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
