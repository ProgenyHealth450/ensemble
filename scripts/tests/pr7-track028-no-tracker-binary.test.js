'use strict';
/**
 * Regression test for PR7 br-h1jk (TRD-028): the five command YAMLs this task refactored
 * (list-issue, requirement-status, analyze-complexity, onboard, retro) must never regain a
 * literal `br `/`bv ` tracker-binary invocation — all tracker access now goes through
 * `toolchain-cli run tracker.*`/`work-graph.*`. This mirrors the exact AC-1 grep
 * (`grep -nE '\b(br|bv) ' ...`) as a Jest assertion so CI catches a regression, not just a
 * manual grep run at review time.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const COMMANDS_DIR = path.join(REPO_ROOT, 'packages', 'development', 'commands');
const TARGET_FILES = ['list-issue.yaml', 'requirement-status.yaml', 'analyze-complexity.yaml', 'onboard.yaml', 'retro.yaml'];

// Same pattern as the AC-1 grep: a bare `br` or `bv` word followed by a space -- i.e. an
// invocation like `br list` or `bv --robot-triage`, not incidental prose like `br/bv` or
// `(br, bv, ...)`.
const TRACKER_BINARY_INVOCATION = /\b(?:br|bv) /;

function findInvocationLines(contents) {
  return contents
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => TRACKER_BINARY_INVOCATION.test(line));
}

describe('PR7 Track028: no literal br/bv tracker-binary invocation in refactored command YAMLs', () => {
  for (const file of TARGET_FILES) {
    test(`${file} contains zero br/bv invocations`, () => {
      const contents = fs.readFileSync(path.join(COMMANDS_DIR, file), 'utf8');
      const hits = findInvocationLines(contents);
      expect(hits).toEqual([]);
    });
  }

  test('mutation proof: reintroducing a literal br/bv invocation in a /tmp copy is caught', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'track028-mutation-'));
    try {
      const src = path.join(COMMANDS_DIR, 'retro.yaml');
      const copyPath = path.join(tmpDir, 'retro.yaml');
      const original = fs.readFileSync(src, 'utf8');
      fs.writeFileSync(copyPath, original, 'utf8');

      // Sanity: the unmutated copy has no invocations (proves the detector isn't vacuously
      // true before we assert it catches the reintroduced one).
      expect(findInvocationLines(fs.readFileSync(copyPath, 'utf8'))).toEqual([]);

      const mutated = original.replace(
        'node \\"$TOOLCHAIN_CLI\\" run tracker.list --json > a temp file',
        'br list --all --json > a temp file'
      );
      expect(mutated).not.toBe(original);
      fs.writeFileSync(copyPath, mutated, 'utf8');

      const hitsAfterMutation = findInvocationLines(fs.readFileSync(copyPath, 'utf8'));
      expect(hitsAfterMutation.length).toBeGreaterThan(0);
      expect(hitsAfterMutation[0].line).toContain('br list --all --json');

      // Confirm again against the real, unmutated source: still zero.
      expect(findInvocationLines(fs.readFileSync(src, 'utf8'))).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
