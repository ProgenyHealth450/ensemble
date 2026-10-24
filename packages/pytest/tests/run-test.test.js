'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Regression test for packages/pytest/skills/run-test.py's pytest-json-report integration
 * (TRD-2026-8d825f54 TRD-043). run-test.py previously hardcoded `passed: 0, failed: 0,
 * total: 0` and never parsed pytest's own `--json-report` output; this test genuinely spawns
 * `pytest` against a real 2-pass/1-fail fixture (it does not mock pytest's JSON) and asserts
 * the normalized result is truthful.
 *
 * Requires `pytest` and `pytest-json-report` to be installed and `pytest` resolvable on PATH
 * for whatever `python3` this test's `execFileSync('python3', ...)` call resolves to --
 * see packages/pytest/requirements-test.txt for the install command. If `pytest` is not on
 * PATH, this test fails (by design: run-test.py's own `cmd = ["pytest", ...]` has the exact
 * same requirement in production, so a passing test here is only meaningful when that
 * requirement is actually met).
 */

const RUN_TEST_SCRIPT = path.join(__dirname, '..', 'skills', 'run-test.py');

describe('run-test.py pytest-json-report integration', () => {
  test('reports truthful passed/failed/total/success for a 2-pass/1-fail fixture', () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pytest-run-test-fixture-'));
    const fixtureFile = path.join(fixtureDir, 'test_sample.py');
    fs.writeFileSync(
      fixtureFile,
      [
        'def test_pass_one():',
        '    assert 1 + 1 == 2',
        '',
        'def test_pass_two():',
        '    assert "a" + "b" == "ab"',
        '',
        'def test_fail_one():',
        '    assert 1 == 2',
        ''
      ].join('\n')
    );

    let stdout;
    try {
      stdout = execFileSync('python3', [RUN_TEST_SCRIPT, `--file=${fixtureFile}`], {
        encoding: 'utf8',
        cwd: fixtureDir
      });
    } catch (error) {
      // run-test.py exits 1 when the suite it ran has failures (by design, matching every
      // sibling language runner's own exit-on-failure convention) -- the real JSON report is
      // still on stdout.
      stdout = error.stdout;
    }

    expect(stdout).toBeTruthy();
    const result = JSON.parse(stdout);

    expect(result.success).toBe(false);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.total).toBe(3);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].nodeid).toContain('test_fail_one');
    expect(result.failures[0].outcome).toBe('failed');
  });
});
