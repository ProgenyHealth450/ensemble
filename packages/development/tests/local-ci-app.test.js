'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { signAppJwt, postStatus, loadCredential, redact } = require('../lib/local-ci-app');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const SHA = 'a'.repeat(40);
const NOW = 1_700_000_000_000;
const INSTALL_TOKEN = 'ghs_' + 'A1b2C3d4E5f6G7h8I9j0K1l2';
const REPO_ROOT = path.resolve(__dirname, '../../..');

function decode(seg) {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
}

function fakeFetch(overrides = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const key = `${init.method} ${url.replace('https://api.github.com', '')}`;
    for (const [pat, res] of Object.entries(overrides)) {
      if (key.includes(pat)) return typeof res === 'function' ? res(init) : res;
    }
    if (key.endsWith('/installation')) return { status: 200, json: async () => ({ id: 77 }) };
    if (key.includes('/access_tokens')) {
      return { status: 201, json: async () => ({ token: INSTALL_TOKEN, expires_at: 'x' }) };
    }
    if (key.includes('/statuses/')) return { status: 201, json: async () => ({ id: 5 }) };
    return { status: 500, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}

const cred = { appId: '12345', privateKey };
const base = { repo: 'o/r', sha: SHA, state: 'success', context: 'ci-local', description: 'ci-local abc | set:def | log:123', credential: cred, now: NOW };

describe('signAppJwt', () => {
  test('RS256 JWT verifies with the public key and carries iss/iat/exp', () => {
    const jwt = signAppJwt({ appId: 12345, privateKey, now: NOW });
    const [h, p, s] = jwt.split('.');
    expect(decode(h)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = decode(p);
    expect(claims.iss).toBe(12345);
    expect(claims.iat).toBe(NOW / 1000 - 60);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(claims.exp).toBeGreaterThan(NOW / 1000);
    expect(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'))).toBe(true);
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
    expect(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), other, Buffer.from(s, 'base64url'))).toBe(false);
  });

  test.each([[undefined], [''], [42]])('rejects bad key %p without leaking it', (k) => {
    expect(() => signAppJwt({ appId: 1, privateKey: k })).toThrow(/privateKey/);
  });
  test.each([[0], [-1], [undefined], ['x']])('rejects bad app id %p', (id) => {
    expect(() => signAppJwt({ appId: id, privateKey })).toThrow(/appId/);
  });
  test('invalid PEM error does not contain the key material', () => {
    const bad = '-----BEGIN PRIVATE KEY-----\nSECRETBODYAAAA\n-----END PRIVATE KEY-----';
    let msg = '';
    try { signAppJwt({ appId: 1, privateKey: bad }); } catch (e) { msg = e.message; }
    expect(msg).toMatch(/could not be used/);
    expect(msg).not.toContain('SECRETBODY');
  });
});

describe('postStatus', () => {
  test('success status posted on head SHA with installation token', async () => {
    const f = fakeFetch();
    const r = await postStatus({ ...base, fetch: f });
    expect(r.published).toBe(true);
    expect(f.calls.map((c) => c.url)).toEqual([
      'https://api.github.com/repos/o/r/installation',
      'https://api.github.com/app/installations/77/access_tokens',
      `https://api.github.com/repos/o/r/statuses/${SHA}`,
    ]);
    const jwtCall = f.calls[0].init.headers.Authorization.replace('Bearer ', '');
    const [h, p, s] = jwtCall.split('.');
    expect(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'))).toBe(true);
    expect(f.calls[2].init.headers.Authorization).toBe(`Bearer ${INSTALL_TOKEN}`);
    expect(JSON.parse(f.calls[2].init.body)).toEqual({ state: 'success', context: 'ci-local', description: base.description });
    for (const c of f.calls) expect(c.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(r)).not.toContain(INSTALL_TOKEN);
  });

  test('failure status posted', async () => {
    const f = fakeFetch();
    const r = await postStatus({ ...base, state: 'failure', fetch: f });
    expect(r.published).toBe(true);
    expect(JSON.parse(f.calls[2].init.body).state).toBe('failure');
  });

  test.each([[undefined], [null], [{}], [{ appId: '1' }], [{ appId: '1', privateKey: '' }]])(
    'no credential %j => no request, cannot attest',
    async (c) => {
      const f = fakeFetch();
      const r = await postStatus({ ...base, credential: c, fetch: f });
      expect(r).toEqual({ published: false, reason: 'cannot attest' });
      expect(f.calls).toHaveLength(0);
    }
  );

  test('invalid state refused before any request', async () => {
    const f = fakeFetch();
    const r = await postStatus({ ...base, state: 'passed', fetch: f });
    expect(r.published).toBe(false);
    expect(f.calls).toHaveLength(0);
  });

  test('over-long description refused, not truncated', async () => {
    const f = fakeFetch();
    const r = await postStatus({ ...base, description: 'x'.repeat(101), fetch: f });
    expect(r.published).toBe(false);
    expect(f.calls).toHaveLength(0);
    const ok = await postStatus({ ...base, description: 'x'.repeat(100), fetch: fakeFetch() });
    expect(ok.published).toBe(true);
  });

  test('revoked key (401) fails closed, names cause, leaks nothing', async () => {
    const f = fakeFetch({ '/installation': { status: 401, json: async () => ({ message: `Bad ${privateKey}` }) } });
    const r = await postStatus({ ...base, fetch: f });
    expect(r.published).toBe(false);
    expect(r.reason).toMatch(/authentication failed/);
    expect(r.reason).toMatch(/revoked/);
    expect(f.calls).toHaveLength(1);
    const out = JSON.stringify(r);
    expect(out).not.toContain('PRIVATE KEY');
    expect(out).not.toContain(privateKey.split('\n')[1]);
    expect(out).not.toMatch(/eyJ/);
  });

  test.each([[404, /may not be installed/], [403, /permission/], [422, /validation/]])('maps %i', async (code, re) => {
    const f = fakeFetch({ '/statuses/': { status: code, json: async () => ({}) } });
    const r = await postStatus({ ...base, fetch: f });
    expect(r.published).toBe(false);
    expect(r.reason).toMatch(re);
  });

  test('thrown fetch error containing the key and a token is redacted', async () => {
    const f = async () => { throw new Error(`boom ${privateKey} ${INSTALL_TOKEN}`); };
    const r = await postStatus({ ...base, fetch: f });
    expect(r.published).toBe(false);
    const out = JSON.stringify(r);
    expect(out).not.toContain('PRIVATE KEY');
    expect(out).not.toContain(INSTALL_TOKEN);
    expect(out).not.toContain(privateKey.split('\n')[2]);
  });

  test('a hung request is aborted by the timeout signal and fails closed', async () => {
    const f = (url, init) =>
      new Promise((_res, rej) => {
        init.signal.addEventListener('abort', () => rej(new Error('aborted')));
      });
    const spy = jest.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 5);
      return ac.signal;
    });
    const r = await postStatus({ ...base, fetch: f });
    spy.mockRestore();
    expect(r.published).toBe(false);
    expect(r.reason).toMatch(/network failure or timeout/);
  });
});

describe('redact', () => {
  test('removes PEM (multi-line, any key type), JWT and GitHub tokens deep', () => {
    const jwt = signAppJwt({ appId: 1, privateKey, now: NOW });
    const rsa = `-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\nline2+/=\n-----END RSA PRIVATE KEY-----`;
    const input = {
      a: `x ${privateKey} y`,
      b: [`t ${jwt}`, { c: rsa }],
      d: 'ghs_ABCDEFGHIJ1234 gho_ABCDEFGHIJ1234 ghp_ABCDEFGHIJ1234 github_pat_11ABCDEFGH_abcdefghij',
      n: 5,
    };
    const out = JSON.stringify(redact(input));
    for (const bad of ['PRIVATE KEY', 'MIIBOgIBAAJBAK', jwt, 'ghs_ABC', 'gho_ABC', 'ghp_ABC', 'github_pat_11']) {
      expect(out).not.toContain(bad);
    }
    expect(redact(input).n).toBe(5);
    expect(redact('keep this')).toBe('keep this');
  });
});

describe('loadCredential', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcapp-'));
    fs.mkdirSync(path.join(dir, '.ensemble'));
    fs.writeFileSync(path.join(dir, '.ensemble/local-ci-app.pem'), privateKey);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const gitOk = (args) => (args[0] === 'ls-files' ? { status: 0, stdout: '' } : { status: 0, stdout: '' });

  test('env credential used without touching git', () => {
    const git = jest.fn();
    const r = loadCredential({ env: { LOCAL_CI_APP_ID: '9', LOCAL_CI_APP_PRIVATE_KEY: 'K\\nK' }, cwd: dir, git });
    expect(r.credential).toEqual({ appId: '9', privateKey: 'K\nK' });
    expect(git).not.toHaveBeenCalled();
  });

  test('no app id => cannot attest', () => {
    expect(loadCredential({ env: {}, cwd: dir, git: gitOk }).credential).toBeNull();
  });

  test('ignored, untracked file is read', () => {
    const r = loadCredential({ env: { LOCAL_CI_APP_ID: '9' }, cwd: dir, git: gitOk });
    expect(r.credential.privateKey).toBe(privateKey);
  });

  test('tracked file refused by name, contents never read or printed', () => {
    const readFile = jest.fn();
    const git = (args) => (args[0] === 'ls-files' ? { status: 0, stdout: '.ensemble/local-ci-app.pem\n' } : { status: 0, stdout: '' });
    const r = loadCredential({ env: { LOCAL_CI_APP_ID: '9' }, cwd: dir, git, readFile });
    expect(r.credential).toBeNull();
    expect(r.reason).toContain('.ensemble/local-ci-app.pem');
    expect(r.reason).toMatch(/tracked/);
    expect(r.reason).not.toContain('PRIVATE KEY');
    expect(readFile).not.toHaveBeenCalled();
  });

  test('un-ignored file refused, never read', () => {
    const readFile = jest.fn();
    const git = (args) => (args[0] === 'ls-files' ? { status: 0, stdout: '' } : { status: 1, stdout: '' });
    const r = loadCredential({ env: { LOCAL_CI_APP_ID: '9' }, cwd: dir, git, readFile });
    expect(r.credential).toBeNull();
    expect(r.reason).toMatch(/not ignored/);
    expect(readFile).not.toHaveBeenCalled();
  });

  test('git failure fails closed', () => {
    const readFile = jest.fn();
    const r = loadCredential({ env: { LOCAL_CI_APP_ID: '9' }, cwd: dir, git: () => ({ status: 128, stdout: '' }), readFile });
    expect(r.credential).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
  });

  test('real repo rules: credential path and any *.pem are ignored, none tracked', () => {
    for (const p of ['.ensemble/local-ci-app.pem', 'some/dir/other.pem']) {
      const r = spawnSync('git', ['check-ignore', '-q', '--', p], { cwd: REPO_ROOT });
      expect(r.status).toBe(0);
    }
    const ls = spawnSync('git', ['ls-files', '*.pem'], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(ls.stdout.trim()).toBe('');
    const real = loadCredential({ env: { LOCAL_CI_APP_ID: '9' }, cwd: REPO_ROOT });
    expect(real.credential).toBeNull(); // file absent in repo: nothing read
  });
});
