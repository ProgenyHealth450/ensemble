'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  runDocMaintenance,
  USER_GUIDE_TEMPLATE,
} = require('../lib/doc-maintenance');

describe('runDocMaintenance', () => {
  let repoRoot;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-maintenance-'));
    fs.writeFileSync(path.join(repoRoot, 'README.md'), '# README\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
  });

  afterEach(() => {
    delete process.env.ENSEMBLE_SKIP_DOC_HOOK;
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('creates docs/UserGuide.md from template when change scope includes added-command', () => {
    const result = runDocMaintenance({}, ['added command for users'], repoRoot, {
      changeScopeCategories: ['added-command'],
    });

    const userGuidePath = path.join(repoRoot, 'docs/UserGuide.md');
    expect(fs.existsSync(userGuidePath)).toBe(true);
    expect(fs.readFileSync(userGuidePath, 'utf8')).toBe(USER_GUIDE_TEMPLATE);
    expect(result.createdFiles).toContain('docs/UserGuide.md');
  });

  test('skips creation when change scope is not user-visible', () => {
    const result = runDocMaintenance({}, ['removed internal helper'], repoRoot, {
      changeScopeCategories: ['removed-feature'],
    });

    expect(fs.existsSync(path.join(repoRoot, 'docs/UserGuide.md'))).toBe(false);
    expect(result.logs).toContain('INFO: no-user-visible-changes');
  });

  test('updates README.md and AGENTS.md when proposed edits are allowed', () => {
    const result = runDocMaintenance({}, [], repoRoot, {
      proposedEdits: [
        { path: 'README.md', content: '# README\nupdated\n' },
        { path: 'AGENTS.md', content: '# AGENTS\nupdated\n' },
      ],
    });

    expect(fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8')).toContain('updated');
    expect(fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8')).toContain('updated');
    expect(result.filesUpdated).toEqual(['README.md', 'AGENTS.md']);
  });

  test('scope guard rejects writes outside allow-list', () => {
    const result = runDocMaintenance({}, [], repoRoot, {
      proposedEdits: [
        { path: 'docs/PRD/foo.md', content: 'blocked' },
      ],
    });

    expect(fs.existsSync(path.join(repoRoot, 'docs/PRD/foo.md'))).toBe(false);
    expect(result.rejectedPaths).toEqual(['docs/PRD/foo.md']);
    expect(result.logs).toContain('INFO: scope-guard-rejected-paths:docs/PRD/foo.md');
  });

  test('emits INFO when ENSEMBLE_SKIP_DOC_HOOK=1', () => {
    process.env.ENSEMBLE_SKIP_DOC_HOOK = '1';
    const result = runDocMaintenance({}, [], repoRoot, {});
    expect(result.logs).toContain('INFO: ENSEMBLE_SKIP_DOC_HOOK=1; skipping doc maintenance.');
    expect(result.skipped).toBe(true);
  });

  test('emits INFO when documentation-specialist is missing', () => {
    const result = runDocMaintenance({}, [], repoRoot, {
      documentationAgentMissing: true,
    });
    expect(result.logs).toContain('INFO: documentation-specialist not in agent registry; skipping PR-boundary doc maintenance.');
    expect(result.skipped).toBe(true);
  });

  test('accepts beadHistory synthesized from git log text', () => {
    const gitLogLike = [
      'commit abc123',
      'Status: closed',
      'Documentation: documentation-specialist',
      'feat: added command docs',
    ].join('\n');

    const result = runDocMaintenance({}, gitLogLike, repoRoot, {});
    expect(result.categories).toContain('added-command');
  });
});
