/**
 * Local-only refinement-review HTTP server.
 *
 * Serves the session API and a small browser UI over Node's built-in `http`.
 * Binds to `127.0.0.1` by default; `--host` overrides for team access. Every
 * API route requires a per-session credential. The session envelope is
 * authoritative; mutations go through `session.mutateSession` so optimistic
 * concurrency and document-integrity guarantees are preserved.
 *
 * @module @sunstone-partners/ensemble-core/refinement-review/server
 *
 * Auth model
 * -----------
 * The server speaks three orthogonal secrets:
 *
 *   1. **`opts.token` (bearer).** Durable, per-session. Used by API clients
 *      via `Authorization: Bearer <token>` and by the bootstrap when minting
 *      share URLs. Never written to a cookie. Never logged.
 *
 *   2. **Exchange nonce.** Short-lived (10 min), single-use. Appears in
 *      share URLs as `?nonce=<id>`. Burned atomically on successful
 *      exchange: nonces are STORED ONLY WHILE VALID, deleted on burn, and
 *      are NEVER read back after a successful exchange. Probes that 401
 *      must not mutate the nonce map.
 *
 *   3. **Cookie session id.** Opaque, per-device. Set by `/api/exchange`,
 *      read by the request auth layer. The cookie record maps directly to
 *      `{ sessionPath, csrfKey, expiresAt }` — the bearer is NOT stored in
 *      the cookie. Cookie attributes: `HttpOnly; Secure; SameSite=Strict;
 *      Path=/` (no `Domain=`). The cookie is bound to the exact
 *      `sessionPath` it was minted for, so a SID minted for one session
 *      cannot authorize against a different session in the same process.
 *
 * Defence headers
 * ---------------
 * Every response sets `Referrer-Policy: no-referrer` so URLs carrying a
 * single-use nonce are not leaked via the `Referer` header on outbound
 * navigation. The cookie is the durable surface; the URL is the entry
 * surface; the bearer is the API surface.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const session = require('./session');
const { openUrl } = require('./opener');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 0; // let the OS assign
const NONCE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SESSION_COOKIE_NAME = 'review-sid';
const MAX_DISPLAY_NAME_LENGTH = 100;
const PROXY_KEEPALIVE_INTERVAL_MS = 25_000;

// ---------------------------------------------------------------------------
// In-memory auth state. Both maps are intentionally in-memory; the policy is
// "post-restart everyone re-authenticates via URL" — there is no crash
// recovery for these and that is fine for a local-only review server.
// ---------------------------------------------------------------------------
const nonces = new Map();
const sessions = new Map();

// Multi-use invites (long-lived mode only). The invite is the
// exchange credential: GET /api/exchange?invite=<id> returns a form,
// POST /api/identify { name, invite } re-validates it and mints a cookie.
// Invites are NOT burned on POST (multi-use). They live in-process and
// are wiped on server restart, like nonces and sessions.
const invites = new Map();

/**
 * Mint a single-use exchange nonce. Caller stores the returned id in a
 * share URL as `?nonce=<id>`.
 */
function mintNonce(record) {
  const id = crypto.randomBytes(24).toString('base64url');
  nonces.set(id, { ...record, createdAt: Date.now() });
  return id;
}

/**
 * Look up a nonce WITHOUT mutating the map. Used by 401 probes so we don't
 * burn a nonce just because a request had the wrong bearer.
 */
function peekNonce(id) {
  const r = nonces.get(id);
  if (!r) return null;
  if (Date.now() - r.createdAt > NONCE_TTL_MS) {
    nonces.delete(id);
    return null;
  }
  return r;
}

/**
 * Atomic exchange: capture the record and delete the nonce from the map
 * inside the same tick. No awaits between lookup and delete. Returns
 * `null` if the nonce is absent/expired (and does NOT mutate the map in
 * that case), or the record on success.
 */
function consumeNonce(id) {
  const r = nonces.get(id);
  if (!r) return null;
  if (Date.now() - r.createdAt > NONCE_TTL_MS) {
    nonces.delete(id);
    return null;
  }
  // CRITICAL SECTION: capture + delete. No awaits here.
  const record = r;
  nonces.delete(id);
  return record;
}
/**
 * Mint a multi-use invite token. Caller stores the returned id in a
 * share URL as `?invite=<id>`. Unlike a nonce, an invite is NOT burned
 * on first use; multiple reviewers can independently exchange the same
 * invite and each get a distinct cookie session.
 */
function mintInvite(record) {
  const id = crypto.randomBytes(24).toString('base64url');
  invites.set(id, { ...record, createdAt: Date.now() });
  return id;
}

/**
 * Read-only invite lookup. Returns the record or null. Does NOT mutate
 * the map (invites are multi-use; the same id may be presented by many
 * distinct reviewers).
 */
function validateInvite(id) {
  if (typeof id !== 'string' || !id) return null;
  return invites.get(id) || null;
}

/**
 * Mint a cookie session bound to a session envelope path. Returns the
 * opaque session id; the caller sets the cookie via `buildSessionCookie`.
 *
 * `displayName` is optional; when set, the SSE handler uses it to
 * populate the presence viewers list (long-lived mode only).
 */
function mintSession({ sessionPath, permissions, expiresAt, displayName }) {
  const sid = crypto.randomBytes(32).toString('base64url');
  const csrfKey = crypto.randomBytes(16).toString('base64url');
  sessions.set(sid, {
    sessionPath,
    permissions: permissions || 'reviewer',
    csrfKey,
    expiresAt: expiresAt || Date.now() + NONCE_TTL_MS,
    displayName:
      typeof displayName === 'string' && displayName
        ? displayName.slice(0, MAX_DISPLAY_NAME_LENGTH)
        : null,
  });
  return sid;
}

/**
 * Validate a cookie session id AND ensure it was minted for this exact
 * `expectedSessionPath`. Returns the record on success, null on
 * missing/expired/bound-to-another-session. Expired records are deleted
 */
function validateSession(sid, expectedSessionPath) {
  if (!sid) return null;
  const r = sessions.get(sid);
  if (!r) return null;
  if (Date.now() > r.expiresAt) {
    sessions.delete(sid);
    return null;
  }
  // Bind the cookie to the session it was minted for. Without this, a SID
  // minted on one server instance would authorize against any other
  // instance in the same process (rare, but a real defensive gap).
  if (expectedSessionPath && r.sessionPath !== expectedSessionPath) {
    return null;
  }
  return r;
}

/**
 * Parse a Cookie header into a `{ name: value }` map. URL-decodes values.
 * Tolerant of malformed pairs (skips them).
 */
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    if (!name) continue;
    const raw = pair.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch (_) {
      out[name] = raw;
    }
  }
  return out;
}

/**
 * Build a `Set-Cookie` value for a session id. Cookie attributes:
 * `HttpOnly; Secure; SameSite=Strict; Path=/` (no `Domain=`); `Max-Age`
 * is matched to the session's `expiresAt`.
 */
function buildSessionCookie(sid, record) {
  const maxAge = Math.max(1, Math.floor((record.expiresAt - Date.now()) / 1000));
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sid)}`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${maxAge}`,
  ].join('; ');
}

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
 * Extract a credential from the request. Order of preference:
 *   1. `review-sid` cookie (durable per-device, validated against `sessions`).
 *   2. `Authorization: Bearer <token>` header.
 *   3. `?token=<token>` query parameter (used by SSE clients that cannot
 *      easily set headers on `EventSource`).
 * @param {http.IncomingMessage} req
 * @param {URL} url
 * @returns {{ kind: 'cookie'|'bearer'|'query', value: string }|null}
 */
function tokenFromRequest(req, url) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[SESSION_COOKIE_NAME]) {
    return { kind: 'cookie', value: cookies[SESSION_COOKIE_NAME] };
  }
  const auth = req.headers['authorization'];
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(\S+)$/.exec(auth);
    if (m) return { kind: 'bearer', value: m[1] };
  }
  const q = url.searchParams.get('token');
  if (q) return { kind: 'query', value: q };
  return null;
}

/**
 * Apply `Referrer-Policy: no-referrer` to every response. Returns the
 * header object so callers can extend it (e.g. add `content-type`).
 */
function securityHeaders(extra) {
  return Object.assign(
    { 'referrer-policy': 'no-referrer' },
    extra || {},
  );
}

/**
 * Write a JSON response. Sets `Content-Type: application/json`,
 * `Referrer-Policy: no-referrer`, and a `Cache-Control: no-store` header
 * so clients always revalidate against the server.
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function writeJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, securityHeaders({
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  }));
  res.end(data);
}

/**
 * Write a 302 redirect. Sets `Referrer-Policy: no-referrer` and an empty
 * body. Caller is responsible for any `Set-Cookie` header.
 */
function writeRedirect(res, location, setCookie) {
  const headers = {
    location,
    'content-length': 0,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  };
  if (setCookie) headers['set-cookie'] = setCookie;
  res.writeHead(302, headers);
  res.end();
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
 *   (`<origin>/api/exchange?nonce=<id>`) in the user's default browser
 *   after binding. The opener is invoked fire-and-forget; the returned
 *   `openResult` Promise resolves with `{ opened, reason?, command? }` so
 *   the caller can decide whether to log a fallback. NEVER log the share
 *   URL — the bearer is never present but a single-use nonce is.
 * @property {object} [openerOpts] - forwarded to `openUrl`; allows tests
 *   to inject a `platform` and a stub `spawn`.
 * @property {string} [tunnelUrl] - if set, this is used as the public
 *   share URL origin (e.g. `https://xyz.trycloudflare.com`) instead of
 *   the local bind URL. The nonce-bearing share URL is rewritten so the
 *   reviewer lands on the tunnel, not the local server.
 */

/**
 * Start the refinement-review server.
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
  /**
   * Presence map (long-lived mode only). `sid` is the cookie session id
   * from the request's `review-sid` cookie; a single sid may own several
   * concurrent EventSource connections (multi-tab reviewers). The
   * refcount keeps the row visible to other viewers until the LAST
   * connection closes.
   */
  const viewers = new Map();

  /**
   * TTL timer (long-lived mode only). When `opts.ttlMs` is set, the
   * server self-stops after that duration. `unref()` so the timer
   * alone never keeps the loop alive.
   */
  let ttlTimer = null;

  /**
   * Serialise the viewers list for SSE broadcast. Returns an array of
   * `{ name, connectedAt }` derived from the in-memory map. The sid
   * (cookie session id) is never broadcast — it is the bearer credential
   * and must not leak to other clients.
   */
  function viewersPayload() {
    const list = [];
    for (const v of viewers.values()) {
      list.push({ name: v.name, connectedAt: v.connectedAt });
    }
    return list;
  }


  /**
   * Broadcast the current viewers list to every SSE subscriber. Same
   * per-subscriber error handling as `broadcast`.
   */
  function broadcastViewers() {
    const payload = `event: viewers\ndata: ${JSON.stringify(viewersPayload())}\n\n`;
    for (const res of subscribers) {
      try {
        res.write(payload);
      } catch (e) {
        logError(`sse write failed: ${e.message}`);
      }
    }
  }

  /**
   * Record a new SSE connection for a viewer. Returns `true` if this
   * transition added a NEW viewer (caller should broadcast), `false`
   * if the sid was already present (caller should NOT broadcast — the
   * visible set did not change).
   */
  function addViewer(sid, displayName) {
    const existing = viewers.get(sid);
    if (existing) {
      existing.count += 1;
      return false;
    }
    viewers.set(sid, {
      name: displayName || 'anonymous',
      connectedAt: Date.now(),
      count: 1,
    });
    return true;
  }

  /**
   * Remove an SSE connection for a viewer. Returns `true` if this
   * transition removed the viewer from the map (caller should broadcast),
   * `false` if there are still other connections owned by the same sid.
   */
  function removeViewer(sid) {
    const existing = viewers.get(sid);
    if (!existing) return false;
    existing.count -= 1;
    if (existing.count > 0) return false;
    viewers.delete(sid);
    return true;
  }

  /**
   * Start the TTL timer. After `ttlMs` the server calls `stop()` which
   * closes the listener and any active SSE connections. Idempotent — a
   * second call replaces the prior timer.
   */
  function startTtl(ttlMs) {
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) return;
    clearTimeout(ttlTimer);
    ttlTimer = setTimeout(() => {
      log(`refinement-review TTL (${ttlMs}ms) reached; stopping`);
      stop().catch((e) => logError(`stop after TTL failed: ${e.message}`));
    }, ttlMs);
    if (typeof ttlTimer.unref === 'function') ttlTimer.unref();
  }

  /**
   * Cancel the TTL timer. Called by `stop()` so a TTL expiry never
   * re-fires after the server has already been torn down.
   */
  function clearTtl() {
    if (ttlTimer) {
      clearTimeout(ttlTimer);
      ttlTimer = null;
    }
  }
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

    // -------------------------------------------------------------------
    // /api/exchange: cookie session id from a single-use nonce.
    // This route does NOT require a credential — the nonce IS the credential.
    // It is intentionally placed before the static-UI branch AND the bearer
    // gate, so that a reviewer following a share URL can land here even if
    // they don't yet have a cookie or bearer.
    // -------------------------------------------------------------------
    if (method === 'GET' && url.pathname === '/api/exchange') {
      const nonceId = url.searchParams.get('nonce');
      if (!nonceId) {
        writeJson(res, 400, { error: 'nonce required' });
        return;
      }
      // Probe-only peek: probes (Authorization bearer check) MUST NOT mutate
      // the nonce map. But this route is the legitimate exchange endpoint, so
      // we burn the nonce. If the probe was wrong, the next legitimate
      // request gets a 401 (no nonce), which is the correct behavior.
      const record = consumeNonce(nonceId);
      if (!record) {
        writeJson(res, 401, { error: 'invalid or expired nonce' });
        return;
      }
      const sid = mintSession({
        sessionPath: record.sessionPath,
        permissions: record.permissions,
        expiresAt: record.sessionExpiresAt || Date.now() + NONCE_TTL_MS,
      });
      const sessionRec = sessions.get(sid);
      const cookie = buildSessionCookie(sid, sessionRec);
      // Redirect back to the SPA root with the nonce stripped from the URL.
      writeRedirect(res, '/', cookie);
      return;
    }

    // Static UI: anything not under /api is served from uiDir.
    const isApi = url.pathname.startsWith('/api/');
    if (!isApi) {
      if (!uiDir) {
        res.writeHead(404, securityHeaders({ 'content-type': 'text/plain; charset=utf-8' }));
        res.end('not found');
        return;
      }
      // Resolve a safe file path; reject anything that escapes uiDir.
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/') rel = '/index.html';
      const filePath = path.join(uiDir, rel);
      if (!filePath.startsWith(uiDir + path.sep) && filePath !== uiDir) {
        res.writeHead(403, securityHeaders({ 'content-type': 'text/plain; charset=utf-8' }));
        res.end('forbidden');
        return;
      }
      fs.stat(filePath, (err, st) => {
        if (err || !st.isFile()) {
          res.writeHead(404, securityHeaders({ 'content-type': 'text/plain; charset=utf-8' }));
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
        res.writeHead(200, securityHeaders({
          'content-type': ct,
          'content-length': st.size,
          'cache-control': 'no-store',
        }));
        fs.createReadStream(filePath).pipe(res);
      });
      return;
    }

    // All other API routes require a credential. Cookie is preferred
    // (durable per-device), then bearer, then query (SSE only).
    const cred = tokenFromRequest(req, url);
    if (!cred) {
      writeJson(res, 401, { error: 'unauthorized' });
      return;
    }
    if (cred.kind === 'cookie') {
      const rec = validateSession(cred.value, opts.sessionPath);
      if (!rec) {
        writeJson(res, 401, { error: 'invalid session' });
        return;
      }
    } else if (cred.value !== opts.token) {
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
      res.writeHead(200, securityHeaders({
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      }));
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
        res.writeHead(304, securityHeaders());
        res.end();
        return;
      }
      res.writeHead(200, securityHeaders({
        'content-type': 'text/markdown; charset=utf-8',
        'content-length': content.length,
        etag,
        'cache-control': 'no-store',
      }));
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
          if (body.selectedOptionId !== undefined && body.selectedOptionId !== null) {
            if (typeof body.selectedOptionId !== 'string' || !body.selectedOptionId)
              throw Object.assign(new Error('selectedOptionId must be non-empty string or null'), { status: 400 });
            if (!Array.isArray(q.options) || !q.options.some((o) => o.id === body.selectedOptionId))
              throw Object.assign(new Error(`selectedOptionId '${body.selectedOptionId}' does not match any option.id`), { status: 400 });
          }
          q.status = body.status;
          q.answer = body.answer ?? q.answer;
          q.selectedOptionId = body.selectedOptionId === undefined ? q.selectedOptionId : body.selectedOptionId;
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
            options: q.options,
            recommendedOptionId: q.recommendedOptionId,
            selectedOptionId: q.selectedOptionId,
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

  // Local URL (used for the listen path).
  const localUrl = `http://${addr.address}:${addr.port}`;

  // Public origin (used for the share URL). If a tunnel is in play, the
  // bootstrap passes `opts.tunnelUrl` and we use that; otherwise we use
  // the local URL.
  const publicOrigin = opts.tunnelUrl
    ? String(opts.tunnelUrl).replace(/\/+$/, '')
    : localUrl;

  // Mint a single-use nonce for the share URL. This is what the opener
  // (and the bootstrap's manual fallback print) sees — a real URL that
  // lands on /api/exchange and exchanges the nonce for a cookie session.
  const shareNonce = mintNonce({
    sessionPath: opts.sessionPath,
    permissions: 'reviewer',
    sessionExpiresAt: Date.now() + NONCE_TTL_MS,
  });
  const reviewUrl = `${publicOrigin}/api/exchange?nonce=${shareNonce}`;

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

  // Mutable result object. The bootstrap can call `setTunnelUrl(...)` once
  // cloudflared publishes the public origin; the share-nonce is re-minted
  // against the new origin and the opener (if requested at startup) is
  // re-fired with the corrected URL.
  const result = {
    url: localUrl,
    publicUrl: publicOrigin,
    host: addr.address,
    port: addr.port,
    address: addr,
    stop,
    completed,
    reviewUrl,
    shareNonce,
    openResult,
  };

  /**
   * Update the public origin once a tunnel URL is known, mint a fresh
   * share-nonce against it, and rewrite the reviewUrl. If the server was
   * started with `open: true`, the opener is re-fired with the new URL
   * (the previous openResult is left as-is for caller introspection).
   *
   * Calling with the same URL is a no-op. Calling more than once
   * produces a fresh nonce each time; the caller is responsible for
   * not burning old nonces.
   *
   * @param {string} tunnelUrl
   * @returns {{ reviewUrl: string, shareNonce: string, publicUrl: string }}
   */
  function setTunnelUrl(tunnelUrl) {
    if (!tunnelUrl || typeof tunnelUrl !== 'string') {
      throw new TypeError('setTunnelUrl: tunnelUrl must be a non-empty string');
    }
    const newOrigin = String(tunnelUrl).replace(/\/+$/, '');
    const newNonce = mintNonce({
      sessionPath: opts.sessionPath,
      permissions: 'reviewer',
      sessionExpiresAt: Date.now() + NONCE_TTL_MS,
    });
    const newReviewUrl = `${newOrigin}/api/exchange?nonce=${newNonce}`;
    result.publicUrl = newOrigin;
    result.shareNonce = newNonce;
    result.reviewUrl = newReviewUrl;
    if (opts.open === true) {
      const openerOpts = opts.openerOpts || {};
      result.openResult = openUrl(newReviewUrl, openerOpts).catch((e) => ({
        opened: false,
        reason: 'exception',
        error: e && e.message,
      }));
    }
    return {
      reviewUrl: result.reviewUrl,
      shareNonce: result.shareNonce,
      publicUrl: result.publicUrl,
    };
  }

  result.setTunnelUrl = setTunnelUrl;

  /**
   * Mint an additional share URL bound to the current publicUrl. Each call
   * produces a fresh, independent nonce; the original `result.shareNonce` /
   * `result.reviewUrl` are not modified. Use this to fan out multiple
   * reviewer links from a single session (e.g. operator wants N invitees).
   *
   * Unlike `setTunnelUrl`, this does not mutate `publicUrl` and does not
   * re-fire the opener. The returned `shareNonce` is bound to the same
   * `opts.sessionPath` and shares the same 10-minute TTL (`NONCE_TTL_MS`)
   * as the original share URL.
   *
   * @returns {{ reviewUrl: string, shareNonce: string, publicUrl: string }}
   */
  function createShareUrl() {
    const nonce = mintNonce({
      sessionPath: opts.sessionPath,
      permissions: 'reviewer',
      sessionExpiresAt: Date.now() + NONCE_TTL_MS,
    });
    return {
      reviewUrl: `${result.publicUrl}/api/exchange?nonce=${nonce}`,
      shareNonce: nonce,
      publicUrl: result.publicUrl,
    };
  }

  result.createShareUrl = createShareUrl;
  return result;
}


module.exports = {
  startServer,
  DEFAULT_HOST,
  DEFAULT_PORT,
  SESSION_COOKIE_NAME,
  NONCE_TTL_MS,
  // exposed for tests and bootstrap integration
  _internal: {
    tokenFromRequest,
    readBody,
    writeJson,
    writeRedirect,
    parseCookies,
    buildSessionCookie,
    peekNonce,
    consumeNonce,
    mintNonce,
    mintSession,
    validateSession,
    securityHeaders,
  },
};
