'use strict';

/**
 * Tests for lib/bdd-mode.js: the one place that decides whether the TRD commands use the
 * Reqnroll/BDD path. Precedence is flag > ENSEMBLE_BDD > TRD `test_approach` > detected > default.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveBdd, detectReqnroll } = require('../lib/bdd-mode');

const REQNROLL_CSPROJ =
  '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>' +
  '<PackageReference Include="Reqnroll.xUnit" Version="2.0.0" />' +
  '</ItemGroup></Project>\n';

const roots = [];
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-mode-'));
  roots.push(dir);
  return dir;
}
function write(root, rel, text) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
  return full;
}
function trdWith(root, testApproach) {
  const stamp = testApproach === undefined ? '' : `test_approach: ${testApproach}\n`;
  return write(root, 'docs/TRD/TRD-2026-aaaaaaaa-x.md', `---\ndocument_id: TRD-2026-aaaaaaaa\nstatus: Draft\n${stamp}---\n\n# TRD\n`);
}
/** A repo that references Reqnroll, so `detected` would say yes. */
function reqnrollRepo() {
  const root = tmp();
  write(root, 'src/App.Tests/App.Tests.csproj', REQNROLL_CSPROJ);
  return root;
}

afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

describe('detectReqnroll', () => {
  test('finds a PackageReference in a csproj and reports the relative path with forward slashes', () => {
    expect(detectReqnroll(reqnrollRepo())).toBe('src/App.Tests/App.Tests.csproj');
  });

  test.each([
    ['Directory.Packages.props', '<Project><ItemGroup><PackageVersion Include="Reqnroll" Version="2.0.0" /></ItemGroup></Project>'],
    ['Directory.Build.props', "<Project><ItemGroup><PackageReference Update='Reqnroll.Tools.MsBuild.Generation' /></ItemGroup></Project>"],
    ['packages.config', '<packages><package id="Reqnroll" version="2.0.0" /></packages>'],
    ['src/Lib/Lib.fsproj', '<Project><ItemGroup><PackageReference Include="Reqnroll.NUnit" /></ItemGroup></Project>'],
  ])('recognises a reference in %s', (rel, text) => {
    const root = tmp();
    write(root, rel, text);
    expect(detectReqnroll(root)).toBe(rel);
  });

  test('is not fooled by prose, comments or look-alike package ids', () => {
    const root = tmp();
    write(root, 'A/A.csproj', '<Project><!-- we may adopt Reqnroll someday --></Project>');
    write(root, 'B/B.csproj', '<Project><ItemGroup><PackageReference Include="NotReqnrollAtAll" /></ItemGroup></Project>');
    write(root, 'C/notes.md', 'PackageReference Include="Reqnroll"');
    expect(detectReqnroll(root)).toBeNull();
  });

  test.each(['node_modules', 'bin', 'obj', 'dist', '.git', '.claude'])('does not look inside %s', (dir) => {
    const root = tmp();
    write(root, `${dir}/Decoy.csproj`, REQNROLL_CSPROJ);
    expect(detectReqnroll(root)).toBeNull();
  });

  test('returns null for an empty repo and for a root that does not exist, without throwing', () => {
    expect(detectReqnroll(tmp())).toBeNull();
    expect(detectReqnroll(path.join(os.tmpdir(), 'bdd-mode-does-not-exist-xyz'))).toBeNull();
  });
});

describe('resolveBdd precedence', () => {
  test('default: off when nothing says otherwise', () => {
    expect(resolveBdd({ env: {}, repoRoot: tmp() })).toEqual({
      enabled: false,
      source: 'default',
      message: 'Test approach: standard [default]',
    });
  });

  test('detected: on, with the manifest as evidence', () => {
    expect(resolveBdd({ env: {}, repoRoot: reqnrollRepo() })).toEqual({
      enabled: true,
      source: 'detected',
      evidence: 'src/App.Tests/App.Tests.csproj',
      message: 'Test approach: BDD (Reqnroll) [detected: src/App.Tests/App.Tests.csproj]',
    });
  });

  test.each([
    ['bdd', true],
    ['no-bdd', false],
  ])('flag %s beats env, the TRD stamp and detection', (flag, enabled) => {
    const root = reqnrollRepo();
    const trd = trdWith(root, enabled ? 'standard' : 'bdd-reqnroll');
    const env = { ENSEMBLE_BDD: enabled ? 'off' : 'on' };
    expect(resolveBdd({ flag, env, trdPath: trd, repoRoot: root })).toMatchObject({ enabled, source: 'flag' });
  });

  test.each([
    ['1', true], ['true', true], ['ON', true], [' yes ', true],
    ['0', false], ['False', false], ['off', false], ['NO', false],
  ])('env ENSEMBLE_BDD=%j -> %s, and beats the TRD stamp and detection', (value, enabled) => {
    const root = reqnrollRepo();
    const trd = trdWith(root, enabled ? 'standard' : 'bdd-reqnroll');
    expect(resolveBdd({ env: { ENSEMBLE_BDD: value }, trdPath: trd, repoRoot: root })).toMatchObject({ enabled, source: 'env' });
  });

  test('an unrecognised ENSEMBLE_BDD is ignored with a warning rather than silently trusted', () => {
    const out = resolveBdd({ env: { ENSEMBLE_BDD: 'maybe' }, repoRoot: tmp() });
    expect(out).toMatchObject({ enabled: false, source: 'default' });
    expect(out.warning).toContain("ENSEMBLE_BDD='maybe'");
  });

  test('an empty ENSEMBLE_BDD is simply unset: no warning', () => {
    const out = resolveBdd({ env: { ENSEMBLE_BDD: '  ' }, repoRoot: tmp() });
    expect(out).toMatchObject({ enabled: false, source: 'default' });
    expect(out.warning).toBeUndefined();
  });

  test('message is the one line the commands print: the warning first, then the approach and its source', () => {
    expect(resolveBdd({ flag: 'bdd', env: {} }).message).toBe('Test approach: BDD (Reqnroll) [flag]');
    expect(resolveBdd({ flag: 'no-bdd', env: {} }).message).toBe('Test approach: standard [flag]');
    expect(resolveBdd({ env: { ENSEMBLE_BDD: 'maybe' }, repoRoot: tmp() }).message).toBe(
      "Warning: ENSEMBLE_BDD='maybe' is not one of 1/true/on/yes or 0/false/off/no; ignored\nTest approach: standard [default]"
    );
  });

  test.each([
    ['bdd-reqnroll', true],
    ['standard', false],
    ['  BDD-Reqnroll ', true],
  ])('TRD test_approach %j -> %s, and beats detection', (stamp, enabled) => {
    const root = reqnrollRepo();
    const trd = trdWith(root, stamp);
    expect(resolveBdd({ env: {}, trdPath: trd, repoRoot: root })).toMatchObject({ enabled, source: 'trd', evidence: trd.split(path.sep).join('/') });
  });

  test('a TRD stamped bdd-reqnroll stays on in a repo with no Reqnroll yet (the greenfield case)', () => {
    const root = tmp();
    expect(resolveBdd({ env: {}, trdPath: trdWith(root, 'bdd-reqnroll'), repoRoot: root })).toMatchObject({ enabled: true, source: 'trd' });
  });

  test('an unrecognised test_approach falls through to detection, with a warning', () => {
    const root = reqnrollRepo();
    const out = resolveBdd({ env: {}, trdPath: trdWith(root, 'cucumber'), repoRoot: root });
    expect(out).toMatchObject({ enabled: true, source: 'detected' });
    expect(out.warning).toContain("test_approach 'cucumber'");
  });

  test('reads the stamp from a CRLF TRD (this repo\'s TRDs are often Windows-authored)', () => {
    const root = tmp();
    const trd = write(root, 'docs/TRD/crlf.md', '---\r\ndocument_id: TRD-2026-bbbbbbbb\r\ntest_approach: bdd-reqnroll\r\n---\r\n\r\n# TRD\r\n');
    expect(resolveBdd({ env: {}, trdPath: trd, repoRoot: root })).toMatchObject({ enabled: true, source: 'trd' });
  });

  test('a TRD without the key, or an unreadable TRD path, falls through to detection', () => {
    const root = reqnrollRepo();
    expect(resolveBdd({ env: {}, trdPath: trdWith(root), repoRoot: root })).toMatchObject({ source: 'detected' });
    expect(resolveBdd({ env: {}, trdPath: path.join(root, 'nope.md'), repoRoot: root })).toMatchObject({ source: 'detected' });
  });
});
