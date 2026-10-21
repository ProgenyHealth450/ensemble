'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { extractEstimateHours, computeEstimateActual, parseIssues } = require('../lib/estimate-actual');

const closed = (id, title, hours, extra = {}) => ({
  id,
  title,
  description: '',
  status: 'closed',
  created_at: '2026-01-01T00:00:00Z',
  closed_at: new Date(Date.parse('2026-01-01T00:00:00Z') + hours * 3600e3).toISOString(),
  ...extra,
});

describe('extractEstimateHours', () => {
  it('reads (Nh), (Est: Nh), decimals; title wins over description', () => {
    expect(extractEstimateHours({ title: 'x (3h)' })).toBe(3);
    expect(extractEstimateHours({ title: 'x', description: '**TRD-019** (Est: 5h) body' })).toBe(5);
    expect(extractEstimateHours({ title: 'x (1.5h)', description: '(9h)' })).toBe(1.5);
    expect(extractEstimateHours({ title: 'no estimate', description: 'in 5 hours' })).toBeNull();
  });
});

describe('computeEstimateActual', () => {
  const issues = [
    closed('a', 'a (2h)', 4),
    closed('b', 'b (4h)', 4),
    closed('c', 'c (2h)', 1),
    closed('d', 'no estimate', 3),
    { id: 'e', title: 'open (2h)', status: 'open', created_at: '2026-01-01T00:00:00Z' },
    closed('f', 'f (2h)', 1, { closed_at: null }),
    closed('g', 'g (2h)', 1, { closed_at: '2025-12-01T00:00:00Z' }),
  ];
  const out = computeEstimateActual(issues);

  it('computes ratios and excludes open / untimed beads', () => {
    expect(out.beads).toEqual([
      { id: 'a', estimateH: 2, actualH: 4, ratio: 2 },
      { id: 'b', estimateH: 4, actualH: 4, ratio: 1 },
      { id: 'c', estimateH: 2, actualH: 1, ratio: 0.5 },
    ]);
  });

  it('summarises median, p90 and counts closed beads lacking an estimate', () => {
    expect(out.summary).toEqual({ count: 3, medianRatio: 1, p90Ratio: 2, withoutEstimate: 1 });
  });

  it('returns nulls for empty input', () => {
    expect(computeEstimateActual([]).summary).toEqual({ count: 0, medianRatio: null, p90Ratio: null, withoutEstimate: 0 });
  });
});

describe('CLI', () => {
  it('reads br list --json shape from a file and prints JSON', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ea-')), 'issues.json');
    fs.writeFileSync(file, JSON.stringify({ issues: [closed('a', 'a (2h)', 4)], total: 1 }));
    expect(parseIssues(fs.readFileSync(file, 'utf8'))).toHaveLength(1);
    const r = spawnSync('node', [path.join(__dirname, '../lib/estimate-actual.js'), '--issues-json', file], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).summary.count).toBe(1);
    expect(spawnSync('node', [path.join(__dirname, '../lib/estimate-actual.js')]).status).toBe(2);
  });
});
