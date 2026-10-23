'use strict';
/**
 * Regression test for PR7 br-96hk (TRD-030): `packages/development/commands/beads-build.yaml`
 * and the skill `packages/development/skills/implement-trd-beads-reference/SKILL.md` must never
 * regain a literal `br `/`bv ` tracker-binary invocation or `--robot-` flag -- all tracker/
 * scheduling access now goes through `toolchain-cli run tracker.*`/`work-graph.*`. This mirrors
 * the exact AC-1 grep (`grep -noE '\bbr\b|\bbv\b|--robot-[a-z]+' <file>`) as a Jest assertion,
 * plus a broader `\b(br|bv) ` invocation sweep (same convention as the TRD-028/TRD-029 sibling
 * tests), so CI catches a regression, not just a manual grep run at review time.
 *
 * One documented exception: SKILL.md section 5's `--reset-task` recovery step keeps a single
 * literal `br update <id> --status=open` because the tracker category's `tracker.update`
 * capability is declared (packages/development/skills/adapter-tracker-beads/adapter.yaml) to
 * map its one `fields` input to `--notes` only -- it has no status-set operation, so there is no
 * capability id to call instead (and the instructions governing this refactor forbid inventing
 * one). This test asserts that line is the ONLY remaining `br`/`bv` token in SKILL.md.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const COMMAND_PATH = path.join(REPO_ROOT, 'packages', 'development', 'commands', 'beads-build.yaml');
const SKILL_PATH = path.join(
  REPO_ROOT,
  'packages',
  'development',
  'skills',
  'implement-trd-beads-reference',
  'SKILL.md'
);

// Same pattern as the AC-1 grep: a bare `br` or `bv` word followed by a space -- i.e. an
// invocation like `br list` or `bv --robot-plan`, not incidental prose like `br/bv`.
const TRACKER_BINARY_INVOCATION = /\b(?:br|bv) /;

// The literal AC-1 grep pattern (`\bbr\b|\bbv\b|--robot-[a-z]+`), translated to a JS RegExp.
const AC1_PATTERN = /\bbr\b|\bbv\b|--robot-[a-z]+/;

// The one documented, intentionally-kept literal line in SKILL.md (see file header comment).
const DOCUMENTED_GAP_NEEDLE = 'br update <id> --status=open';

function findMatchLines(contents, pattern) {
  return contents
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => pattern.test(line));
}

describe('PR7 Track030: no literal br/bv tracker-binary invocation in beads-build.yaml or its reference skill', () => {
  test('beads-build.yaml contains zero br/bv invocations (broad sweep)', () => {
    const contents = fs.readFileSync(COMMAND_PATH, 'utf8');
    expect(findMatchLines(contents, TRACKER_BINARY_INVOCATION)).toEqual([]);
  });

  test('beads-build.yaml contains zero matches for the literal AC-1 grep pattern', () => {
    const contents = fs.readFileSync(COMMAND_PATH, 'utf8');
    expect(findMatchLines(contents, AC1_PATTERN)).toEqual([]);
  });

  test('SKILL.md contains no br/bv token other than the one documented tracker.update gap', () => {
    const contents = fs.readFileSync(SKILL_PATH, 'utf8');
    const hits = findMatchLines(contents, AC1_PATTERN);
    expect(hits.length).toBe(1);
    expect(hits[0].line).toContain(DOCUMENTED_GAP_NEEDLE);
  });

  test('mutation proof: reintroducing a literal br/bv invocation in a /tmp copy of beads-build.yaml is caught', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'track030-mutation-'));
    try {
      const copyPath = path.join(tmpDir, 'beads-build.yaml');
      const original = fs.readFileSync(COMMAND_PATH, 'utf8');
      fs.writeFileSync(copyPath, original, 'utf8');

      // Sanity: the unmutated copy has no invocations (proves the detector isn't vacuously
      // true before we assert it catches the reintroduced one).
      expect(findMatchLines(fs.readFileSync(copyPath, 'utf8'), TRACKER_BINARY_INVOCATION)).toEqual([]);
      expect(findMatchLines(fs.readFileSync(copyPath, 'utf8'), AC1_PATTERN)).toEqual([]);

      const needle = 'node "$TOOLCHAIN_CLI" run tracker.sync --run-id "$RUN_ID" $NON_INTERACTIVE_ARGS --json';
      expect(original).toContain(needle);
      const mutated = original.replace(needle, 'br sync --flush-only');
      expect(mutated).not.toBe(original);
      fs.writeFileSync(copyPath, mutated, 'utf8');

      const mutatedContents = fs.readFileSync(copyPath, 'utf8');
      const hitsBroad = findMatchLines(mutatedContents, TRACKER_BINARY_INVOCATION);
      const hitsAc1 = findMatchLines(mutatedContents, AC1_PATTERN);
      expect(hitsBroad.length).toBeGreaterThan(0);
      expect(hitsAc1.length).toBeGreaterThan(0);
      expect(hitsBroad[0].line).toContain('br sync --flush-only');

      // Confirm again against the real, unmutated source: still zero.
      expect(findMatchLines(fs.readFileSync(COMMAND_PATH, 'utf8'), TRACKER_BINARY_INVOCATION)).toEqual([]);
      expect(findMatchLines(fs.readFileSync(COMMAND_PATH, 'utf8'), AC1_PATTERN)).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('beads-build.yaml declares the exact TRD-030 capabilities block', () => {
    const contents = fs.readFileSync(COMMAND_PATH, 'utf8');
    const required = ['tracker.show', 'tracker.list', 'tracker.sync', 'tracker.comment', 'tracker.close', 'work-graph.ready'];
    for (const id of required) {
      expect(contents).toContain(`      - ${id}\n`);
    }
    expect(contents).toMatch(/optional:\s*\n\s*- work-graph\.plan/);
  });

  test('Plan Mode path prints the ordering source from data.orderingSource (AC-2)', () => {
    const contents = fs.readFileSync(COMMAND_PATH, 'utf8');
    expect(contents).toContain('ORDERING_SOURCE=data.orderingSource');
    expect(contents).toContain('ordering source: <ORDERING_SOURCE>');
  });
});
