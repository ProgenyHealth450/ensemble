const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const load = (rel) => yaml.load(fs.readFileSync(path.join(__dirname, rel), 'utf8'));

function parsingActions(doc) {
  const preflight = doc.workflow.phases.find((p) => p.name === 'Preflight');
  const step = preflight.steps.find((s) => s.title === 'Argument Parsing');
  return step.actions.join('\n');
}

function stepActions(doc, phaseName, title) {
  const phase = doc.workflow.phases.find((p) => p.name === phaseName);
  return phase.steps.find((s) => s.title === title).actions.join('\n');
}

describe('beads-build argument grammar matches its callers', () => {
  const build = load('../commands/beads-build.yaml');
  const caller = load('../commands/implement-trd-beads.yaml');
  const parsing = parsingActions(build);

  test('accepts the flag form callers pass, plus the free-text form, defaulting to 3', () => {
    expect(parsing).toContain('--max-parallel');
    expect(parsing).toContain('max parallel N');
    expect(parsing).toContain('default MAX_PARALLEL=3');
    expect(parsing).not.toContain('default MAX_PARALLEL=1');
  });

  test('accepts --epic as the epic id source', () => {
    expect(parsing).toMatch(/--epic <value>.*RAW_INPUT=<value>/);
  });

  test('every flag implement-trd-beads passes to beads-build is parsed by beads-build', () => {
    const calls = JSON.stringify(caller).match(/invoke \/ensemble:beads-build with arguments: ([^"]*?)\.? --defer|invoke \/ensemble:beads-build with arguments: ([^"]*)/);
    expect(calls).not.toBeNull();
    const passed = (calls[0].match(/--[a-z-]+/g) || []);
    expect(passed).toEqual(expect.arrayContaining(['--trd', '--max-parallel', '--team-roles', '--label']));
    for (const flag of new Set(passed)) {
      expect(parsing).toContain(flag);
    }
  });

  test('delegation passes --defer-completion and beads-build skips epic closure and checkbox sync on it', () => {
    expect(parsing).toContain('--defer-completion');
    expect(JSON.stringify(caller)).toContain('--label <TRD_LABEL> --defer-completion');
    expect(stepActions(build, 'Completion', 'Epic Closure')).toContain('If DEFER_COMPLETION=true');
    expect(stepActions(build, 'Completion', 'TRD Checkbox Sync')).toContain('If DEFER_COMPLETION=true');
    // The deferral guard must precede the closing command in each step.
    const closure = stepActions(build, 'Completion', 'Epic Closure');
    expect(closure.indexOf('If DEFER_COMPLETION=true')).toBeLessThan(closure.indexOf('br close'));
    const sync = stepActions(build, 'Completion', 'TRD Checkbox Sync');
    expect(sync.indexOf('If DEFER_COMPLETION=true')).toBeLessThan(sync.indexOf('replace "- [ ]'));
  });
});
