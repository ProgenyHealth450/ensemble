'use strict';

const fs = require('fs');
const path = require('path');

describe('validate-git-town.sh remediation text (TRD-005)', () => {
  const scriptPath = path.join(
    __dirname,
    '..',
    'skills',
    'git-town',
    'scripts',
    'validate-git-town.sh'
  );
  const contents = fs.readFileSync(scriptPath, 'utf8');

  test('no longer references the nonexistent "git town config setup" command', () => {
    expect(contents).not.toContain('git town config setup');
  });
});
