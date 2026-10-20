'use strict';

/**
 * Behavioral tests for the trd-cli requirement-check subcommands
 * (validate, analyze, req-status, verify) against fixture TRDs.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { runValidate, runAnalyze, runReqStatus, runVerify } = require('../lib/trd-cli');

const CLI = path.join(__dirname, '..', 'lib', 'trd-cli.js');
const FX = path.join(__dirname, 'fixtures', 'trd-checks');
const fx = (name) => path.join(FX, name);
const codes = (list) => list.map((e) => e.code);

describe('validate', () => {
  test('valid TRD + PRD passes with no errors or warnings', () => {
    const r = runValidate([fx('valid.md'), '--prd', fx('valid-prd.md')]);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.stats).toMatchObject({ tasks: 4, implTasks: 2, testTasks: 2, prdRequirements: 2 });
    expect(r.skipped).toEqual([]);
  });

  test('without a PRD the PRD-dependent checks are skipped, not passed', () => {
    const r = runValidate([fx('valid.md')]);
    expect(r.ok).toBe(true);
    expect(r.skipped).toEqual(['orphaned_satisfies', 'requirement_coverage', 'ac_references']);
  });

  test('dependency cycle is an error naming the cycle', () => {
    const r = runValidate([fx('cyclic.md')]);
    expect(r.ok).toBe(false);
    expect(codes(r.errors)).toEqual(['DEPENDENCY_CYCLE']);
    expect(new Set(r.errors[0].cycle)).toEqual(new Set(['TRD-001', 'TRD-002', 'TRD-003']));
    expect(r.errors[0].cycle[0]).toBe(r.errors[0].cycle[r.errors[0].cycle.length - 1]);
  });

  test('missing Master Task List section; heading-style ids are not tasks', () => {
    const r = runValidate([fx('missing-section.md')]);
    expect(r.ok).toBe(false);
    expect(codes(r.errors)).toEqual(['MISSING_MASTER_TASK_LIST', 'NO_TASKS']);
    expect(r.stats.tasks).toBe(0);
  });

  test('unresolved dependency errors; cross-TRD refs are tolerated and counted', () => {
    const r = runValidate([fx('unresolved-dep.md')]);
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ code: 'UNRESOLVED_DEPENDENCY', task: 'TRD-001', dep: 'TRD-099' });
    expect(r.stats.externalDependencies).toBe(1);
  });

  test('traceability: orphaned satisfies is an error; uncovered req, bad AC, missing test pair are warnings', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trd-checks-'));
    const trd = path.join(tmp, 'trace.md');
    fs.writeFileSync(
      trd,
      [
        '# TRD: Trace',
        '',
        '## Master Task List',
        '',
        '### Phase 1: X',
        '',
        '- [ ] **TRD-001**: Impl (1h) [satisfies REQ-009]',
        '  - Implementation AC:',
        '    - [ ] a',
        '- [ ] **TRD-002**: Impl2 (1h) [satisfies REQ-001]',
        '  - Implementation AC:',
        '    - [ ] a',
        '- [ ] **TRD-002-TEST**: T (1h) [verifies TRD-002]',
        '  - Test AC:',
        '    - [ ] a',
        '    - Validates PRD ACs: AC-777-1',
        '',
      ].join('\n')
    );
    const r = runValidate([trd, '--prd', fx('valid-prd.md')]);
    expect(r.ok).toBe(false);
    expect(codes(r.errors)).toEqual(['ORPHANED_SATISFIES']);
    expect(r.errors[0]).toMatchObject({ task: 'TRD-001', req: 'REQ-009' });
    expect(codes(r.warnings).sort()).toEqual(
      ['INVALID_AC_REFERENCE', 'MISSING_TEST_PAIR', 'UNCOVERED_REQUIREMENT'].sort()
    );
    expect(r.warnings.find((w) => w.code === 'UNCOVERED_REQUIREMENT').req).toBe('REQ-002');
    expect(r.warnings.find((w) => w.code === 'MISSING_TEST_PAIR').task).toBe('TRD-001');
  });

  test('explicit --prd that does not exist is an error', () => {
    expect(() => runValidate([fx('valid.md'), '--prd', fx('nope.md')])).toThrow(/PRD file not found/);
  });
});

describe('analyze', () => {
  test('valid fixture: phases, depth, estimates, verdict READY', () => {
    const r = runAnalyze([fx('valid.md'), '--prd', fx('valid-prd.md')]);
    expect(r.verdict).toBe('READY');
    expect(r.phases.map((p) => [p.n, p.tasks, p.hours])).toEqual([[1, 2, 3], [2, 2, 1]]);
    expect(r.dependencies.maxDepth).toBe(3);
    expect(r.dependencies.criticalPathEnd).toBe('TRD-002-TEST');
    expect(r.estimates).toEqual({ totalHours: 4, missing: ['TRD-002'] });
    expect(r.traceability.uncoveredRequirements).toEqual([]);
    expect(r.prd).toMatchObject({ requirements: 2, acceptanceCriteria: 2, hasNonGoals: true, hasConstraints: true });
  });

  test('cycle yields NOT READY and reports cycles with null depth ignored', () => {
    const r = runAnalyze([fx('cyclic.md')]);
    expect(r.verdict).toBe('NOT READY');
    expect(r.dependencies.cycles).toHaveLength(1);
    expect(r.dependencies.maxDepth).toBe(0);
  });

  test('missing estimates and untraced impl tasks are listed', () => {
    const r = runAnalyze([fx('unresolved-dep.md')]);
    expect(r.estimates.missing).toEqual([]);
    expect(r.traceability.implTasksWithoutSatisfies).toEqual(['TRD-001', 'TRD-002']);
    const valid = runAnalyze([fx('valid.md')]);
    expect(valid.traceability.implTasksWithoutSatisfies).toEqual([]);
  });
});

describe('req-status', () => {
  test('checkbox rollup by phase and requirement status from checkboxes', () => {
    const r = runReqStatus([fx('valid.md'), '--prd', fx('valid-prd.md')]);
    expect(r.checklist).toMatchObject({ total: 4, done: 2, pct: 50 });
    expect(r.checklist.phases.map((p) => [p.n, p.done, p.total, p.pct])).toEqual([[1, 2, 2, 100], [2, 0, 2, 0]]);
    const byReq = Object.fromEntries(r.requirements.map((q) => [q.req, q.status]));
    expect(byReq).toEqual({ 'REQ-001': 'SATISFIED', 'REQ-002': 'PENDING' });
    expect(r.summary).toEqual({ SATISFIED: 1, IN_PROGRESS: 0, PENDING: 1, NOT_PLANNED: 0 });
  });

  test('bead statuses override checkboxes; --verified gates SATISFIED; both br list shapes accepted', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trd-checks-'));
    const issues = [
      { id: 'a', title: '[trd:valid:task:TRD-001-TEST] t', status: 'closed' },
      { id: 'b', title: '[trd:valid:task:TRD-002-TEST] t', status: 'in_progress' },
      { id: 'c', title: '[trd:other:task:TRD-002-TEST] t', status: 'closed' },
    ];
    for (const [name, payload] of [['bare.json', issues], ['wrapped.json', { issues, total: 3 }]]) {
      const file = path.join(tmp, name);
      fs.writeFileSync(file, JSON.stringify(payload));
      const r = runReqStatus([fx('valid.md'), '--prd', fx('valid-prd.md'), '--issues-json', file, '--verified', 'REQ-001']);
      const byReq = Object.fromEntries(r.requirements.map((q) => [q.req, q.status]));
      expect(byReq).toEqual({ 'REQ-001': 'SATISFIED', 'REQ-002': 'IN_PROGRESS' });
    }
    const file = path.join(tmp, 'bare.json');
    const unverified = runReqStatus([fx('valid.md'), '--prd', fx('valid-prd.md'), '--issues-json', file, '--verified', '']);
    const req1 = unverified.requirements.find((q) => q.req === 'REQ-001');
    expect(req1.status).toBe('IN_PROGRESS');
    expect(req1.note).toMatch(/no req-verified token/);
  });

  test('requirement with no test task is NOT_PLANNED', () => {
    const r = runReqStatus([fx('unresolved-dep.md')]);
    expect(r.requirements).toEqual([]);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trd-checks-'));
    const trd = path.join(tmp, 'np.md');
    fs.writeFileSync(trd, '# T\n\n## Master Task List\n\n### Phase 1: X\n\n- [ ] **TRD-001**: Impl (1h) [satisfies REQ-001]\n');
    expect(runReqStatus([trd]).requirements[0].status).toBe('NOT_PLANNED');
  });
});

describe('verify', () => {
  test('checkbox mode builds the chain from the TRD and writes a report on request', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trd-checks-'));
    const report = path.join(tmp, 'out', 'report.md');
    const r = runVerify([fx('valid.md'), '--prd', fx('valid-prd.md'), '--report-path', report]);
    expect(r.ok).toBe(true);
    expect(r.chain.map((c) => c.req_id)).toEqual(['REQ-001', 'REQ-002']);
    const req1 = r.chain.find((c) => c.req_id === 'REQ-001');
    expect(req1.primary_impl_task_id).toBe('TRD-001');
    expect(req1.primary_test_task_id).toBe('TRD-001-TEST');
    // Complete impl but tests were not run (no --run-tests): partial, never verified.
    expect(req1.verdict).toBe('partial');
    expect(r.chain.find((c) => c.req_id === 'REQ-002').verdict).toBe('in_progress');
    expect(r.verdict).toBe('PARTIAL');
    expect(fs.readFileSync(report, 'utf8')).toContain('| REQ-001 |');
  });

  test('invalid mode and TRD without tasks are errors', () => {
    expect(() => runVerify([fx('valid.md'), '--mode', 'bogus'])).toThrow(/Invalid --mode/);
    expect(() => runVerify([fx('missing-section.md')])).toThrow(/no tasks found/);
    expect(() => runVerify([fx('valid.md'), '--mode', 'beads'])).toThrow(/requires --beads-evidence/);
  });
});

describe('executable', () => {
  test.each(['validate', 'analyze', 'req-status'])('%s prints one JSON object and exits 0', (sub) => {
    const res = spawnSync('node', [CLI, sub, fx('valid.md')], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(() => JSON.parse(res.stdout)).not.toThrow();
  });

  test('missing file reports {error} and exits 1', () => {
    const res = spawnSync('node', [CLI, 'validate', fx('absent.md')], { encoding: 'utf8' });
    expect(res.status).toBe(1);
    expect(JSON.parse(res.stdout).error).toMatch(/Cannot read TRD file/);
  });
});
