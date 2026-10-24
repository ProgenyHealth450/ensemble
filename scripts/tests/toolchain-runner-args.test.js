'use strict';
/**
 * Tests for TRD-2026-8d825f54 TRD-010: `buildArgv(runTemplate, args, contract)` in
 * packages/development/lib/toolchain/runner.js — `{name}` placeholder substitution inside
 * argv template elements, per-input type validation (string, integer, enum, path), the
 * leading-`-` rejection on every substituted value, `variants` selector handling, and proof
 * that no shell interpretation ever occurs (PRD REQ-022, REQ-023).
 */

const { buildArgv } = require('../../packages/development/lib/toolchain/runner');

describe('buildArgv: placeholder substitution and leading-`-` rejection (Implementation AC 1)', () => {
  test('rejects a value beginning with "-" as INVALID_ARG naming the arg', () => {
    expect.assertions(2);
    try {
      buildArgv(['br', 'show', '{id}'], { id: '--help' }, { inputs: { id: { type: 'string' } } });
    } catch (error) {
      expect(error.code).toBe('INVALID_ARG');
      expect(error.message).toContain('id');
    }
  });

  test('substitutes a well-formed value into the argv array', () => {
    const argv = buildArgv(['br', 'show', '{id}'], { id: 'bd-12' }, { inputs: { id: { type: 'string' } } });
    expect(argv).toEqual(['br', 'show', 'bd-12']);
  });

  test('a placeholder not declared in contract.inputs still gets the leading-"-" rejection', () => {
    expect.assertions(1);
    try {
      buildArgv(['br', 'show', '{id}'], { id: '-x' }, {});
    } catch (error) {
      expect(error.code).toBe('INVALID_ARG');
    }
  });
});

describe('buildArgv: no shell interpretation (Implementation AC 2)', () => {
  test('a value containing shell metacharacters is carried through unchanged as one argv element', () => {
    const dangerous = 'a; rm -rf /';
    const argv = buildArgv(['echo', '{message}'], { message: dangerous }, { inputs: { message: { type: 'string' } } });
    expect(argv).toHaveLength(2);
    expect(argv[1]).toBe(dangerous);
  });

  test('a value containing a command substitution token is carried through unchanged', () => {
    const dangerous = 'before $(x) after';
    const argv = buildArgv(['echo', '{message}'], { message: dangerous }, { inputs: { message: { type: 'string' } } });
    expect(argv).toHaveLength(2);
    expect(argv[1]).toBe(dangerous);
  });
});

describe('buildArgv: variants (Implementation AC 3)', () => {
  const jestRunTemplate = ['npx', 'jest', '{pattern}'];
  const pytestRunTemplate = ['pytest', '{pattern}'];
  const contract = {
    inputs: {
      toolKey: { type: 'enum', values: ['jest', 'pytest'] },
      pattern: { type: 'string' }
    },
    variants: {
      toolKey: { jest: jestRunTemplate, pytest: pytestRunTemplate }
    }
  };

  test('a selector value outside the declared variant keys throws NOT_ALLOWED naming the selector and value, building no argv', () => {
    expect.assertions(4);
    const baseTemplate = ['base', '{pattern}'];
    const baseTemplateCopy = [...baseTemplate];
    try {
      buildArgv(baseTemplate, { toolKey: 'rspec', pattern: 'spec/foo' }, contract);
    } catch (error) {
      expect(error.code).toBe('NOT_ALLOWED');
      expect(error.message).toContain('toolKey');
      expect(error.message).toContain('rspec');
    }
    expect(baseTemplate).toEqual(baseTemplateCopy);
  });

  test('a selector value equal to a variant key leaves the base runTemplate array untouched', () => {
    const baseTemplate = ['base', '{pattern}'];
    const baseTemplateCopy = [...baseTemplate];
    buildArgv(baseTemplate, { toolKey: 'jest', pattern: 'src/foo.test.js' }, contract);
    expect(baseTemplate).toEqual(baseTemplateCopy);
  });

  test('a selector value equal to a variant key builds only that variant\'s argv, ignoring the base runTemplate', () => {
    const baseTemplate = ['base', '{pattern}'];
    const argv = buildArgv(baseTemplate, { toolKey: 'jest', pattern: 'src/foo.test.js' }, contract);
    expect(argv).toEqual(['npx', 'jest', 'src/foo.test.js']);
  });

  test('a selector arg with a declared contract default selects the correct variant when args omits the selector', () => {
    const contractWithDefault = {
      inputs: {
        toolKey: { type: 'string', default: 'jest' },
        pattern: { type: 'string' }
      },
      variants: {
        toolKey: { jest: jestRunTemplate, pytest: pytestRunTemplate }
      }
    };
    const argv = buildArgv(['base', '{pattern}'], { pattern: 'src/foo.test.js' }, contractWithDefault);
    expect(argv).toEqual(['npx', 'jest', 'src/foo.test.js']);
  });

  test('a selector arg with an invalid contract default throws NOT_ALLOWED naming the selector and the default value', () => {
    expect.assertions(2);
    const contractWithBadDefault = {
      inputs: {
        toolKey: { type: 'string', default: 'rspec' },
        pattern: { type: 'string' }
      },
      variants: {
        toolKey: { jest: jestRunTemplate, pytest: pytestRunTemplate }
      }
    };
    try {
      buildArgv(['base', '{pattern}'], { pattern: 'spec/foo' }, contractWithBadDefault);
    } catch (error) {
      expect(error.code).toBe('NOT_ALLOWED');
      expect(error.message).toContain('rspec');
    }
  });

  test('no selector supplied and no contract default keeps the base runTemplate (no throw)', () => {
    const contractNoDefault = {
      inputs: { pattern: { type: 'string' } },
      variants: { toolKey: { jest: jestRunTemplate, pytest: pytestRunTemplate } }
    };
    const argv = buildArgv(['base', '{pattern}'], { pattern: 'spec/foo' }, contractNoDefault);
    expect(argv).toEqual(['base', 'spec/foo']);
  });
});

describe('buildArgv: missing placeholder and type validation (Implementation AC 4)', () => {
  test('a placeholder with no supplied arg and no contract default throws INVALID_ARG naming the placeholder', () => {
    expect.assertions(2);
    try {
      buildArgv(['br', 'show', '{id}'], {}, { inputs: { id: { type: 'string' } } });
    } catch (error) {
      expect(error.code).toBe('INVALID_ARG');
      expect(error.message).toContain('id');
    }
  });

  test('a contract default is used when no arg is supplied', () => {
    const argv = buildArgv(['br', 'show', '{id}'], {}, { inputs: { id: { type: 'string', default: 'bd-1' } } });
    expect(argv).toEqual(['br', 'show', 'bd-1']);
  });

  test('a non-numeric string for an integer input throws INVALID_ARG naming the arg', () => {
    expect.assertions(2);
    try {
      buildArgv(['tool', '{count}'], { count: 'abc' }, { inputs: { count: { type: 'integer' } } });
    } catch (error) {
      expect(error.code).toBe('INVALID_ARG');
      expect(error.message).toContain('count');
    }
  });

  test('a float for an integer input throws INVALID_ARG naming the arg', () => {
    expect.assertions(2);
    try {
      buildArgv(['tool', '{count}'], { count: 3.5 }, { inputs: { count: { type: 'integer' } } });
    } catch (error) {
      expect(error.code).toBe('INVALID_ARG');
      expect(error.message).toContain('count');
    }
  });

  test('NaN for an integer input throws INVALID_ARG naming the arg', () => {
    expect.assertions(2);
    try {
      buildArgv(['tool', '{count}'], { count: NaN }, { inputs: { count: { type: 'integer' } } });
    } catch (error) {
      expect(error.code).toBe('INVALID_ARG');
      expect(error.message).toContain('count');
    }
  });

  test('a valid non-negative integer (string or number) substitutes correctly', () => {
    const argvFromString = buildArgv(['tool', '{count}'], { count: '42' }, { inputs: { count: { type: 'integer' } } });
    expect(argvFromString).toEqual(['tool', '42']);

    const argvFromNumber = buildArgv(['tool', '{count}'], { count: 7 }, { inputs: { count: { type: 'integer' } } });
    expect(argvFromNumber).toEqual(['tool', '7']);
  });
});

describe('buildArgv: enum and string/path validation (Implementation AC 5)', () => {
  test('a value outside the declared enum values throws INVALID_ARG naming the arg and the invalid value', () => {
    expect.assertions(3);
    try {
      buildArgv(['tool', '{sort}'], { sort: 'random' }, { inputs: { sort: { type: 'enum', values: ['asc', 'desc'] } } });
    } catch (error) {
      expect(error.code).toBe('INVALID_ARG');
      expect(error.message).toContain('sort');
      expect(error.message).toContain('random');
    }
  });

  test('a value inside the declared enum values substitutes correctly', () => {
    const argv = buildArgv(['tool', '{sort}'], { sort: 'asc' }, { inputs: { sort: { type: 'enum', values: ['asc', 'desc'] } } });
    expect(argv).toEqual(['tool', 'asc']);
  });

  test('type "string" accepts any non-dash-leading string', () => {
    const argv = buildArgv(['tool', '{name}'], { name: 'hello world' }, { inputs: { name: { type: 'string' } } });
    expect(argv).toEqual(['tool', 'hello world']);
  });

  test('type "path" accepts any non-dash-leading string and rejects a dash-leading one', () => {
    const argv = buildArgv(['tool', '{file}'], { file: 'src/index.js' }, { inputs: { file: { type: 'path' } } });
    expect(argv).toEqual(['tool', 'src/index.js']);

    expect.assertions(3);
    try {
      buildArgv(['tool', '{file}'], { file: '--etc/passwd' }, { inputs: { file: { type: 'path' } } });
    } catch (error) {
      expect(error.code).toBe('INVALID_ARG');
      expect(error.message).toContain('file');
    }
  });

  test('an input declared with an unrecognized type throws INVALID_ARG naming the arg and the bad type', () => {
    expect.assertions(3);
    try {
      buildArgv(['tool', '{pattern}'], { pattern: 'abc' }, { inputs: { pattern: { type: 'regex' } } });
    } catch (error) {
      expect(error.code).toBe('INVALID_ARG');
      expect(error.message).toContain('pattern');
      expect(error.message).toContain('regex');
    }
  });
});

describe('buildArgv: literal template elements (Implementation AC 6)', () => {
  test('literal (non-placeholder) elements pass through unchanged and are never validated', () => {
    const argv = buildArgv(['br', 'show', '{id}'], { id: 'bd-12' }, { inputs: {} });
    expect(argv[0]).toBe('br');
    expect(argv[1]).toBe('show');
  });
});

describe('buildArgv: explicit null values are treated as "no value supplied" (fail-closed presence check)', () => {
  test('an explicit null value with no contract default throws INVALID_ARG naming the arg', () => {
    expect.assertions(2);
    try {
      buildArgv(['br', 'show', '{id}'], { id: null }, { inputs: { id: { type: 'string' } } });
    } catch (error) {
      expect(error.code).toBe('INVALID_ARG');
      expect(error.message).toContain('id');
    }
  });

  test('an explicit null value falls back to a declared contract default', () => {
    const argv = buildArgv(['br', 'show', '{id}'], { id: null }, { inputs: { id: { type: 'string', default: 'bd-1' } } });
    expect(argv).toEqual(['br', 'show', 'bd-1']);
  });
});

describe('buildArgv: never spawns a process via a shell (Implementation AC 7, TRD-011 AC 3)', () => {
  test('the file never sets a shell option to true and never calls a bare exec(), only execFile(', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'packages', 'development', 'lib', 'toolchain', 'runner.js'),
      'utf8'
    );
    // TRD-011's own Implementation AC states this exact permanent constraint verbatim: a
    // command not granted the shell tool cannot call the runner, verified by `grep -n
    // "shell:\s*true|exec("` over this file returning zero matches. `runCapability` (TRD-011)
    // legitimately calls `execFile(`, which must NOT trip this pattern -- the regex below is
    // anchored with `\b` so `exec(` only matches a bare `exec(` call, never the `exec` prefix
    // inside `execFile(`.
    const forbiddenPattern = /shell:\s*true|\bexec\(/;
    expect(source).not.toMatch(forbiddenPattern);
    // Prove the assertion above actually discriminates: the forbidden pattern must not
    // false-positive against the legitimate `execFile(` call, and `execFile(` must be present
    // (TRD-011's `runCapability`, the only place in this file that spawns a process).
    expect(forbiddenPattern.test('execFile(')).toBe(false);
    expect(source).toMatch(/\bexecFile\(/);
  });

  test('buildArgv returns a plain array of strings, never a shell-concatenated string', () => {
    const argv = buildArgv(['br', 'show', '{id}'], { id: 'bd-12' }, { inputs: { id: { type: 'string' } } });
    expect(Array.isArray(argv)).toBe(true);
    for (const element of argv) {
      expect(typeof element).toBe('string');
    }
  });
});
