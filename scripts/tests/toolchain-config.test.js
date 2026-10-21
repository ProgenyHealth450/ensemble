'use strict';
/**
 * Tests for TRD-2026-8d825f54 TRD-003: `resolveCategory()`/`loadToolchainConfigFile()` in
 * packages/development/lib/toolchain/config.js, covering the fixed resolution precedence
 * (project > user > env-compat > detection > shipped default) from PRD REQ-009
 * (AC-009-1, AC-009-2).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveCategory } = require('../../packages/development/lib/toolchain/config');

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function mkProjectConfig(projectRoot, yamlContents) {
  const ensembleDir = path.join(projectRoot, '.ensemble');
  fs.mkdirSync(ensembleDir, { recursive: true });
  const configPath = path.join(ensembleDir, 'toolchain.yaml');
  fs.writeFileSync(configPath, yamlContents);
  return configPath;
}

describe('resolveCategory precedence', () => {
  test('AC-009-1: project config wins over user config for the same category', () => {
    const tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-toolchain-project-'));
    const tmpXdgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-toolchain-xdg-'));
    tempDirs.push(tmpProjectDir, tmpXdgDir);

    mkProjectConfig(tmpProjectDir, 'tracker: a\n');

    const userConfigDir = path.join(tmpXdgDir, 'ensemble');
    fs.mkdirSync(userConfigDir, { recursive: true });
    fs.writeFileSync(path.join(userConfigDir, 'toolchain.yaml'), 'tracker: b\n');

    const result = resolveCategory('tracker', {
      projectRoot: tmpProjectDir,
      env: { XDG_CONFIG_HOME: tmpXdgDir }
    });

    expect(result).toEqual({ value: 'a', source: 'project' });
  });

  test('AC-009-2: falls back to the shipped default when no config or detection selects a value', () => {
    const tmpEmptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-toolchain-empty-'));
    tempDirs.push(tmpEmptyDir);

    const result = resolveCategory('tracker', { projectRoot: tmpEmptyDir, env: {} });

    expect(result).toEqual({ value: 'beads', source: 'default' });
  });

  test('an unknown category key in a project config throws naming the file and the key', () => {
    const tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-toolchain-invalid-'));
    tempDirs.push(tmpProjectDir);

    const configPath = mkProjectConfig(tmpProjectDir, 'bogus-category: x\n');

    let thrown = null;
    try {
      resolveCategory('tracker', { projectRoot: tmpProjectDir, env: {} });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toContain(configPath);
    expect(thrown.message).toContain('bogus-category');
  });

  test('ENSEMBLE_PR_BACKEND selects host with source env-compat when no config files exist', () => {
    const tmpEmptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-toolchain-envcompat-'));
    tempDirs.push(tmpEmptyDir);

    const result = resolveCategory('host', {
      projectRoot: tmpEmptyDir,
      env: { ENSEMBLE_PR_BACKEND: 'azure-devops' }
    });

    expect(result).toEqual({ value: 'azure-devops', source: 'env-compat' });
  });

  test('env-compat is scoped to host/workflow only: ENSEMBLE_PR_BACKEND does not affect tracker', () => {
    const tmpEmptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-toolchain-envcompat-scope-'));
    tempDirs.push(tmpEmptyDir);

    const result = resolveCategory('tracker', {
      projectRoot: tmpEmptyDir,
      env: { ENSEMBLE_PR_BACKEND: 'azure-devops' }
    });

    expect(result).toEqual({ value: 'beads', source: 'default' });
  });

  test('the detection hook is consulted before falling back to the shipped default', () => {
    const tmpEmptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-toolchain-detect-'));
    tempDirs.push(tmpEmptyDir);

    const detect = jest.fn(() => ({ value: 'detected-tracker' }));

    const result = resolveCategory('tracker', { projectRoot: tmpEmptyDir, env: {}, detect });

    expect(result).toEqual({ value: 'detected-tracker', source: 'detection' });
    expect(detect).toHaveBeenCalledWith('tracker', expect.objectContaining({ projectRoot: tmpEmptyDir }));
  });
});
