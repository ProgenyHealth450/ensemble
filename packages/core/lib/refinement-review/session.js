/**
 * Refinement-review session model.
 *
 * One shared, versioned contract used by every refinement command that
 * opts into the browser-review phase. Persists to JSON via atomic rename;
 * every mutation is guarded by a `revision` integer (optimistic concurrency)
 * and a `sha256` over the source markdown bytes (document integrity).
 *
 * @module @sunstone-partners/ensemble-core/refinement-review/session
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;

/**
 * Generate a 128-bit hex id. Used for sessionId, questionId, and commentId.
 * @returns {string}
 */
function newId() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Generate a 256-bit bearer token. NOT persisted with the session.
 * @returns {string}
 */
function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Compute sha256 hex digest of a string or buffer.
 * @param {string|Buffer} input
 * @returns {string}
 */
function sha256Hex(input) {
  const h = crypto.createHash('sha256');
  h.update(input);
  return h.digest('hex');
}

/**
 * Extract ordered section headings from markdown.
 * Captures ATX headings (`#`..`######`) preceded by start-of-line.
 * @param {string} content
 * @returns {string[]} e.g. ["# Title", "## Overview", "### Acceptance Criteria"]
 */
function extractSectionHeadings(content) {
  if (typeof content !== 'string') return [];
  const out = [];
  const lines = content.split(/\r\n|\r|\n/);
  for (const line of lines) {
    const m = /^(#{1,6})\s+([^#].*?)\s*#*\s*$/.exec(line);
    if (m) out.push(`${m[1]} ${m[2]}`);
  }
  return out;
}

/**
 * Validate an anchor object. Returns null on success or a string reason.
 * @param {unknown} anchor
 * @param {number} totalLines
 * @returns {string|null}
 */
function validateAnchor(anchor, totalLines) {
  if (anchor === null || anchor === undefined) return null;
  if (typeof anchor !== 'object') return 'anchor must be object or null';
  const { section, lineStart, lineEnd, selectedText } = anchor;
  if (section !== null && typeof section !== 'string')
    return 'anchor.section must be string or null';
  if (!Number.isInteger(lineStart) || lineStart < 1 || lineStart > totalLines)
    return `anchor.lineStart out of bounds (1..${totalLines})`;
  if (!Number.isInteger(lineEnd) || lineEnd < lineStart || lineEnd > totalLines)
    return `anchor.lineEnd out of bounds (lineStart..${totalLines})`;
  if (selectedText !== null && typeof selectedText !== 'string')
    return 'anchor.selectedText must be string or null';
  return null;
}

/**
 * Shape-validate a session envelope. Throws on the first violation.
 * @param {unknown} session
 */
function validateSession(session) {
  if (!session || typeof session !== 'object')
    throw new Error('session must be an object');
  if (session.schemaVersion !== SCHEMA_VERSION)
    throw new Error(`schemaVersion must be ${SCHEMA_VERSION}`);
  if (typeof session.sessionId !== 'string' || !session.sessionId)
    throw new Error('sessionId is required');
  if (typeof session.revision !== 'number' || session.revision < 1)
    throw new Error('revision must be a positive integer');
  if (typeof session.createdAt !== 'string')
    throw new Error('createdAt must be an ISO timestamp');
  if (typeof session.updatedAt !== 'string')
    throw new Error('updatedAt must be an ISO timestamp');

  const doc = session.document;
  if (!doc || typeof doc !== 'object') throw new Error('document is required');
  if (doc.kind !== 'prd' && doc.kind !== 'trd')
    throw new Error('document.kind must be "prd" or "trd"');
  for (const k of ['sourcePath', 'contentPath', 'sha256']) {
    if (typeof doc[k] !== 'string' || !doc[k])
      throw new Error(`document.${k} is required`);
  }
  if (!Array.isArray(doc.sectionHeadings))
    throw new Error('document.sectionHeadings must be an array of strings');
  for (const h of doc.sectionHeadings) {
    if (typeof h !== 'string')
      throw new Error('document.sectionHeadings entries must be strings');
  }

  if (!Array.isArray(session.questions) || session.questions.length === 0)
    throw new Error('questions must be a non-empty array');
  const seenQ = new Set();
  for (const q of session.questions) {
    if (!q || typeof q !== 'object') throw new Error('question must be object');
    if (typeof q.id !== 'string' || !q.id)
      throw new Error('question.id is required');
    if (seenQ.has(q.id)) throw new Error(`duplicate question id: ${q.id}`);
    seenQ.add(q.id);
    if (typeof q.prompt !== 'string' || !q.prompt)
      throw new Error('question.prompt is required');
    if (q.context !== null && typeof q.context !== 'string')
      throw new Error('question.context must be string or null');
    if (!['open', 'answered', 'skipped'].includes(q.status))
      throw new Error(`question.status invalid: ${q.status}`);
    if (q.answer !== null && typeof q.answer !== 'string')
      throw new Error('question.answer must be string or null');
    if (q.author !== null && typeof q.author !== 'string')
      throw new Error('question.author must be string or null');
    if (q.updatedAt !== null && typeof q.updatedAt !== 'string')
      throw new Error('question.updatedAt must be ISO string or null');
  }

  if (!Array.isArray(session.comments))
    throw new Error('comments must be an array');
  const seenC = new Set();
  for (const c of session.comments) {
    if (!c || typeof c !== 'object') throw new Error('comment must be object');
    if (typeof c.id !== 'string' || !c.id)
      throw new Error('comment.id is required');
    if (seenC.has(c.id)) throw new Error(`duplicate comment id: ${c.id}`);
    seenC.add(c.id);
    if (typeof c.body !== 'string') throw new Error('comment.body is required');
    if (typeof c.author !== 'string') throw new Error('comment.author is required');
    if (typeof c.createdAt !== 'string')
      throw new Error('comment.createdAt is required');
    if (c.resolvedAt !== null && typeof c.resolvedAt !== 'string')
      throw new Error('comment.resolvedAt must be ISO string or null');
    if (c.anchor !== null && typeof c.anchor !== 'object')
      throw new Error('comment.anchor must be object or null');
    if (c.anchor) {
      const err = validateAnchor(c.anchor, Number.MAX_SAFE_INTEGER);
      if (err) throw new Error(`comment.anchor invalid: ${err}`);
    }
  }

  if (session.completedAt !== undefined &&
      session.completedAt !== null &&
      typeof session.completedAt !== 'string')
    throw new Error('completedAt must be ISO string or null');
  if (session.completedBy !== undefined &&
      session.completedBy !== null &&
      typeof session.completedBy !== 'string')
    throw new Error('completedBy must be string or null');
}

/**
 * Atomic JSON write: write to temp file in same directory, fsync, rename.
 * @param {string} filePath
 * @param {unknown} value
 */
function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  const data = JSON.stringify(value, null, 2);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

/**
 * Read JSON, throwing a descriptive error on parse failure.
 * @param {string} filePath
 * @returns {unknown}
 */
function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

/**
 * Load and validate a session from disk.
 * @param {string} sessionPath
 * @returns {object}
 */
function loadSession(sessionPath) {
  const session = readJson(sessionPath);
  validateSession(session);
  return session;
}

/**
 * Create a new session. Reads the source markdown to compute sha256 and
 * section headings. Persists the session and returns `{ session, token }`.
 *
 * @param {object} args
 * @param {string} args.sessionPath - where the session JSON is persisted
 * @param {"prd"|"trd"} args.kind
 * @param {string} args.sourcePath - source markdown path (absolute)
 * @param {Array<{id?: string, prompt: string, context?: string|null}>} args.questions
 * @returns {{session: object, token: string}}
 */
function createSession({ sessionPath, kind, sourcePath, questions }) {
  if (!['prd', 'trd'].includes(kind))
    throw new Error(`kind must be "prd" or "trd" (got ${kind})`);
  if (typeof sourcePath !== 'string' || !sourcePath)
    throw new Error('sourcePath is required');
  if (!Array.isArray(questions) || questions.length === 0)
    throw new Error('questions must be a non-empty array');

  const abs = path.resolve(sourcePath);
  const content = fs.readFileSync(abs);
  const sha = sha256Hex(content);
  const headings = extractSectionHeadings(content.toString('utf8'));

  const now = new Date().toISOString();
  const session = {
    schemaVersion: SCHEMA_VERSION,
    sessionId: newId(),
    document: {
      kind,
      sourcePath: abs,
      contentPath: abs,
      sha256: sha,
      sectionHeadings: headings,
    },
    questions: questions.map((q) => ({
      id: q.id || newId(),
      prompt: q.prompt,
      context: q.context || null,
      status: 'open',
      answer: null,
      author: null,
      updatedAt: null,
    })),
    comments: [],
    revision: 1,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    completedBy: null,
  };

  validateSession(session);
  writeJsonAtomic(sessionPath, session);

  return { session, token: newToken() };
}

/**
 * Mutate a session through a function, persisting with optimistic concurrency.
 * Re-validates the document sha256 against the on-disk source on every write.
 *
 * The mutator receives the current session and may mutate it in place to
 * describe the data change. `revision` is auto-incremented by exactly 1 after
 * the mutator returns; the mutator MUST NOT touch `revision` itself. Every
 * accepted persisted mutation advances optimistic concurrency by one.
 *
 * @param {object} args
 * @param {string} args.sessionPath
 * @param {number} args.expectedRevision - caller's last-known revision
 * @param {(s: object) => void} args.mutate
 * @param {string} [args.now] - override timestamp (for testing)
 * @returns {object} the persisted session
 * @throws on revision mismatch, document hash drift, completion freeze, validation.
 */
function mutateSession({ sessionPath, expectedRevision, mutate, now }) {
  const session = loadSession(sessionPath);

  if (session.completedAt)
    throw Object.assign(new Error('session is completed'), {
      code: 'SESSION_COMPLETED',
      status: 410,
    });
  if (typeof expectedRevision !== 'number' || session.revision !== expectedRevision)
    throw Object.assign(
      new Error(
        `revision conflict (expected ${expectedRevision}, current ${session.revision})`,
      ),
      { code: 'REVISION_CONFLICT', status: 409, currentRevision: session.revision },
    );

  // Re-verify document integrity. The source is read-only for the command's
  // lifetime; if it changes, every anchored comment becomes suspect.
  const onDisk = fs.readFileSync(session.document.sourcePath);
  const onDiskSha = sha256Hex(onDisk);
  if (onDiskSha !== session.document.sha256)
    throw Object.assign(new Error('document sha256 changed on disk'), {
      code: 'DOCUMENT_CHANGED',
      status: 409,
      sessionRevision: session.revision,
    });

  const preRevision = session.revision;
  mutate(session);

  if (session.revision !== preRevision)
    throw Object.assign(
      new Error('mutator must not change revision; mutateSession owns the +1 bump'),
      { code: 'REVISION_TAMPERED', status: 400 },
    );

  session.revision = preRevision + 1;
  session.updatedAt = now || new Date().toISOString();

  validateSession(session);
  writeJsonAtomic(sessionPath, session);
  return session;
}

module.exports = {
  SCHEMA_VERSION,
  newId,
  newToken,
  sha256Hex,
  extractSectionHeadings,
  validateAnchor,
  validateSession,
  writeJsonAtomic,
  readJson,
  loadSession,
  createSession,
  mutateSession,
};
