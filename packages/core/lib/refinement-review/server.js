/**
 * Local-only refinement-review HTTP server.
 *
 * Serves the session API and a small browser UI over Node's built-in `http`.
 * Binds to `127.0.0.1` by default; `--host` overrides for team access. Every
 * API route requires a per-session bearer token. The session envelope is
 * authoritative; mutations go through `session.mutateSession` so optimistic
 * concurrency and document-integrity guarantees are preserved.
 *
 * @module @sunstone-partners/ensemble-core/refinement-review/server
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const session = require('./session');
const { openUrl } = require('./opener');
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 0; // let the OS assign

/**
 * Serialize a session envelope to JSON with no whitespace for SSE.
 * @param {object} envelope
 */
function jsonStringify(envelope) {
  return JSON.stringify(envelope);
}

/**
 * Read the full request body into a Buffer.
 * @param {http.IncomingMessage} req
 * @param {number} limit - max bytes (default 1 MiB)
 * @returns {Promise<Buffer>}
 */
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Parse the bearer token from a request. Accepts:
 *   - `Authorization: Bearer <token>` header
 *   - `?token=<token>` query parameter (used by SSE clients that cannot
 *     easily set headers on `EventSource`)
 * @param {http.IncomingMessage} req
 * @param {URL} url
 * @returns {string|null}
 */
function tokenFromRequest(req, url) {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(\S+)$/.exec(auth);
    if (m) return m[1];
  }
  return url.searchParams.get('token');
}

/**
 * Write a JSON response. Sets `Content-Type: application/json` and
 * the provided status. Adds a `Cache-Control: no-store` header so
 * clients always revalidate against the server.
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function writeJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

/**
 * @typedef {object} ServerOptions
 * @property {string} sessionPath - path to the session JSON file
 * @property {string} token - bearer token required on every API route
 * @property {string} [host] - bind host (default 127.0.0.1)
 * @property {number} [port] - bind port (default 0 = random)
 * @property {string} [uiDir] - static UI directory (served at `/`)
 * @property {string} [artifactPath] - where to write the response snapshot
 * @property {(msg: string) => void} [logError]
 * @property {boolean} [open=false] - attempt to open the share URL
 *   (`<url>/?token=<token>`) in the user's default browser after binding.
 *   The opener is invoked fire-and-forget; the returned `openResult`
 *   Promise resolves with `{ opened, reason?, command? }` so the caller
 *   can decide whether to log a fallback. NEVER include the token in any
 *   log sink: the opener is called with the encoded share URL directly
 *   and the log continues to receive only the bare URL.
 * @property {object} [openerOpts] - forwarded to `openUrl`; allows tests
 *   to inject a `platform` and a stub `spawn`.
 */

/**
 * Start the refinement-review server.
 * @param {ServerOptions} opts
 * @returns {Promise<{url: string, port: number, host: string, stop: () => Promise<void>, completed: Promise<{artifactPath: string, session: object}>, address: {address: string, port: number, family: string}, reviewUrl: string, openResult: Promise<{opened: boolean, reason?: string, command?: string}> | null}>}
 */
async function startServer(opts) {
  if (!opts || typeof opts.sessionPath !== 'string')
    throw new Error('sessionPath is required');
  if (typeof opts.token !== 'string' || !opts.token)
    throw new Error('token is required');

  const host = opts.host || DEFAULT_HOST;
  const explicitPort = opts.port || DEFAULT_PORT;
  const uiDir = opts.uiDir ? path.resolve(opts.uiDir) : null;
  const artifactPath =
    opts.artifactPath || `${opts.sessionPath}.response.json`;
  const log = opts.log || (() => {});
  const logError = opts.logError || log;

  // Resolves with `{ artifactPath, session }` when the reviewer hits Complete
  // in the UI (POST /api/complete). Rejects if completion fails. Foreground
  // launchers should `await` this instead of polling the artifact file.
  let resolveCompleted, rejectCompleted;
  const completed = new Promise((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  const subscribers = new Set();
  /** Serializes mutation-driven persistence so two concurrent writers don't trample each other. */
  let writeChain = Promise.resolve();

  /**
   * Broadcast the current envelope to every SSE subscriber. Errors per
   * subscriber are logged but never thrown — one slow client must not
   * break the broadcast for the rest.
   */
  function broadcast(envelope) {
    const payload = `event: session\ndata: ${jsonStringify(envelope)}\n\n`;
    for (const res of subscribers) {
      try {
        res.write(payload);
      } catch (e) {
        logError(`sse write failed: ${e.message}`);
      }
    }
  }

  /**
   * Run a mutation through session.mutateSession, then broadcast the result.
   * All write paths serialize on `writeChain` so two concurrent requests
   * never race against the persisted JSON.
   */
  function mutate(expectedRevision, mutator) {
    const job = writeChain.then(async () => {
      const next = session.mutateSession({
        sessionPath: opts.sessionPath,
        expectedRevision,
        mutate: mutator,
      });
      broadcast(next);
      return next;
    });
    writeChain = job.catch(() => undefined);
    return job;
  }

  /**
   * Per-request handler. Resolves with nothing; routes return via `res`.
   */
  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const method = req.method || 'GET';

    // Static UI: anything not under /api is served from uiDir.
    const isApi = url.pathname.startsWith('/api/');
    if (!isApi) {
      if (!uiDir) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      // Resolve a safe file path; reject anything that escapes uiDir.
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/') rel = '/index.html';
      const filePath = path.join(uiDir, rel);
      if (!filePath.startsWith(uiDir + path.sep) && filePath !== uiDir) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('forbidden');
        return;
      }
      fs.stat(filePath, (err, st) => {
        if (err || !st.isFile()) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('not found');
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const ct =
          ext === '.html'
            ? 'text/html; charset=utf-8'
            : ext === '.js'
              ? 'application/javascript; charset=utf-8'
              : ext === '.css'
                ? 'text/css; charset=utf-8'
                : ext === '.json'
                  ? 'application/json; charset=utf-8'
                  : 'application/octet-stream';
        res.writeHead(200, {
          'content-type': ct,
          'content-length': st.size,
          'cache-control': 'no-store',
        });
        fs.createReadStream(filePath).pipe(res);
      });
      return;
    }

    // All API routes require the bearer token.
    const provided = tokenFromRequest(req, url);
    if (provided !== opts.token) {
      writeJson(res, 401, { error: 'unauthorized' });
      return;
    }

    // SSE: GET /api/events (token via query param)
    if (method === 'GET' && url.pathname === '/api/events') {
      const envelope = session.loadSession(opts.sessionPath);
      if (envelope.completedAt) {
        writeJson(res, 410, { error: 'session completed' });
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      // Initial snapshot.
      res.write(`event: session\ndata: ${jsonStringify(envelope)}\n\n`);
      subscribers.add(res);
      const heartbeat = setInterval(() => {
        try {
          res.write(': heartbeat\n\n');
        } catch (_) {
          /* socket closed */
        }
      }, 25_000);
      // Don't let the heartbeat alone keep the loop alive once everything
      // else has settled (tests, dev tooling).
      if (typeof heartbeat.unref === 'function') heartbeat.unref();
      req.on('close', () => {
        clearInterval(heartbeat);
        subscribers.delete(res);
      });
      return;
    }

    // GET /api/session
    if (method === 'GET' && url.pathname === '/api/session') {
      const envelope = session.loadSession(opts.sessionPath);
      writeJson(res, 200, envelope);
      return;
    }

    // GET /api/document
    if (method === 'GET' && url.pathname === '/api/document') {
      const envelope = session.loadSession(opts.sessionPath);
      const content = fs.readFileSync(envelope.document.sourcePath);
      const etag = `"${envelope.document.sha256}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304);
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-length': content.length,
        etag,
        'cache-control': 'no-store',
      });
      res.end(content);
      return;
    }

    // PATCH /api/questions/:id
    if (method === 'PATCH' && url.pathname.startsWith('/api/questions/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/questions/'.length));
      let body;
      try {
        body = JSON.parse((await readBody(req)).toString('utf8'));
      } catch (e) {
        writeJson(res, 400, { error: 'invalid json' });
        return;
      }
      try {
        const next = mutate(body.revision, (s) => {
          const q = s.questions.find((x) => x.id === id);
          if (!q) throw Object.assign(new Error('question not found'), { status: 404 });
          if (!['open', 'answered', 'skipped'].includes(body.status))
            throw Object.assign(new Error('invalid status'), { status: 400 });
          if (typeof body.author !== 'string' || !body.author)
            throw Object.assign(new Error('author required'), { status: 400 });
          q.status = body.status;
          q.answer = body.answer ?? q.answer;
          q.author = body.author;
          q.updatedAt = new Date().toISOString();
        });
        writeJson(res, 200, await next);
      } catch (e) {
        writeJson(res, e.status || 500, {
          error: e.message,
          code: e.code,
          currentRevision: e.currentRevision,
        });
      }
      return;
    }

    // POST /api/comments
    if (method === 'POST' && url.pathname === '/api/comments') {
      let body;
      try {
        body = JSON.parse((await readBody(req)).toString('utf8'));
      } catch (e) {
        writeJson(res, 400, { error: 'invalid json' });
        return;
      }
      try {
        const next = mutate(body.revision, (s) => {
          if (typeof body.body !== 'string' || !body.body)
            throw Object.assign(new Error('body required'), { status: 400 });
          if (typeof body.author !== 'string' || !body.author)
            throw Object.assign(new Error('author required'), { status: 400 });
          // Validate anchor bounds against current document length.
          if (body.anchor !== null && body.anchor !== undefined) {
            const content = fs.readFileSync(s.document.sourcePath, 'utf8');
            const totalLines = content.split(/\r\n|\r|\n/).length;
            const err = session.validateAnchor(body.anchor, totalLines);
            if (err) throw Object.assign(new Error(err), { status: 400 });
          }
          s.comments.push({
            id: session.newId(),
            body: body.body,
            anchor: body.anchor ?? null,
            author: body.author,
            createdAt: new Date().toISOString(),
            resolvedAt: null,
          });
        });
        writeJson(res, 201, await next);
      } catch (e) {
        writeJson(res, e.status || 500, {
          error: e.message,
          code: e.code,
          currentRevision: e.currentRevision,
        });
      }
      return;
    }

    // PATCH /api/comments/:id
    if (method === 'PATCH' && url.pathname.startsWith('/api/comments/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/comments/'.length));
      let body;
      try {
        body = JSON.parse((await readBody(req)).toString('utf8'));
      } catch (e) {
        writeJson(res, 400, { error: 'invalid json' });
        return;
      }
      try {
        const next = mutate(body.revision, (s) => {
          const c = s.comments.find((x) => x.id === id);
          if (!c) throw Object.assign(new Error('comment not found'), { status: 404 });
          if (typeof body.author !== 'string' || !body.author)
            throw Object.assign(new Error('author required'), { status: 400 });
          if (body.body !== undefined) {
            if (typeof body.body !== 'string' || !body.body)
              throw Object.assign(new Error('body must be non-empty string'), { status: 400 });
            c.body = body.body;
          }
          if (body.resolved === true) c.resolvedAt = new Date().toISOString();
          if (body.resolved === false) c.resolvedAt = null;
        });
        writeJson(res, 200, await next);
      } catch (e) {
        writeJson(res, e.status || 500, {
          error: e.message,
          code: e.code,
          currentRevision: e.currentRevision,
        });
      }
      return;
    }

    // POST /api/complete
    if (method === 'POST' && url.pathname === '/api/complete') {
      let body;
      try {
        body = JSON.parse((await readBody(req)).toString('utf8'));
      } catch (e) {
        writeJson(res, 400, { error: 'invalid json' });
        return;
      }
      try {
        const finalSession = await mutate(body.revision, (s) => {
          if (typeof body.author !== 'string' || !body.author)
            throw Object.assign(new Error('author required'), { status: 400 });
          s.completedAt = new Date().toISOString();
          s.completedBy = body.author;
        });

        // Persist the response artifact.
        const artifact = {
          schemaVersion: 1,
          sessionId: finalSession.sessionId,
          completedAt: finalSession.completedAt,
          completedBy: finalSession.completedBy,
          document: {
            kind: finalSession.document.kind,
            sourcePath: finalSession.document.sourcePath,
            sha256: finalSession.document.sha256,
          },
          questions: finalSession.questions.map((q) => ({
            id: q.id,
            prompt: q.prompt,
            context: q.context,
            targetAnchor: q.targetAnchor,
            status: q.status,

            answer: q.answer,
            author: q.author,
            updatedAt: q.updatedAt,
          })),
          comments: finalSession.comments.map((c) => ({
            id: c.id,
            body: c.body,
            anchor: c.anchor,
            author: c.author,
            createdAt: c.createdAt,
            resolvedAt: c.resolvedAt,
          })),
        };
        session.writeJsonAtomic(artifactPath, artifact);

        // Close all SSE clients; the session is gone.
        for (const sub of subscribers) {
          try {
            sub.end();
          } catch (_) {
            /* already closed */
          }
        }
        subscribers.clear();

        writeJson(res, 200, { artifactPath, session: finalSession });
        resolveCompleted({ artifactPath, session: finalSession });

      } catch (e) {
        writeJson(res, e.status || 500, {
          error: e.message,
          code: e.code,
          currentRevision: e.currentRevision,
        });
      }
      return;
    }

    writeJson(res, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      logError(`unhandled: ${err && err.message}`);
      if (!res.headersSent) writeJson(res, 500, { error: 'internal' });
      else res.end();
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(explicitPort, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string')
    throw new Error('failed to bind server');

  log(`refinement-review listening on http://${addr.address}:${addr.port}`);

  const url = `http://${addr.address}:${addr.port}`;

  // Compose the share URL the SPA actually wants: bare url is unauthenticated
  // and the API would 401. The opener (and any caller that wants to give
  // the user a copy-paste URL) needs `${url}/?token=<encoded token>`. The
  // `log` sink continues to receive only the bare URL — the token is never
  // logged.
  const reviewUrl = `${url}/?token=${encodeURIComponent(opts.token)}`;

  // Fire-and-forget; do not block server startup on the opener. The Promise
  // is returned to the caller so the bootstrap can decide whether to await
  // it for UX feedback. Any rejection (which `openUrl` already catches and
  // converts to a structured result) is also captured here as a final
  // safety net.
  let openResult = null;
  if (opts.open === true) {
    const openerOpts = opts.openerOpts || {};
    openResult = openUrl(reviewUrl, openerOpts).catch((e) => ({
      opened: false,
      reason: 'exception',
      error: e && e.message,
    }));
  }

  function stop() {
    return new Promise((resolve) => {
      for (const sub of subscribers) {
        try {
          sub.end();
        } catch (_) {
          /* already closed */
        }
      }
      subscribers.clear();
      server.close(() => resolve());
    });
  }

  return {
    url,
    host: addr.address,
    port: addr.port,
    address: addr,
    stop,
    completed,
    reviewUrl,
    openResult,
  };
}


module.exports = {
  startServer,
  DEFAULT_HOST,
  DEFAULT_PORT,
  // exposed for tests
  _internal: { tokenFromRequest, readBody, writeJson },
};
