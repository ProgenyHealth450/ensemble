'use strict';
/**
 * Regression test for the Windows glob-pattern bug: path.join() produces
 * backslash-separated paths, which the `glob` npm package treats as escape
 * characters instead of separators, silently matching zero files.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { toGlobPattern, discoverYamlsInDir } = require('../lib/file-discovery');

describe('toGlobPattern', () => {
  test('converts backslash-separated paths to forward slashes', () => {
    expect(toGlobPattern('packages\\foo\\commands\\*.yaml')).toBe('packages/foo/commands/*.yaml');
  });

  test('leaves forward-slash paths unchanged', () => {
    expect(toGlobPattern('packages/foo/commands/*.yaml')).toBe('packages/foo/commands/*.yaml');
  });
});

describe('discoverYamlsInDir', () => {
  test('finds .yaml files via a path.join-constructed directory (regression: previously found 0 on Windows)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-discovery-test-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.yaml'), 'name: a');
      fs.writeFileSync(path.join(dir, 'b.yaml'), 'name: b');

      const found = await discoverYamlsInDir(dir);

      expect(found.map((f) => path.basename(f)).sort()).toEqual(['a.yaml', 'b.yaml']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
