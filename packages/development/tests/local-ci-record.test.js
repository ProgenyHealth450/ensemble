'use strict';

const { buildRecord, parseRecord, verifyRecord } = require('../lib/local-ci-record');

const BLOB = 'ABCDEF0123456789abcdef0123456789abcdef01';
const SET = ['ci.yml', 'lint.yml'];
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

function build(over = {}) {
  const r = buildRecord({ runnerBlobSha: BLOB, workflowSet: SET, log: 'all green', ...over });
  expect(r.ok).toBe(true);
  return r;
}

describe('local-ci-record', () => {
  test('record round trip: runner, set hash and log digest all match', () => {
    const built = build();
    expect(built.description).toMatch(/^ci-local abcdef012345 \| set:[0-9a-f]{8} \| log:[0-9a-f]{12}$/);
    expect(built.description.length).toBeLessThanOrEqual(100);
    const parsed = parseRecord(built.description);
    expect(parsed).toEqual({ ok: true, fields: built.fields });
    expect(parsed.fields.runner).toBe('abcdef012345');
  });

  test('set hash is order-independent but sensitive to membership', () => {
    expect(build({ workflowSet: ['b', 'a'] }).fields.set).toBe(build({ workflowSet: ['a', 'b'] }).fields.set);
    expect(build({ workflowSet: ['a'] }).fields.set).not.toBe(build({ workflowSet: ['a', 'b'] }).fields.set);
  });

  test('new commit invalidates: verification fails naming A and B', () => {
    const { description } = build();
    expect(verifyRecord({ description, statusCommitSha: A, headSha: A, runnerBlobSha: BLOB, workflowSet: SET }).ok).toBe(true);
    const r = verifyRecord({ description, statusCommitSha: A, headSha: B, runnerBlobSha: BLOB, workflowSet: SET });
    expect(r.ok).toBe(false);
    expect(r.headMismatch).toContain(A);
    expect(r.headMismatch).toContain(B);
    expect(r.setMismatch).toBeUndefined();
  });

  test('force-push invalidates: unrelated replacement commit fails', () => {
    const { description } = build();
    const r = verifyRecord({ description, statusCommitSha: A, headSha: 'c'.repeat(40), runnerBlobSha: BLOB, workflowSet: SET });
    expect(r.ok).toBe(false);
    expect(r.headMismatch).toBeDefined();
  });

  test('workflow set drift fails and names the difference', () => {
    const { description, fields } = build();
    const r = verifyRecord({ description, statusCommitSha: A, headSha: A, runnerBlobSha: BLOB, workflowSet: [...SET, 'new.yml'] });
    expect(r.ok).toBe(false);
    expect(r.setMismatch).toContain(fields.set);
    expect(r.headMismatch).toBeUndefined();
  });

  test('both mismatches are reported together', () => {
    const { description } = build();
    const r = verifyRecord({ description, statusCommitSha: A, headSha: B, runnerBlobSha: BLOB, workflowSet: ['x'] });
    expect(r.ok).toBe(false);
    expect(r.headMismatch).toBeDefined();
    expect(r.setMismatch).toBeDefined();
  });

  test('log never embedded: token-shaped string appears only as a digest', () => {
    const token = 'ghp_' + 'A1b2C3d4'.repeat(5);
    const { description, fields } = build({ log: `before ${token} after` });
    expect(description).not.toContain(token);
    expect(description).not.toContain('ghp_');
    expect(fields.log).toMatch(/^[0-9a-f]{12}$/);
    expect(fields.log).not.toBe(build({ log: 'other' }).fields.log);
  });

  test('truncated record rejected with an error, not partial fields', () => {
    const { description } = build();
    for (const cut of [5, 20, description.length - 1]) {
      const r = parseRecord(description.slice(0, cut));
      expect(r.ok).toBe(false);
      expect(r.error).toBeDefined();
      expect(r.fields).toBeUndefined();
    }
  });

  test('malformed records rejected', () => {
    const { description } = build();
    for (const bad of ['', null, undefined, 42, description.toUpperCase(), description + ' ', `x${description}`,
      description.replace('set:', 'sat:'), description.replace('ci-local ', 'ci-local  ')]) {
      expect(parseRecord(bad).ok).toBe(false);
    }
  });

  test('over-length description rejected on parse and never produced on build', () => {
    const { description } = build();
    const long = description + ' '.repeat(101 - description.length);
    expect(long.length).toBeGreaterThan(100);
    expect(parseRecord(long).ok).toBe(false);
    // a huge log still yields a bounded description
    expect(build({ log: 'x'.repeat(1e6) }).description.length).toBeLessThanOrEqual(100);
    // verify refuses an over-length description too
    expect(verifyRecord({ description: long, statusCommitSha: A, headSha: A, runnerBlobSha: BLOB, workflowSet: SET })).toMatchObject({ ok: false, error: expect.stringMatching(/100 characters/) });
  });

  test('build and verify fail closed on bad input', () => {
    expect(buildRecord(null).ok).toBe(false);
    expect(buildRecord({ runnerBlobSha: 'zz', workflowSet: SET, log: '' }).ok).toBe(false);
    expect(buildRecord({ runnerBlobSha: BLOB, workflowSet: 'ci.yml', log: '' }).ok).toBe(false);
    expect(buildRecord({ runnerBlobSha: BLOB, workflowSet: [''], log: '' }).ok).toBe(false);
    expect(buildRecord({ runnerBlobSha: BLOB, workflowSet: SET, log: null }).ok).toBe(false);
    const { description } = build();
    // each isolates ONE cause: a valid trusted blob is supplied so the blob requirement cannot be what refuses
    expect(verifyRecord({ description, statusCommitSha: A, headSha: undefined, runnerBlobSha: BLOB, workflowSet: SET })).toMatchObject({ ok: false, error: expect.stringMatching(/headSha/) });
    expect(verifyRecord({ description, statusCommitSha: A, headSha: A, runnerBlobSha: BLOB, workflowSet: null })).toMatchObject({ ok: false, error: expect.stringMatching(/workflowSet/) });
    expect(verifyRecord({ description: 'junk', statusCommitSha: A, headSha: A, runnerBlobSha: BLOB, workflowSet: SET })).toMatchObject({ ok: false, error: expect.stringMatching(/well-formed/) });
  });
  describe('commit SHA normalization', () => {
    const verify = (statusCommitSha, headSha) => verifyRecord({ description: build().description, statusCommitSha, headSha, runnerBlobSha: BLOB, workflowSet: SET });

    test('the same commit in a different letter case verifies (hex is case-insensitive)', () => {
      expect(verify('ABCDEF0123456789ABCDEF0123456789ABCDEF01', 'abcdef0123456789abcdef0123456789abcdef01').ok).toBe(true);
      expect(verify('abcdef0123456789abcdef0123456789abcdef01', 'ABCDEF0123456789ABCDEF0123456789ABCDEF01').ok).toBe(true);
    });

    test('different commits still mismatch after normalization', () => {
      const r = verify(A, B.toUpperCase());
      expect(r.ok).toBe(false);
      expect(r.headMismatch).toBeDefined();
    });

    test.each([
      ['abbreviated', 'abc1234'],
      ['39 hex', 'a'.repeat(39)],
      ['41 hex', 'a'.repeat(41)],
      ['non-hex', 'g'.repeat(40)],
      ['a branch name', 'main'],
    ])('a %s sha on either side is refused, never compared', (_n, bad) => {
      expect(verify(bad, bad).ok).toBe(false);
      expect(verify(bad, bad).headMismatch).toBeUndefined();
      expect(verify(A, bad).ok).toBe(false);
      expect(verify(bad, A).ok).toBe(false);
    });
  });

  describe('the record binds the trusted config blob', () => {
    const verify = (over = {}) =>
      verifyRecord({ description: build().description, statusCommitSha: A, headSha: A, runnerBlobSha: BLOB, workflowSet: SET, ...over });

    test('the blob is REQUIRED: omitting it is refused, never skipped', () => {
      for (const missing of [undefined, null, '', 'abc', 12345, 'zz'.repeat(10)]) {
        const r = verify({ runnerBlobSha: missing });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/runnerBlobSha is required/);
      }
    });

    test('a different trusted blob is a runnerMismatch naming both short hashes', () => {
      const r = verify({ runnerBlobSha: '1234567890abcdef1234567890abcdef12345678' });
      expect(r).toMatchObject({ ok: false });
      expect(r.runnerMismatch).toContain('abcdef012345');
      expect(r.runnerMismatch).toContain('1234567890ab');
    });

    test('the field is 12 hex (48 bits): two blobs that agree on only 8 hex do NOT verify', () => {
      const sameFirst8 = 'ABCDEF01' + 'f'.repeat(32);
      const r = verify({ runnerBlobSha: sameFirst8 });
      expect(r.ok).toBe(false);
      expect(r.runnerMismatch).toBeDefined();
    });

    test('a blob that matches in the first 12 hex verifies, case-insensitively', () => {
      expect(verify({ runnerBlobSha: BLOB.toLowerCase() }).ok).toBe(true);
      expect(verify({ runnerBlobSha: BLOB.toUpperCase() }).ok).toBe(true);
    });

    test('an 8-hex record from before the widening does not parse (it cannot be mistaken for a current one)', () => {
      expect(parseRecord('ci-local abcdef01 | set:0123abcd | log:0123456789ab').ok).toBe(false);
    });

    test('the description stays far inside the 100-character bound', () => {
      expect(build().description.length).toBeLessThanOrEqual(60);
    });
  });
});
