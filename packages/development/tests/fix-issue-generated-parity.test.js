/**
 * fix-issue generated parity
 *
 * Every generator renders a workflow step as a heading followed by that step's
 * `description` (scripts/lib/step-keys-check.js rejects any other key), so each
 * generated artifact must carry every source step's whole description, under the
 * right phase and in source order. Regenerate (npm run generate) after editing
 * fix-issue.yaml; this test fails on stale output.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const yaml = require('js-yaml');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SOURCE_PATH = path.join(__dirname, '../commands/fix-issue.yaml');
const GENERATED_FILES = {
  'Claude/OMP markdown': path.join(__dirname, '../commands/ensemble/fix-issue.md'),
  'Pi prompt': path.join(__dirname, '../../pi/prompts/ensemble-fix-issue.md'),
  'Pi skill': path.join(__dirname, '../../pi/skills/ensemble-fix-issue/SKILL.md'),
  'Codex skill': path.join(__dirname, '../../codex/.codex/skills/commands/ensemble-fix-issue/SKILL.md'),
};

const flat = (text) => text.replace(/\s+/g, ' ').trim();

//   OMP markdown / Codex:  "**<n>. <title>**" under "### Phase <n>: <name>"
//   Pi prompt / Pi skill:  "### Step <n>: <title>" under "## Phase <n>: <name>"
const PHASE_HEADING = /^#{2,3} Phase \d+: (.+?)\s*$/;
const STEP_HEADING = /^(?:\*\*\d+\. (.+?)\*\*|### Step \d+: (.+?))\s*$/;

/** Rendered steps of one generated file, in order: { phase, title, text }. */
function renderedSteps(text) {
  const steps = [];
  let phase = null;
  let current = null;
  for (const line of text.split('\n')) {
    const phaseHeading = line.match(PHASE_HEADING);
    const stepHeading = line.match(STEP_HEADING);
    if (phaseHeading) {
      phase = phaseHeading[1];
      current = null;
    } else if (stepHeading) {
      current = { phase, title: stepHeading[1] || stepHeading[2], lines: [] };
      steps.push(current);
    } else if (/^#{1,2} /.test(line)) {
      current = null;
    } else if (current) {
      current.lines.push(line);
    }
  }
  return steps.map((s) => ({ phase: s.phase, title: s.title, text: flat(s.lines.join('\n')) }));
}

describe('fix-issue generated parity', () => {
  let source;
  let sourceSteps;

  beforeAll(() => {
    source = yaml.load(fs.readFileSync(SOURCE_PATH, 'utf-8'));
    sourceSteps = source.workflow.phases.flatMap((phase) =>
      phase.steps.map((step) => ({ phase: phase.name, title: step.title, description: flat(step.description) }))
    );
  });

  test.each(Object.entries(GENERATED_FILES))('%s: carries every source step, in order, with its whole description', (label, file) => {
    const rendered = renderedSteps(fs.readFileSync(file, 'utf-8'));
    expect(rendered.map(({ phase, title }) => ({ phase, title }))).toEqual(
      sourceSteps.map(({ phase, title }) => ({ phase, title }))
    );
    // The Pi generator deliberately maps the Claude tool name AskUserQuestion to Pi's `ask`.
    const forTarget = (text) => (label.startsWith('Pi') ? text.replaceAll('AskUserQuestion', 'ask') : text);
    sourceSteps.forEach((step, i) => {
      expect({ title: step.title, complete: rendered[i].text.includes(forTarget(step.description)) }).toEqual({
        title: step.title,
        complete: true,
      });
    });
  });

  test(
    'generated artifacts validate (read-only; regeneration idempotency is enforced by the CI generate check, never by rewriting tracked output from a unit test)',
    () => {
      execSync('npm run generate:validate && npm run validate', { cwd: REPO_ROOT, stdio: 'pipe' });
    },
    120000
  );
});
