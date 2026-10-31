'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  verdict,
  recordTimings,
  fidelityGaps,
  renderNote,
  checkEnablementReady,
} = require('../lib/local-ci-timing');

const TEMPLATE = path.join(__dirname, '..', 'skills', 'local-ci-gate', 'MEASUREMENT.md');
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

function compare(over = {}) {
  const r = recordTimings({
    period: '2026-10',
    toleranceMs: 5000,
    versions: {
      22: { coldMs: 300000, warmMs: 200000, hostedMs: 170000 },
      24: { coldMs: 320000, warmMs: 210000, hostedMs: 175000 },
    },
    ...over,
  });
  return r;
}

describe('local-ci-timing: verdict', () => {
  test('states faster, slower or equal against an explicit tolerance', () => {
    expect(verdict(100000, 170000, 1000).verdict).toBe('faster');
    expect(verdict(200000, 170000, 1000).verdict).toBe('slower');
    expect(verdict(170500, 170000, 1000).verdict).toBe('equal');
    expect(verdict(172000, 170000, 1000).verdict).toBe('slower');
  });

  test('missing figure is unmeasured, never zero-derived', () => {
    expect(verdict(null, 170000, 1000).verdict).toBe('unmeasured');
    expect(verdict(100000, undefined, 1000).verdict).toBe('unmeasured');
  });

  test('refuses a missing tolerance or a non-positive figure', () => {
    expect(verdict(1, 2).ok).toBe(false);
    expect(verdict(1, 2, -1).ok).toBe(false);
    expect(verdict(0, 170000, 1000).ok).toBe(false);
    expect(verdict('fast', 170000, 1000).ok).toBe(false);
  });
});

describe('local-ci-timing: recordTimings and renderNote', () => {
  test('cold, warm and hosted appear together per Node version', () => {
    const note = renderNote(compare());
    const row22 = note.split('\n').find((l) => l.startsWith('| 22 |'));
    const row24 = note.split('\n').find((l) => l.startsWith('| 24 |'));
    expect(row22).toContain('300.0s');
    expect(row22).toContain('200.0s');
    expect(row22).toContain('170.0s');
    expect(row24).toContain('320.0s');
    expect(row24).toContain('210.0s');
    expect(row24).toContain('175.0s');
  });

  test('a missing hosted figure also makes the verdict unmeasured', () => {
    const c = compare({ versions: { 22: { coldMs: 300000, warmMs: 200000 } } });
    expect(c.rows[0].hosted).toEqual({ ms: null, missing: true });
    expect(c.verdict).toBe('unmeasured');
  });

  test('a missing figure is reported as missing and the verdict is unmeasured', () => {
    const c = compare({ versions: { 22: { coldMs: 300000, hostedMs: 170000 } } });
    expect(c.rows[0].warm).toEqual({ ms: null, missing: true });
    expect(c.verdict).toBe('unmeasured');
    const note = renderNote(c);
    expect(note).toMatch(/\| 22 \| 300\.0s \| MISSING \| 170\.0s \|/);
    expect(note).toMatch(/^Verdict: unmeasured$/m);
    expect(note).not.toMatch(/(^|[^0-9.])0\.0s/);
  });

  test('slower is stated, attributed to the bot-review wait, and no run-time speedup is claimed', () => {
    const note = renderNote(compare());
    expect(note).toMatch(/^Verdict: slower$/m);
    expect(note).toContain('removing the bot-review wait, not from run time');
    expect(note).not.toMatch(/faster|speedup|speed-up/i);
  });

  test('basis changes the verdict: warm faster than hosted, cold slower', () => {
    const versions = { 22: { coldMs: 300000, warmMs: 100000, hostedMs: 170000 } };
    expect(compare({ versions, basis: 'cold' }).verdict).toBe('slower');
    expect(compare({ versions, basis: 'warm' }).verdict).toBe('faster');
  });

  test('any slower version makes the overall verdict slower', () => {
    const c = compare({
      basis: 'warm',
      versions: {
        22: { coldMs: 150000, warmMs: 100000, hostedMs: 170000 },
        24: { coldMs: 350000, warmMs: 300000, hostedMs: 170000 },
      },
    });
    expect(c.verdict).toBe('slower');
  });

  test('rejects zero, negative, non-numeric figures and empty versions', () => {
    expect(compare({ versions: { 22: { coldMs: 0, hostedMs: 1 } } }).ok).toBe(false);
    expect(compare({ versions: { 22: { warmMs: -5 } } }).ok).toBe(false);
    expect(compare({ versions: { 22: { hostedMs: '170' } } }).ok).toBe(false);
    expect(compare({ versions: {} }).ok).toBe(false);
    expect(compare({ toleranceMs: undefined }).ok).toBe(false);
  });

  test('renderNote refuses a failed comparison', () => {
    expect(renderNote(compare({ versions: {} })).ok).toBe(false);
  });
});

describe('local-ci-timing: fidelityGaps', () => {
  test('job passing hosted and failing locally is listed as a gap, and in the note', () => {
    const local = { headSha: SHA, jobs: { validate: 'pass', test: 'fail' } };
    const hosted = { headSha: SHA, jobs: { validate: 'pass', test: 'pass' } };
    const g = fidelityGaps(local, hosted);
    expect(g).toEqual({ ok: true, gaps: [{ job: 'test', local: 'fail', hosted: 'pass' }] });
    const note = renderNote(compare({ local, hosted }));
    expect(note).toContain('- test: local fail, hosted pass');
    expect(note).not.toContain('- validate');
  });

  test('both directions plus cannot-run and not-present count; agreement does not', () => {
    const g = fidelityGaps(
      { headSha: SHA, jobs: { a: 'fail', b: 'pass', c: 'cannot-run', d: 'fail', e: 'pass', onlyLocal: 'pass' } },
      { headSha: SHA, jobs: { a: 'pass', b: 'fail', c: 'pass', d: 'fail', onlyHosted: 'pass', e: 'cannot-run' } }
    );
    expect(g.gaps).toEqual([
      { job: 'a', local: 'fail', hosted: 'pass' },
      { job: 'b', local: 'pass', hosted: 'fail' },
      { job: 'c', local: 'cannot-run', hosted: 'pass' },
      { job: 'e', local: 'pass', hosted: 'cannot-run' },
      { job: 'onlyHosted', local: 'not-present', hosted: 'pass' },
      { job: 'onlyLocal', local: 'pass', hosted: 'not-present' },
    ]);
  });

  test('identical results have no gaps', () => {
    const r = { headSha: SHA, jobs: { x: 'pass', y: 'fail' } };
    expect(fidelityGaps(r, r)).toEqual({ ok: true, gaps: [] });
  });

  test('different head SHAs are never compared and the error names both', () => {
    const g = fidelityGaps({ headSha: SHA, jobs: { x: 'pass' } }, { headSha: OTHER, jobs: { x: 'pass' } });
    expect(g.ok).toBe(false);
    expect(g.error).toContain(SHA);
    expect(g.error).toContain(OTHER);
    expect(compare({ local: { headSha: SHA, jobs: {} }, hosted: { headSha: OTHER, jobs: {} } }).ok).toBe(false);
  });

  test('malformed or unknown-status results fail closed', () => {
    expect(fidelityGaps(null, { headSha: SHA, jobs: {} }).ok).toBe(false);
    expect(fidelityGaps({ headSha: SHA, jobs: { x: 'passed' } }, { headSha: SHA, jobs: {} }).ok).toBe(false);
    expect(fidelityGaps({ jobs: {} }, { headSha: SHA, jobs: {} }).ok).toBe(false);
  });
});

describe('local-ci-timing: checkEnablementReady', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-ci-timing-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('refused when no note exists', () => {
    const r = checkEnablementReady({ notePath: path.join(dir, 'MEASUREMENT.md') });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no measurement note/);
    expect(checkEnablementReady({}).ok).toBe(false);
  });

  test('the shipped note is filled: the checker accepts it and reports its stated verdict', () => {
    const r = checkEnablementReady({ notePath: TEMPLATE });
    expect(r).toEqual({ ok: true, verdict: expect.stringMatching(/^(faster|slower|equal)$/) });
    expect(fs.readFileSync(TEMPLATE, 'utf8')).not.toContain('TEMPLATE-UNFILLED');
  });

  test('an unfilled template is refused: the shipped note with the marker put back is not accepted', () => {
    const filled = fs.readFileSync(TEMPLATE, 'utf8');
    const r = checkEnablementReady({ note: `<!-- TEMPLATE-UNFILLED: delete this line only when every figure below is filled from a real run. -->\n${filled}` });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/template/);
  });

  test('refused when the note states no verdict or an unmeasured one', () => {
    expect(checkEnablementReady({ note: '# Note\n\nlocal was 3 minutes\n' }).ok).toBe(false);
    expect(checkEnablementReady({ note: '' }).ok).toBe(false);
    const unmeasured = renderNote(compare({ versions: { 22: { coldMs: 1000 } } }));
    expect(checkEnablementReady({ note: unmeasured }).ok).toBe(false);
  });

  test('refused when a slower note omits the bot-review-wait attribution', () => {
    expect(checkEnablementReady({ note: 'Verdict: slower\n' }).ok).toBe(false);
  });

  test('accepted for a filled note read from disk, for each stated verdict', () => {
    const slower = renderNote(compare());
    const p = path.join(dir, 'MEASUREMENT.md');
    fs.writeFileSync(p, slower);
    expect(checkEnablementReady({ notePath: p })).toEqual({ ok: true, verdict: 'slower' });

    const faster = renderNote(compare({ toleranceMs: 1, versions: { 22: { coldMs: 100000, warmMs: 90000, hostedMs: 170000 } } }));
    expect(checkEnablementReady({ note: faster })).toEqual({ ok: true, verdict: 'faster' });
    const equal = renderNote(compare({ versions: { 22: { coldMs: 170000, warmMs: 160000, hostedMs: 171000 } } }));
    expect(checkEnablementReady({ note: equal })).toEqual({ ok: true, verdict: 'equal' });
  });
});
