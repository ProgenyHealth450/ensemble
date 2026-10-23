'use strict';
/**
 * Regression test for PR7 br-ewy9 (TRD-029): the three command YAMLs this task refactored
 * (refine-beads, implement-bead, beads-build-wave) must never regain a literal `br `/`bv `
 * tracker-binary invocation -- all tracker/scheduling access now goes through
 * `toolchain-cli run tracker.*`/`work-graph.*`. This mirrors the exact AC-1 grep
 * (`grep -nE '\b(br|bv) (show|list|update|close|comment|comments|dep|sync|ready)|--robot-' ...`)
 * as a Jest assertion, plus a broader `\b(br|bv) ` sweep (same convention as the TRD-028
 * sibling test), so CI catches a regression, not just a manual grep run at review time.
 *
 * It also asserts beads-build-wave.yaml's end-of-run JSON summary schema line is byte-identical
 * to the pre-refactor contract (AC-2): only the scheduling-source steps/prose changed, never the
 * output field names/shape.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const COMMANDS_DIR = path.join(REPO_ROOT, 'packages', 'development', 'commands');
const TARGET_FILES = ['refine-beads.yaml', 'implement-bead.yaml', 'beads-build-wave.yaml'];

// Same pattern as the AC-1 grep: a bare `br` or `bv` word followed by a space -- i.e. an
// invocation like `br list` or `bv --robot-plan`, not incidental prose like `br/bv` or
// `(br, bv, ...)`.
const TRACKER_BINARY_INVOCATION = /\b(?:br|bv) /;

// The literal AC-1 grep pattern, translated to a JS RegExp (Rust/PCRE2 \b matches the same way
// here for ASCII word chars).
const AC1_PATTERN = /\b(?:br|bv) (?:show|list|update|close|comment|comments|dep|sync|ready)|--robot-/;

const PRE_REFACTOR_REF = '881381c6119176c48d44e0fc91c90d5cec8d02b1';
const WAVE_SCHEMA_LINE_PREFIX = "- 'Schema (one line, valid JSON): {";

function findInvocationLines(contents, pattern) {
  return contents
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => pattern.test(line));
}

function readPreRefactorFile(relPath) {
  return execFileSync('git', ['show', `${PRE_REFACTOR_REF}:${relPath}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  });
}

describe('PR7 Track029: no literal br/bv tracker-binary invocation in refactored command YAMLs', () => {
  for (const file of TARGET_FILES) {
    test(`${file} contains zero br/bv invocations (broad sweep)`, () => {
      const contents = fs.readFileSync(path.join(COMMANDS_DIR, file), 'utf8');
      expect(findInvocationLines(contents, TRACKER_BINARY_INVOCATION)).toEqual([]);
    });

    test(`${file} contains zero matches for the literal AC-1 grep pattern`, () => {
      const contents = fs.readFileSync(path.join(COMMANDS_DIR, file), 'utf8');
      expect(findInvocationLines(contents, AC1_PATTERN)).toEqual([]);
    });
  }

  test('beads-build-wave.yaml JSON summary schema line is byte-identical to the pre-refactor contract', () => {
    const preRefactor = readPreRefactorFile('packages/development/commands/beads-build-wave.yaml');
    const current = fs.readFileSync(path.join(COMMANDS_DIR, 'beads-build-wave.yaml'), 'utf8');

    const preLine = preRefactor
      .split('\n')
      .find((line) => line.trim().startsWith(WAVE_SCHEMA_LINE_PREFIX));
    const currentLine = current
      .split('\n')
      .find((line) => line.trim().startsWith(WAVE_SCHEMA_LINE_PREFIX));

    expect(preLine).toBeTruthy();
    expect(currentLine).toBeTruthy();
    expect(currentLine).toBe(preLine);
  });

  test('mutation proof: reintroducing a literal br/bv invocation in a /tmp copy is caught', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'track029-mutation-'));
    try {
      const src = path.join(COMMANDS_DIR, 'implement-bead.yaml');
      const copyPath = path.join(tmpDir, 'implement-bead.yaml');
      const original = fs.readFileSync(src, 'utf8');
      fs.writeFileSync(copyPath, original, 'utf8');

      // Sanity: the unmutated copy has no invocations (proves the detector isn't vacuously
      // true before we assert it catches the reintroduced one).
      expect(findInvocationLines(fs.readFileSync(copyPath, 'utf8'), TRACKER_BINARY_INVOCATION)).toEqual([]);
      expect(findInvocationLines(fs.readFileSync(copyPath, 'utf8'), AC1_PATTERN)).toEqual([]);

      const needle = 'node "$TOOLCHAIN_CLI" run tracker.show --run-id "$RUN_ID" --arg id=<BEAD_ID> --json';
      expect(original).toContain(needle);
      const mutated = original.replace(needle, 'br show <BEAD_ID> --json');
      expect(mutated).not.toBe(original);
      fs.writeFileSync(copyPath, mutated, 'utf8');

      const mutatedContents = fs.readFileSync(copyPath, 'utf8');
      const hitsBroad = findInvocationLines(mutatedContents, TRACKER_BINARY_INVOCATION);
      const hitsAc1 = findInvocationLines(mutatedContents, AC1_PATTERN);
      expect(hitsBroad.length).toBeGreaterThan(0);
      expect(hitsAc1.length).toBeGreaterThan(0);
      expect(hitsBroad[0].line).toContain('br show <BEAD_ID> --json');

      // Confirm again against the real, unmutated source: still zero.
      expect(findInvocationLines(fs.readFileSync(src, 'utf8'), TRACKER_BINARY_INVOCATION)).toEqual([]);
      expect(findInvocationLines(fs.readFileSync(src, 'utf8'), AC1_PATTERN)).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
