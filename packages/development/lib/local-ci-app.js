'use strict';

/**
 * Local CI GitHub App client (TRD-004): signs an App JWT (RS256, Node crypto
 * only), exchanges it for an installation token and posts a commit status on
 * the exact head SHA. FAIL CLOSED: no credential => no request; any failure
 * => published:false with redacted text. Secrets (PEM keys, JWTs, GitHub
 * tokens) NEVER appear in anything returned or thrown.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const API = 'https://api.github.com';
const STATES = ['error', 'failure', 'pending', 'success'];
const MAX_DESCRIPTION = 100;
const TIMEOUT_MS = 15000;
const KEY_FILE = '.ensemble/local-ci-app.pem';
const CANNOT_ATTEST = 'cannot attest';

const PEM_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const PATTERNS = [
  PEM_RE,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /\bgh[sop]_[A-Za-z0-9]{10,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{10,}/g,
];
const SENSITIVE_KEY = /token|secret|password|private[-_]?key|authorization|credential/i;

function redactString(s) {
  return PATTERNS.reduce((acc, p) => acc.replace(p, '[REDACTED]'), s);
}

/** Deep-redacts keys, JWTs and GitHub tokens from strings, arrays and objects. */
function redact(value) {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value instanceof Error) return redactString(String(value.message));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = typeof v === 'string' && SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v);
    }
    return out;
  }
  return value;
}

function refuse(reason, extra) {
  return redact({ published: false, reason, ...(extra || {}) });
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

/** RS256 App JWT. Errors never contain the key. */
function signAppJwt({ appId, privateKey, now } = {}) {
  const id = typeof appId === 'string' && /^\d+$/.test(appId) ? Number(appId) : appId;
  if (!Number.isInteger(id) || id <= 0) throw new Error('appId must be a positive integer');
  if (typeof privateKey !== 'string' || privateKey.trim() === '') {
    throw new Error('privateKey must be a non-empty PEM string');
  }
  const nowSec = Math.floor((now === undefined ? Date.now() : now) / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 9 * 60, iss: id }));
  const data = `${header}.${payload}`;
  let sig;
  try {
    sig = crypto.sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url');
  } catch (_e) {
    throw new Error('privateKey could not be used to sign (not a valid RSA private key)');
  }
  return `${data}.${sig}`;
}

class ApiError extends Error {}

function describeStatus(status, what) {
  if (status === 401) {
    return `authentication failed: GitHub rejected the App credential (revoked, expired or invalid key) during ${what}`;
  }
  if (status === 404) return `not found during ${what}: the App may not be installed on this repository`;
  if (status === 403) return `forbidden during ${what}: the App lacks the required permission`;
  if (status === 422) return `validation failed during ${what}`;
  return `unexpected HTTP ${status} during ${what}`;
}

async function call(fetchFn, method, url, bearer, body, what) {
  let res;
  try {
    res = await fetchFn(url, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new ApiError(`network failure or timeout during ${what}: ${redactString(String((e && e.message) || e))}`);
  }
  if (!res || typeof res.status !== 'number') throw new ApiError(`malformed response during ${what}`);
  if (res.status < 200 || res.status > 299) {
    const err = new ApiError(describeStatus(res.status, what));
    err.status = res.status;
    throw err;
  }
  try {
    return await res.json();
  } catch (_e) {
    throw new ApiError(`malformed JSON response during ${what}`);
  }
}

/** Post a commit status as the App on the exact head SHA. */
async function postStatus(input) {
  const { repo, sha, state, context, description, credential, now } = input || {};
  const fetchFn = (input && input.fetch) || globalThis.fetch;
  if (
    !credential ||
    typeof credential.privateKey !== 'string' ||
    credential.privateKey.trim() === '' ||
    !credential.appId
  ) {
    return refuse(CANNOT_ATTEST);
  }
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return refuse('repo must be owner/name');
  if (typeof sha !== 'string' || !/^[0-9a-fA-F]{7,64}$/.test(sha)) return refuse('sha must be a hex commit sha');
  if (!STATES.includes(state)) return refuse(`state must be one of ${STATES.join(', ')}`);
  if (typeof context !== 'string' || context.trim() === '') return refuse('context must be a non-empty string');
  if (typeof description !== 'string' || description.length > MAX_DESCRIPTION) {
    return refuse(`description must be a string of at most ${MAX_DESCRIPTION} characters`);
  }
  if (typeof fetchFn !== 'function') return refuse('no fetch implementation available');

  try {
    const jwt = signAppJwt({ appId: credential.appId, privateKey: credential.privateKey, now });
    const inst = await call(fetchFn, 'GET', `${API}/repos/${repo}/installation`, jwt, null, 'installation lookup');
    if (!inst || !Number.isInteger(inst.id)) throw new ApiError('installation lookup returned no installation id');
    const tok = await call(
      fetchFn,
      'POST',
      `${API}/app/installations/${inst.id}/access_tokens`,
      jwt,
      null,
      'installation token exchange'
    );
    if (!tok || typeof tok.token !== 'string') throw new ApiError('token exchange returned no token');
    const status = await call(
      fetchFn,
      'POST',
      `${API}/repos/${repo}/statuses/${sha}`,
      tok.token,
      { state, context, description },
      'status post'
    );
    return redact({ published: true, repo, sha, state, context, id: status && status.id });
  } catch (e) {
    return refuse(String((e && e.message) || e), e && e.status ? { status: e.status } : {});
  }
}

function defaultGit(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '' };
}

/**
 * Resolve the credential from env (LOCAL_CI_APP_ID + LOCAL_CI_APP_PRIVATE_KEY)
 * or .ensemble/local-ci-app.pem. The file is read only after git confirms it
 * is ignored and not tracked. Returns { credential } or { credential:null, reason }.
 */
function loadCredential({ env = process.env, cwd = process.cwd(), git = defaultGit, readFile = fs.readFileSync } = {}) {
  const appId = env.LOCAL_CI_APP_ID;
  if (!appId) return { credential: null, reason: CANNOT_ATTEST };
  const envKey = env.LOCAL_CI_APP_PRIVATE_KEY;
  if (typeof envKey === 'string' && envKey.trim() !== '') {
    return { credential: { appId, privateKey: envKey.replace(/\\n/g, '\n') }, source: 'env' };
  }
  const file = KEY_FILE;
  const tracked = git(['ls-files', '--', file], cwd);
  if (tracked.status !== 0) return { credential: null, reason: `refusing ${file}: git ls-files failed` };
  if (tracked.stdout.trim() !== '') {
    return { credential: null, reason: `refusing credential file ${file}: it is tracked by git` };
  }
  const ignored = git(['check-ignore', '-q', '--', file], cwd);
  if (ignored.status !== 0) {
    return { credential: null, reason: `refusing credential file ${file}: it is not ignored by git` };
  }
  const full = path.join(cwd, file);
  let pem;
  try {
    pem = readFile(full, 'utf8');
  } catch (_e) {
    return { credential: null, reason: CANNOT_ATTEST };
  }
  if (typeof pem !== 'string' || pem.trim() === '') return { credential: null, reason: CANNOT_ATTEST };
  return { credential: { appId, privateKey: pem }, source: 'file' };
}

module.exports = { signAppJwt, postStatus, loadCredential, redact, KEY_FILE, STATES, MAX_DESCRIPTION };
