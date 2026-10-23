'use strict';
/**
 * Tests for TRD-039-TEST (TRD-2026-8d825f54 "tool-abstraction-layer", PR 9, REQ-015):
 * verifies the TRD-039 refactor (commit 86c545e) of `packages/git/commands/pr-merge.yaml`,
 * `packages/development/commands/fix-issue.yaml` and
 * `packages/development/commands/implement-bead.yaml` away from direct `gh pr`/`az repos`/
 * `git town` invocations onto `host.change-request-*`/`workflow.*` toolchain capabilities.
 *
 * Covers all four TRD-039-TEST acceptance scenarios against the REAL committed files (no
 * fixtures):
 *   1. No host or workflow binary remains -- a word-boundary-safe regex sweep for the literal
 *      invocation shapes `gh pr <sub>`, `az repos <sub>`, `git town <sub>` (the hyphenated
 *      string `git-town`, used as an adapter/skill-directory name, is explicitly NOT a match
 *      and is expected to remain).
 *   2. Merge safety rules unchanged -- the pre-refactor `pr-merge.yaml` is read via
 *      `git show 68f2181:...` (TRD-041, the last commit before TRD-039 rewrote this file) and
 *      its NEVER-merge constraint's invariant conditions (never merge on a
 *      failing/pending required check, never merge with an outstanding CHANGES_REQUESTED
 *      thread) are checked present in both the pre- and post-refactor text; the wording was
 *      deliberately changed to the new capability names, so this is a targeted
 *      substring/anchor check, not a byte-identical diff -- except for the lead sentence
 *      itself, which is asserted byte-identical, since it carries zero capability-name
 *      references and was not touched by the refactor.
 *   3. Capabilities validate -- both the real `validateCapabilityIds`/
 *      `validateCapabilityInvocationDrift` functions `scripts/validate-all.js` exports
 *      (filtered to these three files) and a real `node scripts/validate-all.js` subprocess
 *      are exercised.
 *   4. Command preamble present -- each file's own `metadata.capabilities.required` (parsed
 *      from the SAME YAML, never hand-duplicated) is cross-checked against the `--require`
 *      flags its preflight step actually issues, and every capability that gets an explicit
 *      `confirm-status <id>` gate is checked to call it strictly before that id's first `run
 *      <id>` invocation.
 *
 * Plus a mutation proof (two, in fact) showing the check-1 forbidden-invocation sweep and the
 * check-4 confirm-before-run ordering check both fail on a deliberately broken in-memory
 * scratch copy -- never the real on-disk file -- proving neither passes vacuously.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const yaml = require('js-yaml');

const { validateCapabilityIds, validateCapabilityInvocationDrift } = require('../validate-all');

const REPO_ROOT = path.join(__dirname, '..', '..');
const VALIDATE_ALL_PATH = path.join(REPO_ROOT, 'scripts', 'validate-all.js');

// Commit 68f2181 is TRD-041, the last commit to touch this file before TRD-039 (86c545e)
// rewrote it onto host.* capabilities -- i.e. `86c545e~1` for this path.
const PRE_TRD_039_COMMIT = '68f2181';

const COMMANDS = {
  'pr-merge.yaml': path.join(REPO_ROOT, 'packages', 'git', 'commands', 'pr-merge.yaml'),
  'fix-issue.yaml': path.join(REPO_ROOT, 'packages', 'development', 'commands', 'fix-issue.yaml'),
  'implement-bead.yaml': path.join(
    REPO_ROOT,
    'packages',
    'development',
    'commands',
    'implement-bead.yaml'
  )
};

// Same `path.join('packages', pkg, 'commands', file)` shape `scripts/validate-all.js` uses to
// label its failure messages, so filtering those arrays down to "just these three files" is a
// plain string-prefix match rather than re-deriving the relative path a second way.
const RELATIVE_PATHS = [
  path.join('packages', 'git', 'commands', 'pr-merge.yaml'),
  path.join('packages', 'development', 'commands', 'fix-issue.yaml'),
  path.join('packages', 'development', 'commands', 'implement-bead.yaml')
];

function loadCommand(filePath) {
  const rawText = fs.readFileSync(filePath, 'utf8');
  return { rawText, parsed: yaml.load(rawText) };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-boundary-safe: `\s+` between the two words means the hyphenated adapter/skill-directory
// name `git-town` can never match `git town` (and `git-town` SHOULD still appear in these
// files -- it is a legitimate skill-directory reference, not a forbidden invocation).
const FORBIDDEN_INVOCATIONS = [
  { label: 'gh pr', re: /\bgh\s+pr\b/i },
  { label: 'az repos', re: /\baz\s+repos\b/i },
  { label: 'git town', re: /\bgit\s+town\b/i }
];

function findForbiddenInvocations(text) {
  return FORBIDDEN_INVOCATIONS.filter(({ re }) => re.test(text)).map(({ label }) => label);
}

// Same two literal invocation shapes `scripts/lib/capability-ids-check.js`'s
// `checkCapabilityInvocationDrift` scans for (that module does not export its regexes, hence
// the duplication here, documented rather than silent).
const PREFLIGHT_REQUIRE_ID_RE = /--require\s+(\S+)/g;
const CONFIRM_STATUS_ID_RE = /\bconfirm-status\s+(\S+)/g;

/**
 * For every capability id that gets an explicit `confirm-status <id>` gate somewhere in the
 * body, assert that gate's first occurrence precedes that same id's first real `run <id>`
 * invocation. Case-insensitive on `run` because the three files phrase the actual invocation
 * both as the literal CLI subcommand (`node "$TOOLCHAIN_CLI" run host.change-request-merge`)
 * and as plain English prose (`Run workflow.commit --arg message=...`).
 *
 * @returns {string[]} capability ids where the gate is missing, or does not precede its run
 */
function confirmBeforeRunViolations(rawText) {
  const confirmedIds = new Set();
  for (const m of rawText.matchAll(CONFIRM_STATUS_ID_RE)) confirmedIds.add(m[1]);

  const violations = [];
  for (const id of confirmedIds) {
    const confirmIdx = rawText.indexOf(`confirm-status ${id}`);
    const runRe = new RegExp(`\\brun\\s+${escapeRegExp(id)}\\b`, 'i');
    const runMatch = runRe.exec(rawText);
    if (confirmIdx === -1 || !runMatch || confirmIdx >= runMatch.index) {
      violations.push(id);
    }
  }
  return { confirmedIds, violations };
}

describe('TRD-039-TEST Scenario: No host or workflow binary remains', () => {
  for (const [name, filePath] of Object.entries(COMMANDS)) {
    test(`${name} contains zero "gh pr"/"az repos"/"git town" invocations`, () => {
      const { rawText } = loadCommand(filePath);
      expect(findForbiddenInvocations(rawText)).toEqual([]);
    });
  }

  test('implement-bead.yaml still names the hyphenated "git-town" adapter/skill-directory string (not a forbidden match)', () => {
    const { rawText } = loadCommand(COMMANDS['implement-bead.yaml']);
    expect(rawText).toMatch(/git-town/);
    expect(findForbiddenInvocations(rawText)).toEqual([]);
  });
});

describe('TRD-039-TEST mutation proof: the forbidden-invocation sweep can actually fail', () => {
  test('findForbiddenInvocations flags a reintroduced "gh pr merge" in an in-memory scratch copy, never the real file', () => {
    const { rawText: real } = loadCommand(COMMANDS['pr-merge.yaml']);
    expect(findForbiddenInvocations(real)).toEqual([]); // sanity: the real file is clean

    const mutated = real.replace(
      'Merge: run node "$TOOLCHAIN_CLI" run host.change-request-merge',
      'Merge: run node "$TOOLCHAIN_CLI" run host.change-request-merge # fallback: gh pr merge --squash'
    );
    expect(mutated).not.toEqual(real); // the replace actually matched something
    expect(findForbiddenInvocations(mutated)).toEqual(['gh pr']);

    // The file on disk is untouched -- `mutated` only ever existed as a local string.
    expect(fs.readFileSync(COMMANDS['pr-merge.yaml'], 'utf8')).toEqual(real);
  });
});

describe('TRD-039-TEST Scenario: Merge safety rules unchanged', () => {
  test('the NEVER-merge invariant conditions survive the host.* refactor', () => {
    const preRefactorText = execFileSync(
      'git',
      ['show', `${PRE_TRD_039_COMMIT}:packages/git/commands/pr-merge.yaml`],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
    const preRefactorYaml = yaml.load(preRefactorText);
    const { parsed: postRefactorYaml } = loadCommand(COMMANDS['pr-merge.yaml']);

    const oldRule = preRefactorYaml.constraints.find((c) => c.includes('NEVER merge'));
    const newRule = postRefactorYaml.constraints.find((c) => c.includes('NEVER merge'));
    expect(oldRule).toBeDefined();
    expect(newRule).toBeDefined();

    // Invariant 1: never merge while a required check is failing/pending.
    expect(oldRule).toMatch(/NEVER merge while any required check is failing\/pending/);
    expect(newRule).toMatch(/NEVER merge while any required check is failing\/pending/);

    // Invariant 2: never merge while a review thread has CHANGES_REQUESTED outstanding.
    expect(oldRule).toContain('CHANGES_REQUESTED outstanding');
    expect(newRule).toContain('CHANGES_REQUESTED outstanding');

    // The lead sentence carries both invariants and no capability-specific wording, so it was
    // left byte-identical by the refactor (only the trailing "Merge only when ..." clause,
    // which names the old `gh pr view`/`reviewDecision` vocabulary vs. the new
    // `host.change-request-checks`/`host.change-request-threads` capability ids, was reworded).
    const leadSentence = (rule) => rule.split('Merge only when')[0].trim();
    expect(leadSentence(newRule)).toEqual(leadSentence(oldRule));

    // The reworded clause still expresses the same semantic guarantee under the new names.
    expect(oldRule).toContain('every required check SUCCESS');
    expect(oldRule).toContain('reviewDecision is APPROVED');
    expect(newRule).toContain('host.change-request-checks reports every required check SUCCESS');
    expect(newRule).toContain('no outstanding CHANGES_REQUESTED thread');
  });
});

describe('TRD-039-TEST Scenario: Capabilities validate', () => {
  test('validateCapabilityIds() reports zero errors for these three files', () => {
    const failures = validateCapabilityIds();
    const relevant = failures.filter((msg) => RELATIVE_PATHS.some((p) => msg.startsWith(`${p}:`)));
    expect(relevant).toEqual([]);
  });

  test('validateCapabilityInvocationDrift() reports zero errors for these three files', () => {
    const failures = validateCapabilityInvocationDrift();
    const relevant = failures.filter((msg) => RELATIVE_PATHS.some((p) => msg.startsWith(`${p}:`)));
    expect(relevant).toEqual([]);
  });

  test(
    'real `node scripts/validate-all.js` subprocess exits 0 and reports the command-capability checks ran',
    () => {
      const proc = spawnSync(process.execPath, [VALIDATE_ALL_PATH], {
        cwd: REPO_ROOT,
        encoding: 'utf8'
      });
      expect(proc.status).toBe(0);
      expect(proc.stdout).toMatch(/command YAML file\(s\) checked for valid capability ids/);
      expect(proc.stdout).toMatch(
        /command YAML file\(s\) checked for capability declaration\/invocation drift/
      );
      expect(proc.stdout).not.toMatch(/pr-merge\.yaml.*unknown capability/i);
      expect(proc.stdout).not.toMatch(/fix-issue\.yaml.*unknown capability/i);
      expect(proc.stdout).not.toMatch(/implement-bead\.yaml.*unknown capability/i);
    },
    60000
  );
});

describe('TRD-039-TEST Scenario: Command preamble present', () => {
  for (const [name, filePath] of Object.entries(COMMANDS)) {
    test(`${name} opens with a preflight listing exactly its required capabilities`, () => {
      const { rawText, parsed } = loadCommand(filePath);
      const required = (parsed.metadata.capabilities.required || []).slice().sort();
      expect(required.length).toBeGreaterThan(0);

      expect(rawText.toLowerCase()).toContain('toolchain-cli');
      expect(rawText.toLowerCase()).toContain('preflight');

      const preflightIds = new Set();
      for (const m of rawText.matchAll(PREFLIGHT_REQUIRE_ID_RE)) preflightIds.add(m[1]);
      expect([...preflightIds].sort()).toEqual(required);
    });

    test(`${name} calls confirm-status before the first run invocation of each capability it gates`, () => {
      const { rawText } = loadCommand(filePath);
      const { confirmedIds, violations } = confirmBeforeRunViolations(rawText);
      expect(confirmedIds.size).toBeGreaterThan(0); // at least one confirm-status gate exists
      expect(violations).toEqual([]);
    });
  }
});

describe('TRD-039-TEST mutation proof: the confirm-before-run ordering check can actually fail', () => {
  test('confirmBeforeRunViolations flags a capability whose confirm-status gate comes AFTER its run invocation', () => {
    const correctOrder = 'confirm-status host.change-request-merge --run-id X\nrun host.change-request-merge --run-id X\n';
    expect(confirmBeforeRunViolations(correctOrder).violations).toEqual([]);

    const reversedOrder = 'run host.change-request-merge --run-id X\nconfirm-status host.change-request-merge --run-id X\n';
    expect(confirmBeforeRunViolations(reversedOrder).violations).toEqual(['host.change-request-merge']);

    const missingGate = 'run host.change-request-merge --run-id X\n';
    expect(confirmBeforeRunViolations(missingGate).confirmedIds.size).toBe(0);
  });
});
