'use strict';

const yaml = require('js-yaml');
const { checkStepKeys } = require('../lib/step-keys-check');
const { RENDERED_STEP_KEYS, transformCommandToMarkdown } = require('../lib/command-transformer');
const { validateStepKeys } = require('../validate-all');

const parse = (text) => yaml.load(text);

describe('checkStepKeys', () => {
  const cmd = (stepBody) => parse(`
metadata: { name: ensemble:x, description: d }
workflow:
  phases:
    - name: Build
      order: 2
      steps:
        - order: 3
${stepBody}
`);

  test('rejects unrendered keys, naming file, phase, step and key', () => {
    const failures = checkStepKeys(cmd('          title: T\n          instructions: do it\n          tool: Bash'), 'x.yaml');
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatch(/x\.yaml: phase 2 \("Build"\) step 3: key 'instructions'/);
    expect(failures[1]).toContain("key 'tool'");
  });

  test('accepts every rendered key', () => {
    const step = '          title: T\n          description: D\n          actions: [a]\n          delegation: { agent: a, context: c }\n          mcp_tool: m';
    expect(checkStepKeys(cmd(step), 'x.yaml')).toEqual([]);
  });

  test('every key the gate allows is actually rendered by the transformer', () => {
    const step = {
      order: 1, title: 'TITLE_X', description: 'DESC_X', actions: ['ACTION_X'],
      delegation: { agent: 'AGENT_X', context: 'CTX_X' }, mcp_tool: { name: 'MCP_X' }
    };
    expect(Object.keys(step).sort()).toEqual([...RENDERED_STEP_KEYS].sort());
    const md = transformCommandToMarkdown({
      metadata: { name: 'ensemble:x', description: 'd' },
      workflow: { phases: [{ name: 'P', order: 1, steps: [step] }] }
    }, 'x.yaml', new Map());
    for (const marker of ['TITLE_X', 'DESC_X', 'ACTION_X', 'AGENT_X', 'CTX_X', 'MCP_X']) {
      expect(md).toContain(marker);
    }
  });

  test('ignores commands without workflow', () => {
    expect(checkStepKeys({ metadata: {} }, 'x.yaml')).toEqual([]);
  });
});

describe('real command YAML', () => {
  test('no step carries an unrendered key', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(validateStepKeys()).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
