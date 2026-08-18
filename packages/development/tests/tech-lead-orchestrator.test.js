'use strict';

const fs = require('fs');
const path = require('path');

describe('tech-lead-orchestrator quality-loop routing', () => {
  const yamlPath = path.join(__dirname, '../agents/tech-lead-orchestrator.yaml');

  test('Quality Loop Execution includes architect, advisor, and PM state routing', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    const start = text.indexOf('- name: Quality Loop Execution');
    const end = text.indexOf('responsibilities:');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = text.slice(start, end);

    expect(block).toMatch(/in_progress → review → advisory → qa → closed/);
    expect(block).toMatch(/in_progress → in_design/);
    expect(block).toMatch(/in_progress\/in_review\/in_qa → in_clarification/);
    expect(block).toMatch(/closed → in_advisory/);
    expect(block).toMatch(/Architect handles per-task design/);
    expect(block).toMatch(/advisor reviews reviewer-approved work before QA/);
    expect(block).toMatch(/hard cap of 3 clarification rounds per task/);
  });
});
