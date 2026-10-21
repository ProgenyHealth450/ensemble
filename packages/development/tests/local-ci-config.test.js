'use strict';

const fs = require('fs');
const path = require('path');
const { validateConfig } = require('../lib/local-ci-config');

const REPO_CONFIG = path.resolve(__dirname, '../../../.ensemble/local-ci.yaml');
const repoYaml = () => fs.readFileSync(REPO_CONFIG, 'utf8');

const base = () => ({
  workflows: [{ file: 'a.yml', jobs: [{ id: 'build' }] }],
  steps: [{ name: 'test', cmd: 'npm test' }],
  status_context: 'x/local-ci',
  app_id: 123,
});

describe('validateConfig', () => {
  test('required checks are the approval set (Ensemble config)', () => {
    const r = validateConfig(repoYaml());
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    const ids = r.approvalSet.checks.map((c) => [c.job, c.matrix['node-version']]);
    expect(ids).toEqual([['validate', undefined], ['test', 22], ['test', 24]]);
    expect(r.approvalSet.statusContext).toBe('ensemble/local-ci');
    expect(r.approvalSet.appId).toMatch(/^REPLACE_/);
  });

  test('excluded job is recorded in the normalized set with its reason', () => {
    const withExclusion = repoYaml().replace(
      'excluded: []',
      'excluded:\n  - workflow: .github/workflows/test.yml\n    job: nightly\n    reason: external service',
    );
    expect(withExclusion).not.toBe(repoYaml());
    const r = validateConfig(withExclusion);
    expect(r.ok).toBe(true);
    expect(r.approvalSet.excluded).toEqual([
      { workflow: '.github/workflows/test.yml', job: 'nightly', reason: 'external service' },
    ]);
  });

  test("this repository's own approval set excludes no whole job", () => {
    expect(validateConfig(repoYaml()).approvalSet.excluded).toEqual([]);
  });

  test('edit changes behavior: removing a workflow shrinks the set', () => {
    const full = validateConfig(repoYaml());
    const edited = repoYaml().replace(/  - file: \.github\/workflows\/test\.yml[\s\S]*?(?=\n# Whole jobs)/, '');
    const r = validateConfig(edited);
    expect(r.ok).toBe(true);
    expect(r.approvalSet.checks.length).toBeLessThan(full.approvalSet.checks.length);
    expect(r.approvalSet.checks.map((c) => c.job)).toEqual(['validate']);
  });

  test('per-repo isolation: each config contains only its own workflows', () => {
    const a = validateConfig(base());
    const b = validateConfig({ ...base(), workflows: [{ file: 'b.yml', jobs: [{ id: 'lint' }] }] });
    expect(a.approvalSet.workflows.map((w) => w.file)).toEqual(['a.yml']);
    expect(b.approvalSet.workflows.map((w) => w.file)).toEqual(['b.yml']);
    expect(JSON.stringify(a)).not.toMatch(/b\.yml|lint/);
    expect(JSON.stringify(b)).not.toMatch(/a\.yml|build/);
  });

  test.each([undefined, null, '', '   ', '# only a comment\n'])('missing config %j stops with no defaults', (src) => {
    const r = validateConfig(src);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/missing/);
    expect(r.problems[0]).toMatch(/local-ci\.yaml/);
    expect(r.approvalSet).toBeUndefined();
  });

  test('no bot reviewers: bot handling skipped, config valid', () => {
    const r = validateConfig(base());
    expect(r.ok).toBe(true);
    expect(r.approvalSet.botReview).toEqual({ skipped: true, logins: [] });
    expect(validateConfig({ ...base(), bot_reviewers: [] }).approvalSet.botReview.skipped).toBe(true);
  });

  test('configured bot reviewers are not skipped', () => {
    const r = validateConfig({ ...base(), bot_reviewers: ['coderabbitai[bot]'] });
    expect(r.approvalSet.botReview).toEqual({ skipped: false, logins: ['coderabbitai[bot]'] });
  });

  test('unknown key is named', () => {
    const r = validateConfig({ ...base(), extra: 1 });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/unknown key "extra"/);
  });

  test('each missing required key is named', () => {
    const r = validateConfig({});
    expect(r.ok).toBe(false);
    for (const k of ['workflows', 'steps', 'status_context', 'app_id']) {
      expect(r.problems.join('\n')).toContain(`missing required key "${k}"`);
    }
  });

  test('job both included and excluded is a problem', () => {
    const r = validateConfig({ ...base(), excluded: [{ workflow: 'a.yml', job: 'build', reason: 'r' }] });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/"build" in a\.yml is both included and excluded/);
  });

  test('all problems are reported together', () => {
    const r = validateConfig({ workflows: [{ file: 'a.yml', jobs: [{ id: 'b', bogus: 1 }] }], nope: 1 });
    expect(r.problems.length).toBeGreaterThanOrEqual(4);
  });

  test('excluded entry without reason is a problem', () => {
    const r = validateConfig({ ...base(), excluded: [{ workflow: 'a.yml', job: 'c' }] });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/excluded\[0\]: missing required key "reason"/);
  });

  test.each([
    ['app_id zero', { app_id: 0 }],
    ['app_id object', { app_id: {} }],
    ['workflows string', { workflows: 'a.yml' }],
    ['empty workflows', { workflows: [] }],
    ['bad matrix', { workflows: [{ file: 'a.yml', jobs: [{ id: 'x', matrix: { n: [] } }] }] }],
    ['bad bots', { bot_reviewers: 'bot' }],
    ['blank status', { status_context: ' ' }],
  ])('malformed value fails closed: %s', (_n, patch) => {
    const r = validateConfig({ ...base(), ...patch });
    expect(r.ok).toBe(false);
    expect(r.approvalSet).toBeUndefined();
  });

  test('steps, equivalents and excluded_steps are normalized', () => {
    const r = validateConfig({
      ...base(),
      steps: [{ name: 'lint', cmd: 'npm run lint' }],
      equivalents: [{ workflowStep: 'Check docs', runs: 'lint' }],
      excluded_steps: [{ workflow: 'a.yml', job: 'build', step: 'Upload', reason: 'external service' }],
    });
    expect(r.problems).toEqual([]);
    expect(r.approvalSet.steps).toEqual([{ name: 'lint', cmd: 'npm run lint' }]);
    expect(r.approvalSet.equivalents).toEqual([{ workflowStep: 'Check docs', runs: 'lint' }]);
    expect(r.approvalSet.excludedSteps).toEqual([
      { workflow: 'a.yml', job: 'build', step: 'Upload', reason: 'external service' },
    ]);
  });

  test('the optional lists default to empty, never to another repository\'s entries; the command list is required', () => {
    const r = validateConfig(base());
    expect(r.approvalSet.steps).toEqual([{ name: 'test', cmd: 'npm test' }]);
    expect(r.approvalSet.equivalents).toEqual([]);
    expect(r.approvalSet.excludedSteps).toEqual([]);
  });

  test.each([
    ['step without a command', { steps: [{ name: 'lint' }] }],
    ['step with a blank command', { steps: [{ name: 'lint', cmd: '  ' }] }],
    ['steps not a list', { steps: { name: 'lint', cmd: 'x' } }],
    ['empty steps', { steps: [] }],
    ['duplicate step names', { steps: [{ name: 'a', cmd: 'x' }, { name: 'a', cmd: 'y' }] }],
    ['the retired extra_steps key', { extra_steps: [{ name: 'lint', cmd: 'x' }] }],
    ['equivalent missing its target', { equivalents: [{ workflowStep: 'a' }] }],
    ['excluded step without a reason', { excluded_steps: [{ workflow: 'a.yml', job: 'build', step: 'Upload' }] }],
    ['unknown key inside an excluded step', { excluded_steps: [{ workflow: 'a.yml', job: 'b', step: 's', reason: 'r', why: 'x' }] }],
  ])('malformed step config fails closed: %s', (_n, patch) => {
    const r = validateConfig({ ...base(), ...patch });
    expect(r.ok).toBe(false);
    expect(r.approvalSet).toBeUndefined();
  });

  describe('duplicate entries are rejected', () => {
    const wf = (file, jobs) => ({ file, jobs });
    test('the same workflow file listed twice', () => {
      const r = validateConfig({ ...base(), workflows: [wf('a.yml', [{ id: 'build' }]), wf('a.yml', [{ id: 'lint' }])] });
      expect(r.ok).toBe(false);
      expect(r.problems.join('\n')).toMatch(/duplicate workflow file "a\.yml"/);
    });

    test('the same job id with the same matrix in one workflow, whatever the matrix key order', () => {
      const r = validateConfig({
        ...base(),
        workflows: [wf('a.yml', [{ id: 'test', matrix: { node: [22], os: ['x'] } }, { id: 'test', matrix: { os: ['x'], node: [22] } }])],
      });
      expect(r.ok).toBe(false);
      expect(r.problems.join('\n')).toMatch(/duplicate job "test"/);
    });

    test('the same job id with a different matrix, or in another workflow, is allowed', () => {
      const r = validateConfig({
        ...base(),
        workflows: [wf('a.yml', [{ id: 'test', matrix: { node: [22] } }, { id: 'test', matrix: { node: [24] } }]), wf('b.yml', [{ id: 'test', matrix: { node: [22] } }])],
      });
      expect(r.problems).toEqual([]);
    });
  });

  test("this repository's trusted list parses, is non-empty and every command is a non-blank string", () => {
    const { steps } = validateConfig(repoYaml()).approvalSet;
    expect(steps.length).toBeGreaterThanOrEqual(6);
    expect(new Set(steps.map((s) => s.name)).size).toBe(steps.length);
    for (const s of steps) expect(s.cmd.trim()).not.toBe('');
  });

  test('invalid YAML and non-mapping fail closed', () => {
    expect(validateConfig('a: [').ok).toBe(false);
    expect(validateConfig('- 1\n- 2').ok).toBe(false);
    expect(validateConfig(42).ok).toBe(false);
  });
});
