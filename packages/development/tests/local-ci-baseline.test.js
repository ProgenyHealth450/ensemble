'use strict';

const fs = require('fs');
const path = require('path');
const { percentile, summarizeCohort, reportStatus } = require('../lib/local-ci-baseline');

const H = 3600000;
const T0 = Date.parse('2026-01-01T00:00:00Z');

function pr(number, openToMergeH, ciH, botH) {
  const p = {
    number,
    openedAt: new Date(T0).toISOString(),
    mergedAt: new Date(T0 + openToMergeH * H).toISOString(),
  };
  if (ciH !== undefined) p.ciWaitMs = ciH * H;
  if (botH !== undefined) p.botReviewWaitMs = botH * H;
  return p;
}

describe('median and p75 reported', () => {
  const prs = [pr(1, 1), pr(2, 2), pr(3, 3), pr(4, 10)];

  it('percentile matches hand computation (linear interpolation)', () => {
    // sorted [1,2,3,10]: median pos 1.5 -> 2.5 ; p75 pos 2.25 -> 3 + .25*7 = 4.75
    expect(percentile([10, 1, 3, 2], 0.5)).toBe(2.5);
    expect(percentile([10, 1, 3, 2], 0.75)).toBe(4.75);
    expect(percentile([5], 0.75)).toBe(5);
  });

  it('summarizeCohort open-to-merge median and p75 match hand computation', () => {
    const s = summarizeCohort(prs);
    expect(s.count).toBe(4);
    expect(s.openToMerge.median).toBe(2.5 * H);
    expect(s.openToMerge.p75).toBe(4.75 * H);
  });

  it('returns null, not zero, for no data or bad percentile', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([1], 2)).toBeNull();
    expect(summarizeCohort([]).openToMerge.median).toBeNull();
  });

  it('rejects malformed PRs instead of counting them', () => {
    const s = summarizeCohort([
      pr(1, 2),
      null,
      { number: 3, openedAt: 'nope', mergedAt: 'x' },
      { number: 4, openedAt: '2026-01-02T00:00:00Z', mergedAt: '2026-01-01T00:00:00Z' },
    ]);
    expect(s.count).toBe(1);
    expect(s.rejected).toHaveLength(3);
    expect(s.openToMerge.median).toBe(2 * H);
  });
});

describe('waits split', () => {
  it('attributes CI wait and bot-review wait separately', () => {
    const s = summarizeCohort([
      pr(1, 10, 1, 4),
      pr(2, 10, 2, 6),
      pr(3, 10, 3, 8),
    ]);
    expect(s.ciWait.median).toBe(2 * H);
    expect(s.ciWait.p75).toBe(2.5 * H);
    expect(s.botReviewWait.median).toBe(6 * H);
    expect(s.botReviewWait.p75).toBe(7 * H);
  });

  it('a missing wait is left out of that series only, never read as zero', () => {
    const s = summarizeCohort([pr(1, 10, 4, undefined), pr(2, 10, 8, 6)]);
    expect(s.ciWait.count).toBe(2);
    expect(s.ciWait.median).toBe(6 * H);
    expect(s.botReviewWait.count).toBe(1);
    expect(s.botReviewWait.median).toBe(6 * H);
  });

  it('ignores negative or non-numeric waits', () => {
    const p = pr(1, 10);
    p.ciWaitMs = -5;
    p.botReviewWaitMs = '3';
    const s = summarizeCohort([p]);
    expect(s.ciWait.count).toBe(0);
    expect(s.botReviewWait.count).toBe(0);
  });
});

describe('insufficient data is unproven', () => {
  const baseline = [pr(1, 10), pr(2, 12), pr(3, 14)];
  const good = [pr(11, 2), pr(12, 3), pr(13, 4)];

  it('too few post-change PRs => unproven even with a huge improvement', () => {
    const r = reportStatus({
      baseline,
      postChange: [pr(11, 1)],
      minPostChangeCohort: 3,
      targetReduction: 0.3,
    });
    expect(r.status).toBe('unproven');
  });

  it('undecided minimum or target => unproven', () => {
    expect(reportStatus({ baseline, postChange: good, targetReduction: 0.3 }).status).toBe('unproven');
    expect(reportStatus({ baseline, postChange: good, minPostChangeCohort: 3 }).status).toBe('unproven');
    expect(
      reportStatus({ baseline, postChange: good, minPostChangeCohort: 3, targetReduction: 0 }).status
    ).toBe('unproven');
  });

  it('missing baseline or no input => unproven', () => {
    expect(
      reportStatus({ postChange: good, minPostChangeCohort: 3, targetReduction: 0.3 }).status
    ).toBe('unproven');
    expect(reportStatus().status).toBe('unproven');
  });

  it('met only with enough data and both median and p75 reduced by the target', () => {
    const base = { baseline, minPostChangeCohort: 3, targetReduction: 0.3 };
    expect(reportStatus({ ...base, postChange: good }).status).toBe('met');
    // median fine (3 vs 12) but p75 (11.5h vs 13h) not reduced enough
    const slowTail = [pr(11, 2), pr(12, 3), pr(13, 20)];
    expect(reportStatus({ ...base, postChange: slowTail }).status).toBe('not-met');
  });

  it('reports both cohorts so they can be shown side by side', () => {
    const r = reportStatus({ baseline, postChange: good, minPostChangeCohort: 3, targetReduction: 0.3 });
    expect(r.baseline.openToMerge.median).toBe(12 * H);
    expect(r.postChange.openToMerge.median).toBe(3 * H);
  });
});

describe('baseline precedes enablement', () => {
  const note = fs.readFileSync(
    path.join(__dirname, '..', 'skills', 'local-ci-gate', 'BASELINE.md'),
    'utf8'
  );

  it('carries a capture date and the unproven state', () => {
    const m = note.match(/Capture date:\s*(\d{4}-\d{2}-\d{2})/);
    expect(m).not.toBeNull();
    expect(Number.isNaN(Date.parse(m[1]))).toBe(false);
    expect(note).toMatch(/target unproven until measured/);
    expect(note).toMatch(/DECIDED FROM this baseline/);
  });

  it('has no enablement record dated on or before the capture date', () => {
    const capture = Date.parse(note.match(/Capture date:\s*(\d{4}-\d{2}-\d{2})/)[1]);
    const line = note.match(/Gate enablement record:\s*(.*)/);
    expect(line).not.toBeNull();
    const dated = line[1].match(/(\d{4}-\d{2}-\d{2})/);
    if (dated) {
      expect(Date.parse(dated[1])).toBeGreaterThan(capture);
    } else {
      expect(line[1]).toMatch(/^none/i);
    }
  });

  it('does not fabricate figures: results table is unfilled', () => {
    const table = note.split('## Results')[1].split('## Decisions')[0];
    expect(table).not.toMatch(/\d+(\.\d+)?\s*(h|hours|min|ms|s)\b/i);
    expect(table).toMatch(/unfilled/);
  });
});
