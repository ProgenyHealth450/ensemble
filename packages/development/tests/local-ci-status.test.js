'use strict';

/**
 * Status publisher (TRD-014-TEST). The gate posts the commit status with the maintainer's own `gh` login, as an argv
 * array. `run` is injected, so no process is spawned and no network is touched. Nothing here may throw, and no token
 * may ever appear on argv or in a returned string.
 */

const fs = require('fs');
const path = require('path');
const status = require('../lib/local-ci-status');

const { postStatus, redact, STATES, MAX_DESCRIPTION, CANNOT_ATTEST } = status;

const SHA = 'a'.repeat(40);
const TOKEN = 'ghp_' + 'A'.repeat(36);
const base = { repo: 'owner/name', sha: SHA, state: 'success', context: 'ensemble/local-ci', description: 'ci-local passed' };
const ok = (obj = { id: 99 }) => ({ status: 0, stdout: JSON.stringify(obj), stderr: '' });
const fakeRun = (result) => {
  const fn = jest.fn(typeof result === 'function' ? result : () => result);
  return fn;
};

describe('module surface', () => {
  it('exports the contract and none of the App machinery', () => {
    expect(Object.keys(status).sort()).toEqual(['CANNOT_ATTEST', 'MAX_DESCRIPTION', 'STATES', 'postStatus', 'redact']);
    expect(MAX_DESCRIPTION).toBe(100);
    expect(CANNOT_ATTEST).toBe('cannot attest');
    expect(STATES).toEqual(expect.arrayContaining(['success', 'failure', 'pending', 'error']));
    for (const gone of ['signAppJwt', 'loadCredential', 'KEY_FILE']) expect(status[gone]).toBeUndefined();
  });

  it('the old App module and its env vars are gone from the tree', () => {
    expect(fs.existsSync(path.join(__dirname, '..', 'lib', 'local-ci-app.js'))).toBe(false);
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'local-ci-status.js'), 'utf8');
    expect(src).not.toMatch(/LOCAL_CI_APP|signAppJwt|loadCredential|\bfetch\(|createSign|installation/);
  });
});

describe('postStatus success', () => {
  it('posts via gh as an exact argv array, with no shell option', () => {
    const run = fakeRun(ok({ id: 4242 }));
    const r = postStatus({ ...base, run, env: {} });
    expect(r).toEqual({ published: true, repo: 'owner/name', sha: SHA, state: 'success', context: 'ensemble/local-ci', id: 4242 });
    expect(run).toHaveBeenCalledTimes(1);
    const [cmd, argv, opts] = run.mock.calls[0];
    expect(cmd).toBe('gh');
    expect(argv).toEqual(['api', '-X', 'POST', `repos/owner/name/statuses/${SHA}`, '-f', 'state=success', '-f', 'context=ensemble/local-ci', '-f', 'description=ci-local passed']);
    expect(Array.isArray(argv)).toBe(true);
    expect(opts && opts.shell).toBeFalsy();
  });

  it('keeps a description with shell metacharacters as one argv element (never interpreted)', () => {
    const run = fakeRun(ok());
    const description = 'x; rm -rf / $(id) `id` "q"';
    postStatus({ ...base, description, run, env: {} });
    expect(run.mock.calls[0][1]).toContain(`description=${description}`);
  });

  it('accepts a description of exactly MAX_DESCRIPTION characters', () => {
    const run = fakeRun(ok());
    expect(postStatus({ ...base, description: 'x'.repeat(100), run, env: {} }).published).toBe(true);
  });

  it('the default runner needs no injected dependency and never throws without gh', () => {
    const r = postStatus({ ...base, env: { PATH: '/nonexistent-dir' } });
    expect(r.published).toBe(false);
    expect(typeof r.reason).toBe('string');
  });
});

describe('postStatus fails closed', () => {
  it.each([
    ['gh missing (spawn error)', () => { throw Object.assign(new Error('spawnSync gh ENOENT'), { code: 'ENOENT' }); }, /gh/],
    ['gh not logged in', { status: 1, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login' }, /exited with status 1.*auth login/],
    ['403 forbidden', { status: 1, stdout: '', stderr: 'gh: Resource not accessible by personal access token (HTTP 403)' }, /403/],
    ['404 not found', { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }, /404/],
    ['unparsable output', { status: 0, stdout: '<html>not json</html>', stderr: '' }, /not JSON/],
    ['no status id', { status: 0, stdout: '{}', stderr: '' }, /no status id/],
    ['null result', null, /no result/],
  ])('%s -> published:false with a reason', (_n, result, re) => {
    const r = postStatus({ ...base, run: fakeRun(result), env: {} });
    expect(r.published).toBe(false);
    expect(r.reason).toMatch(re);
    expect(r.id).toBeUndefined();
  });

  it('a non-zero exit is a refusal even when stdout looks like a success body', () => {
    const r = postStatus({ ...base, run: fakeRun({ status: 1, stdout: '{"id":5}', stderr: '' }), env: {} });
    expect(r.published).toBe(false);
  });

  it('a thrown spawn error never escapes', () => {
    expect(() => postStatus({ ...base, run: () => { throw new Error('boom'); }, env: {} })).not.toThrow();
    expect(() => postStatus({ ...base, run: () => { throw 'a string'; }, env: {} })).not.toThrow();
    expect(() => postStatus()).not.toThrow();
    expect(postStatus().published).toBe(false);
  });
});

describe('invalid input spawns nothing', () => {
  it.each([
    ['repo not owner/name', { repo: 'justname' }],
    ['repo with a path escape', { repo: 'a/b/../c' }],
    ['repo with shell text', { repo: 'a/b;id' }],
    ['repo missing', { repo: undefined }],
    ['sha too short', { sha: 'abc12' }],
    ['sha not hex', { sha: 'z'.repeat(40) }],
    ['sha with injection', { sha: `${'a'.repeat(7)}; id` }],
    ['sha too long', { sha: 'a'.repeat(65) }],
    ['unknown state', { state: 'passed' }],
    ['state missing', { state: undefined }],
    ['empty context', { context: '' }],
    ['blank context', { context: '   ' }],
    ['non-string context', { context: 5 }],
    ['over-long description (rejected, not truncated)', { description: 'x'.repeat(MAX_DESCRIPTION + 1) }],
    ['non-string description', { description: 7 }],
  ])('%s', (_n, over) => {
    const run = fakeRun(ok());
    const r = postStatus({ ...base, ...over, run, env: {} });
    expect(r.published).toBe(false);
    expect(typeof r.reason).toBe('string');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('the default runner really spawns gh without a shell', () => {
  const { fakeGhDir, postedArgs, cleanupBaseRepos } = require('./helpers/local-ci-base-repo');
  afterAll(() => cleanupBaseRepos());

  it('a description full of shell metacharacters reaches gh as ONE argv element and runs nothing', () => {
    const ghDir = fakeGhDir({});
    const marker = `/tmp/lci-sh-${process.pid}`; // short on purpose: the whole description must fit the 100-char cap
    const description = `x"; touch ${marker}; echo "`;
    expect(description.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
    // No `run` is injected: this goes through the real default spawn path, with the fake gh first on PATH.
    const result = postStatus({ ...base, description, env: { PATH: `${ghDir}:/usr/bin:/bin` } });
    expect(result).toMatchObject({ published: true, id: 99 });
    expect(fs.existsSync(marker)).toBe(false); // a shell would have run `touch`
    expect(postedArgs(ghDir)).toContain(`description=${description}`);
  });
});

describe('the token never leaks', () => {
  const env = { GH_TOKEN: 'sekrit-value-1234', GITHUB_TOKEN: 'another-secret-5678', PATH: '/bin' };

  it('is never put on argv', () => {
    const run = fakeRun(ok());
    postStatus({ ...base, run, env });
    const [, argv] = run.mock.calls[0];
    expect(JSON.stringify(argv)).not.toMatch(/sekrit-value-1234|another-secret-5678|Bearer|Authorization/i);
  });

  it('a GH_TOKEN value echoed in stderr is redacted from the reason', () => {
    const run = fakeRun({ status: 1, stdout: '', stderr: `gh: bad credentials for sekrit-value-1234 and another-secret-5678` });
    const r = postStatus({ ...base, run, env });
    expect(r.published).toBe(false);
    expect(JSON.stringify(r)).not.toContain('sekrit-value-1234');
    expect(JSON.stringify(r)).not.toContain('another-secret-5678');
  });

  it('a token-shaped string in stderr is redacted from the reason', () => {
    const r = postStatus({ ...base, run: fakeRun({ status: 1, stdout: '', stderr: `denied ${TOKEN}` }), env: {} });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('a GH_TOKEN value in a thrown error message is redacted', () => {
    const r = postStatus({ ...base, run: () => { throw new Error('failed with sekrit-value-1234'); }, env });
    expect(JSON.stringify(r)).not.toContain('sekrit-value-1234');
  });

  it('a token in the input description or context is never echoed back on a refusal', () => {
    const r = postStatus({ ...base, state: 'bogus', run: fakeRun(ok()), env });
    expect(JSON.stringify(r)).not.toContain('sekrit-value-1234');
  });

  it('a success result carries no token', () => {
    const r = postStatus({ ...base, run: fakeRun(ok()), env });
    expect(JSON.stringify(r)).not.toMatch(/sekrit|another-secret/);
  });
});

describe('redact', () => {
  it.each(['ghp_', 'gho_', 'ghs_', 'ghu_', 'ghr_'])('removes %s tokens, deeply', (prefix) => {
    const t = prefix + 'Z'.repeat(36);
    const out = JSON.stringify(redact({ a: [`x ${t} y`, { b: `${t}` }], c: `${t}` }));
    expect(out).not.toContain(t);
    expect(out).toContain('[REDACTED]');
  });

  it('removes github_pat_ tokens and Bearer values', () => {
    const pat = 'github_pat_' + 'Q'.repeat(40);
    const out = JSON.stringify(redact({ x: [`a ${pat}`, 'Authorization: Bearer abc.def-ghi123']}));
    expect(out).not.toContain(pat);
    expect(out).not.toContain('abc.def-ghi123');
  });

  it('removes the GH_TOKEN and GITHUB_TOKEN values found in env, only when supplied', () => {
    const env = { GH_TOKEN: 'plain-secret-aaaa', GITHUB_TOKEN: 'plain-secret-bbbb' };
    const out = JSON.stringify(redact(['x plain-secret-aaaa', { y: 'plain-secret-bbbb' }], env));
    expect(out).not.toMatch(/plain-secret/);
    expect(JSON.stringify(redact('plain-secret-aaaa'))).toContain('plain-secret-aaaa');
  });

  it('keeps removing PEM and JWT shapes (defense in depth)', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxMjM0NSJ9.c2lnbmF0dXJl';
    const out = JSON.stringify(redact({ a: `k ${pem} k`, b: [jwt] }));
    expect(out).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC');
    expect(out).not.toContain(jwt);
  });

  it('redacts sensitive-named keys and Error messages, and leaves plain text alone', () => {
    expect(redact({ token: 'x', private_key: 'y', ok: 'fine' })).toEqual({ token: '[REDACTED]', private_key: '[REDACTED]', ok: 'fine' });
    expect(redact(new Error(`boom ${TOKEN}`))).not.toContain(TOKEN);
    expect(redact(3)).toBe(3);
  });
});
