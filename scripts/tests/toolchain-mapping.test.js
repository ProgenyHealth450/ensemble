'use strict';
/**
 * Tests for TRD-2026-8d825f54 TRD-012: `mapOutput(stdout, parse)` in
 * packages/development/lib/toolchain/mapping.js — JSON/lines/text stdout parsing, dotted-path
 * field projection (`map`), `statusMap` value translation, and the normalized "work item" JSON
 * schema (`packages/development/toolchain/schemas/normalized/work-item.json`) the mapped output
 * is expected to validate against (PRD REQ-002, REQ-022).
 *
 * In scope: TRD-012's Implementation AC bullets 1, 2 and 4, tested directly against
 * `mapOutput`. Implementation AC bullet 3 (schema validation wired into `runCapability`,
 * returning `{ok:false, error:{code:'BAD_OUTPUT'}}` end to end) is TRD-011/TRD-012 integration
 * work, out of scope here: `runner.js` is not touched or exercised by this file.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Ajv = require('ajv');

const { mapOutput, resolvePath } = require('../../packages/development/lib/toolchain/mapping');

const MAPPING_SOURCE_PATH = path.join(__dirname, '..', '..', 'packages', 'development', 'lib', 'toolchain', 'mapping.js');
const WORK_ITEM_SCHEMA_PATH = path.join(
  __dirname,
  '..',
  '..',
  'packages',
  'development',
  'toolchain',
  'schemas',
  'normalized',
  'work-item.json'
);

function compileWorkItemValidator() {
  const schema = JSON.parse(fs.readFileSync(WORK_ITEM_SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv({ allErrors: true });
  return ajv.compile(schema);
}

describe('mapOutput: JSON format field projection (Implementation AC 1)', () => {
  test('maps a nested Jira-shaped JSON document into {id, title} exactly as the TRD states', () => {
    const stdout = JSON.stringify({ issues: [{ key: 'A-1', fields: { summary: 'x' } }] });
    const result = mapOutput(stdout, {
      format: 'json',
      map: { id: '$.issues[0].key', title: '$.issues[0].fields.summary' }
    });
    expect(result).toEqual({ id: 'A-1', title: 'x' });
  });

  test('a non-default root projects before map paths are resolved', () => {
    const stdout = JSON.stringify({ data: { id: 'ROOT-1' } });
    const result = mapOutput(stdout, { format: 'json', root: '$.data', map: { id: '$.id' } });
    expect(result).toEqual({ id: 'ROOT-1' });
  });
});

describe('mapOutput: statusMap value translation (Implementation AC 2)', () => {
  test('a mapped status string translates through statusMap to the normalized value', () => {
    const stdout = JSON.stringify({ status: 'In Progress' });
    const result = mapOutput(stdout, {
      format: 'json',
      map: { status: '$.status' },
      statusMap: { 'In Progress': 'in_progress' }
    });
    expect(result.status).toBe('in_progress');
  });

  test('an unmapped status value throws BAD_OUTPUT naming the value', () => {
    const stdout = JSON.stringify({ status: 'Weird' });
    expect(() =>
      mapOutput(stdout, {
        format: 'json',
        map: { status: '$.status' },
        statusMap: { 'In Progress': 'in_progress' }
      })
    ).toThrow(/Weird/);

    try {
      mapOutput(stdout, {
        format: 'json',
        map: { status: '$.status' },
        statusMap: { 'In Progress': 'in_progress' }
      });
      throw new Error('expected mapOutput to throw');
    } catch (err) {
      expect(err.code).toBe('BAD_OUTPUT');
      expect(err.message).toMatch(/Weird/);
    }
  });

  test('statusMap is simply unused when the mapped result has no status key', () => {
    const stdout = JSON.stringify({ id: 'X-1' });
    const result = mapOutput(stdout, {
      format: 'json',
      map: { id: '$.id' },
      statusMap: { 'In Progress': 'in_progress' }
    });
    expect(result).toEqual({ id: 'X-1' });
  });
});

describe('mapOutput: two adapters, same capability, both validate against the normalized schema (Implementation AC 4)', () => {
  test('a Jira-shaped adapter and a flat-tracker-shaped adapter both map to a schema-valid work item', () => {
    const validate = compileWorkItemValidator();

    // Adapter A: Jira-like nested shape, status needs translation.
    const stdoutA = JSON.stringify({
      issues: [
        {
          key: 'JIRA-1',
          fields: { summary: 'Fix the bug', status: 'In Progress' }
        }
      ]
    });
    const resultA = mapOutput(stdoutA, {
      format: 'json',
      map: {
        id: '$.issues[0].key',
        title: '$.issues[0].fields.summary',
        status: '$.issues[0].fields.status'
      },
      statusMap: { 'In Progress': 'in_progress' }
    });
    expect(resultA).toEqual({ id: 'JIRA-1', title: 'Fix the bug', status: 'in_progress' });
    expect(validate(resultA)).toBe(true);

    // Adapter B: flat simple-tracker shape, status already a valid normalized value.
    const stdoutB = JSON.stringify({ id: 'BV-42', title: 'Fix the bug', status: 'open' });
    const resultB = mapOutput(stdoutB, {
      format: 'json',
      map: { id: '$.id', title: '$.title', status: '$.status' }
    });
    expect(resultB).toEqual({ id: 'BV-42', title: 'Fix the bug', status: 'open' });
    expect(validate(resultB)).toBe(true);
  });

  test('a mapped result missing the required id field fails schema validation', () => {
    const validate = compileWorkItemValidator();
    const result = mapOutput(JSON.stringify({ title: 'no id here' }), {
      format: 'json',
      map: { title: '$.title' }
    });
    expect(validate(result)).toBe(false);
    expect(validate.errors.some((e) => e.params && e.params.missingProperty === 'id')).toBe(true);
  });
});

describe('mapOutput: lines and text formats', () => {
  test('lines format splits on newline, trims a trailing empty line, drops empty lines, with no map', () => {
    expect(mapOutput('a\nb\nc\n', { format: 'lines' })).toEqual(['a', 'b', 'c']);
  });

  test('lines format with a blank line in the middle drops it, not just the trailing one', () => {
    expect(mapOutput('a\n\nb\n', { format: 'lines' })).toEqual(['a', 'b']);
  });

  test('lines format with map projects into the array of lines by index', () => {
    expect(mapOutput('first\nsecond\n', { format: 'lines', map: { first: '$[0]', second: '$[1]' } })).toEqual({
      first: 'first',
      second: 'second'
    });
  });

  test('text format returns the whole trimmed stdout as a single value with no map', () => {
    expect(mapOutput('  hello world  \n', { format: 'text' })).toBe('hello world');
  });

  test('text format with map copies the trimmed text into an output key via the bare "$" path', () => {
    expect(mapOutput('hello\n', { format: 'text', map: { raw: '$' } })).toEqual({ raw: 'hello' });
  });
});

describe('mapOutput: malformed input is always BAD_OUTPUT, never a raw exception', () => {
  test('malformed JSON stdout throws BAD_OUTPUT', () => {
    expect(() => mapOutput('not json {', { format: 'json', map: { id: '$.id' } })).toThrow();
    try {
      mapOutput('not json {', { format: 'json', map: { id: '$.id' } });
      throw new Error('expected mapOutput to throw');
    } catch (err) {
      expect(err.code).toBe('BAD_OUTPUT');
      expect(err.message).toMatch(/malformed JSON/);
    }
  });

  test('a missing root path throws BAD_OUTPUT naming the path', () => {
    try {
      mapOutput(JSON.stringify({ id: 'ok' }), { format: 'json', root: '$.missing', map: { id: '$.id' } });
      throw new Error('expected mapOutput to throw');
    } catch (err) {
      expect(err.code).toBe('BAD_OUTPUT');
      expect(err.message).toMatch(/\$\.missing/);
    }
  });

  test('a missing map path throws BAD_OUTPUT naming the unresolved path', () => {
    try {
      mapOutput(JSON.stringify({ id: 'ok' }), { format: 'json', map: { title: '$.nonexistent' } });
      throw new Error('expected mapOutput to throw');
    } catch (err) {
      expect(err.code).toBe('BAD_OUTPUT');
      expect(err.message).toMatch(/\$\.nonexistent/);
    }
  });

  test('an unknown parse.format throws BAD_OUTPUT', () => {
    try {
      mapOutput('x', { format: 'xml' });
      throw new Error('expected mapOutput to throw');
    } catch (err) {
      expect(err.code).toBe('BAD_OUTPUT');
    }
  });

  test('an out-of-range array index throws BAD_OUTPUT', () => {
    try {
      mapOutput(JSON.stringify({ issues: ['a', 'b'] }), { format: 'json', map: { id: '$.issues[5]' } });
      throw new Error('expected mapOutput to throw');
    } catch (err) {
      expect(err.code).toBe('BAD_OUTPUT');
      expect(err.message).toMatch(/out of bounds/);
    }
  });
});

describe('resolvePath: dotted-path grammar', () => {
  test('"$" alone resolves to the whole base value', () => {
    const value = { a: 1 };
    expect(resolvePath(value, '$')).toBe(value);
  });

  test('a direct root index chain "$[N]" indexes into an array base value', () => {
    expect(resolvePath(['x', 'y', 'z'], '$[1]')).toBe('y');
  });

  test('"|" alternation tries the first candidate, falling back to the second when absent, using one shared declared path', () => {
    const sharedPath = '$.issues[0]|issue.key';
    expect(resolvePath({ issues: [{ key: 'A' }] }, sharedPath)).toBe('A');
    expect(resolvePath({ issue: { key: 'B' } }, sharedPath)).toBe('B');
  });

  test('indexing a non-array with "[N]" throws BAD_OUTPUT', () => {
    try {
      resolvePath({ a: { b: 1 } }, '$.a[0]');
      throw new Error('expected resolvePath to throw');
    } catch (err) {
      expect(err.code).toBe('BAD_OUTPUT');
    }
  });
});

describe('mapOutput: parse.map and parse.statusMap must be plain objects when present (Finding 1)', () => {
  test.each([
    ['a number', 5],
    ['a string', 'nope'],
    ['an array', ['nope']]
  ])('a non-object parse.map (%s) throws BAD_OUTPUT', (_label, badMap) => {
    try {
      mapOutput(JSON.stringify({ a: 1 }), { format: 'json', map: badMap });
      throw new Error('expected mapOutput to throw');
    } catch (err) {
      expect(err.code).toBe('BAD_OUTPUT');
      expect(err.message).toMatch(/parse\.map must be an object/);
    }
  });

  test.each([
    ['explicit null', null],
    ['an array', ['nope']],
    ['a number', 5]
  ])('a non-object parse.statusMap (%s) throws BAD_OUTPUT', (_label, badStatusMap) => {
    try {
      mapOutput(JSON.stringify({ status: 'In Progress' }), {
        format: 'json',
        map: { status: '$.status' },
        statusMap: badStatusMap
      });
      throw new Error('expected mapOutput to throw');
    } catch (err) {
      expect(err.code).toBe('BAD_OUTPUT');
      expect(err.message).toMatch(/parse\.statusMap must be an object/);
    }
  });
});

describe('resolvePath: malformed path grammar edge cases (Finding 2)', () => {
  test('a bracket-only path segment fails the segment regex and throws BAD_OUTPUT naming the segment', () => {
    try {
      resolvePath({ a: 1 }, '$.[0]');
      throw new Error('expected resolvePath to throw');
    } catch (err) {
      expect(err.code).toBe('BAD_OUTPUT');
      expect(err.message).toMatch(/malformed path segment '\[0\]'/);
    }
  });

  test('a non-string path throws BAD_OUTPUT, not a raw TypeError', () => {
    try {
      resolvePath({ a: 1 }, 5);
      throw new Error('expected resolvePath to throw');
    } catch (err) {
      expect(err.code).toBe('BAD_OUTPUT');
      expect(err.message).toMatch(/dotted path must be a string/);
    }
  });

  test('an empty-string path throws BAD_OUTPUT instead of silently returning the base value', () => {
    try {
      resolvePath({ a: 1 }, '');
      throw new Error('expected resolvePath to throw');
    } catch (err) {
      expect(err.code).toBe('BAD_OUTPUT');
      expect(err.message).toMatch(/dotted path must be a string/);
    }
  });

  test('a path not starting with "$" throws BAD_OUTPUT instead of silently resolving a shifted path', () => {
    try {
      resolvePath({ b: 'wrong' }, 'a.b');
      throw new Error('expected resolvePath to throw');
    } catch (err) {
      expect(err.code).toBe('BAD_OUTPUT');
      expect(err.message).toMatch(/dotted path must be a string starting with '\$'/);
    }
  });

  test('"$abc" with no "." after "$" throws BAD_OUTPUT instead of silently resolving a shifted segment', () => {
    try {
      resolvePath({ bc: 'oops' }, '$abc');
      throw new Error('expected resolvePath to throw');
    } catch (err) {
      expect(err.code).toBe('BAD_OUTPUT');
      expect(err.message).toMatch(/expected '\.' after '\$'/);
    }
  });

  test('a doubled dot produces an empty segment and throws BAD_OUTPUT', () => {
    try {
      resolvePath({ a: { b: 1 } }, '$.a..b');
      throw new Error('expected resolvePath to throw');
    } catch (err) {
      expect(err.code).toBe('BAD_OUTPUT');
      expect(err.message).toMatch(/empty segment/);
    }
  });

  test('a trailing dot produces an empty segment and throws BAD_OUTPUT', () => {
    try {
      resolvePath({ a: {} }, '$.a.');
      throw new Error('expected resolvePath to throw');
    } catch (err) {
      expect(err.code).toBe('BAD_OUTPUT');
      expect(err.message).toMatch(/empty segment/);
    }
  });
});

describe('mapOutput: guard branches found untested by mutation sweep (Finding 2)', () => {
  test('a null JSON root with a map throws BAD_OUTPUT, not a raw TypeError', () => {
    try {
      mapOutput('null', { format: 'json', map: { x: '$.a' } });
      throw new Error('expected mapOutput to throw');
    } catch (err) {
      expect(err.code).toBe('BAD_OUTPUT');
      expect(err).not.toBeInstanceOf(TypeError);
    }
  });

  test('parse itself must be an object: a string parse throws BAD_OUTPUT naming parse, not the generic format message', () => {
    try {
      mapOutput('x', 'not-an-object');
      throw new Error('expected mapOutput to throw');
    } catch (err) {
      expect(err.code).toBe('BAD_OUTPUT');
      expect(err.message).toMatch(/'parse' must be an object/);
    }
  });

  test('parse itself must be an object: a null parse throws BAD_OUTPUT naming parse, not the generic format message', () => {
    try {
      mapOutput('x', null);
      throw new Error('expected mapOutput to throw');
    } catch (err) {
      expect(err.code).toBe('BAD_OUTPUT');
      expect(err.message).toMatch(/'parse' must be an object/);
    }
  });

  test('a non-string parse.root throws BAD_OUTPUT naming parse.root specifically', () => {
    try {
      mapOutput(JSON.stringify({ a: 1 }), { format: 'json', root: 5, map: { x: '$.a' } });
      throw new Error('expected mapOutput to throw');
    } catch (err) {
      expect(err.code).toBe('BAD_OUTPUT');
      expect(err.message).toMatch(/parse\.root must be a string/);
    }
  });

  test('a non-string map entry value throws BAD_OUTPUT naming the specific map key', () => {
    try {
      mapOutput(JSON.stringify({ a: 1 }), { format: 'json', map: { id: 123 } });
      throw new Error('expected mapOutput to throw');
    } catch (err) {
      expect(err.code).toBe('BAD_OUTPUT');
      expect(err.message).toMatch(/parse\.map\['id'\]/);
    }
  });
});

describe('mapOutput: the no-map object-copy branch actually copies (Finding 2, line 296)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('a parsed JSON object with no map is shallow-copied, not returned by reference, before statusMap mutates it', () => {
    const parsedDocument = { status: 'In Progress', id: 'X-1' };
    jest.spyOn(JSON, 'parse').mockReturnValueOnce(parsedDocument);

    const result = mapOutput('ignored because JSON.parse is mocked', {
      format: 'json',
      statusMap: { 'In Progress': 'in_progress' }
    });

    expect(result).not.toBe(parsedDocument);
    expect(result).toEqual({ status: 'in_progress', id: 'X-1' });
    expect(parsedDocument.status).toBe('In Progress');
  });
});

describe('mutation-restore proof', () => {
  const originalSource = fs.readFileSync(MAPPING_SOURCE_PATH, 'utf8');
  const tmpFiles = [];
  let mutantCounter = 0;

  // Writes mutated source to a private file under os.tmpdir() (never to the real repo path)
  // and requires it by absolute path. Each call gets a unique filename (pid + counter), so it
  // is a distinct module identity from the real mapping.js and from every other mutant: no
  // jest.resetModules()/live-file involvement needed, and no cross-test caching risk.
  const loadMutant = (label, mutatedSource) => {
    mutantCounter += 1;
    const tmpFile = path.join(os.tmpdir(), `mapping-mutant-${label}-${process.pid}-${mutantCounter}.js`);
    fs.writeFileSync(tmpFile, mutatedSource);
    tmpFiles.push(tmpFile);
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(tmpFile);
  };

  afterEach(() => {
    while (tmpFiles.length > 0) {
      const tmpFile = tmpFiles.pop();
      try {
        fs.unlinkSync(tmpFile);
      } catch (err) {
        // already removed or never created; nothing to clean up
      }
    }
  });

  test('the statusMap unmapped-value-throws branch actually discriminates: inverting it makes the unmapped-status test fail', () => {
    const needle = "if (!Object.prototype.hasOwnProperty.call(statusMap, rawStatus)) {";
    expect(originalSource).toContain(needle);
    // Invert the guard so an unmapped status is silently treated as mapped, by making the
    // condition always false (never throw).
    const mutated = originalSource.replace(needle, 'if (false) {');
    expect(mutated).not.toBe(originalSource);

    const mutatedMapping = loadMutant('statusmap-unmapped-throws', mutated);
    expect(() =>
      mutatedMapping.mapOutput(JSON.stringify({ status: 'Weird' }), {
        format: 'json',
        map: { status: '$.status' },
        statusMap: { 'In Progress': 'in_progress' }
      })
    ).not.toThrow(); // confirms the mutated branch is dead: the real test above would now fail
  });

  test('dotted-path array-index resolution actually discriminates: disabling bounds checking breaks the out-of-range test', () => {
    const needle = 'if (idx < 0 || idx >= current.length || current[idx] === undefined) {';
    expect(originalSource).toContain(needle);
    const mutated = originalSource.replace(needle, 'if (false) {');
    expect(mutated).not.toBe(originalSource);

    const mutatedMapping = loadMutant('array-index-bounds', mutated);
    // With bounds checking disabled, indexing past the end of a 2-element array at '[5]'
    // (with nothing following the index in the path, so no later segment re-throws) silently
    // returns `undefined` instead of throwing, so the real out-of-range test above would now
    // fail (it asserts a BAD_OUTPUT throw).
    expect(() =>
      mutatedMapping.mapOutput(JSON.stringify({ issues: ['a', 'b'] }), {
        format: 'json',
        map: { id: '$.issues[5]' }
      })
    ).not.toThrow();
  });

  test('the parse.map type guard actually discriminates: disabling it lets a non-object map silently fall through', () => {
    const needle =
      "if (map !== undefined && (typeof map !== 'object' || map === null || Array.isArray(map))) {";
    expect(originalSource).toContain(needle);
    const mutated = originalSource.replace(needle, 'if (false) {');
    expect(mutated).not.toBe(originalSource);

    const mutatedMapping = loadMutant('parse-map-type-guard', mutated);
    // With the guard disabled, `map: 5` is still truthy so the `if (map)` branch runs, but
    // `Object.entries(5)` yields no entries, so the loop body never executes and mapOutput
    // returns an empty object instead of throwing BAD_OUTPUT — the real test above would now
    // fail.
    expect(() => mutatedMapping.mapOutput(JSON.stringify({ a: 1 }), { format: 'json', map: 5 })).not.toThrow();
  });

  test('the parse.statusMap type guard actually discriminates: disabling it lets explicit null bypass validation and silently skip status translation', () => {
    const needle =
      "if (statusMap !== undefined && (typeof statusMap !== 'object' || statusMap === null || Array.isArray(statusMap))) {";
    expect(originalSource).toContain(needle);
    const mutated = originalSource.replace(needle, 'if (false) {');
    expect(mutated).not.toBe(originalSource);

    const mutatedMapping = loadMutant('parse-statusmap-type-guard', mutated);
    // With the guard disabled, `statusMap: null` passes the (disabled) type check unrejected;
    // the later `if (statusMap && ...)` check is falsy for null, so the whole statusMap block
    // is skipped and the raw, untranslated status is returned instead of throwing BAD_OUTPUT —
    // the real test above would now fail.
    const result = mutatedMapping.mapOutput(JSON.stringify({ status: 'In Progress' }), {
      format: 'json',
      map: { status: '$.status' },
      statusMap: null
    });
    expect(result).toEqual({ status: 'In Progress' });
  });

  test('the malformed-segment regex guard actually discriminates: disabling it turns a bracket-only segment into a raw TypeError', () => {
    const needle = '    if (!match) {';
    expect(originalSource).toContain(needle);
    const mutated = originalSource.replace(needle, '    if (false) {');
    expect(mutated).not.toBe(originalSource);

    const mutatedMapping = loadMutant('malformed-segment-regex-guard', mutated);
    // With the guard disabled, a failed regex match (`match === null`) falls through to
    // `const [, name, indexChain] = match;`, which destructures `null` and throws a raw
    // TypeError with no `.code` — the real test above (asserting `.code === 'BAD_OUTPUT'`)
    // would now fail.
    let caught;
    try {
      mutatedMapping.resolvePath({ a: 1 }, '$.[0]');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect(caught.code).not.toBe('BAD_OUTPUT');
  });

  test('the non-traversable-current guard actually discriminates: disabling it turns a null base value into a raw TypeError', () => {
    const needle = "    if (current === null || typeof current !== 'object' || Array.isArray(current)) {";
    expect(originalSource).toContain(needle);
    const mutated = originalSource.replace(needle, '    if (false) {');
    expect(mutated).not.toBe(originalSource);

    const mutatedMapping = loadMutant('non-traversable-current-guard', mutated);
    // With the guard disabled, `Object.prototype.hasOwnProperty.call(null, 'a')` throws a raw
    // TypeError ("Cannot convert undefined or null to object") instead of the catch-all
    // "no property matching" BAD_OUTPUT — the real test above would now fail.
    let caught;
    try {
      mutatedMapping.mapOutput('null', { format: 'json', map: { x: '$.a' } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect(caught.code).not.toBe('BAD_OUTPUT');
  });

  test('the resolvePath path-validity guard actually discriminates: disabling it breaks all three malformed-path cases', () => {
    const needle = "  if (typeof path !== 'string' || path.length === 0 || path[0] !== '$') {";
    expect(originalSource).toContain(needle);
    const mutated = originalSource.replace(needle, '  if (false) {');
    expect(mutated).not.toBe(originalSource);

    const mutatedMapping = loadMutant('resolvepath-path-validity-guard', mutated);

    // Non-string path: `path.slice(1)` on a number throws a raw TypeError instead of BAD_OUTPUT.
    let nonStringCaught;
    try {
      mutatedMapping.resolvePath({ a: 1 }, 5);
    } catch (err) {
      nonStringCaught = err;
    }
    expect(nonStringCaught).toBeInstanceOf(TypeError);
    expect(nonStringCaught.code).not.toBe('BAD_OUTPUT');

    // Empty-string path: silently returns the base value instead of throwing.
    expect(mutatedMapping.resolvePath({ a: 1 }, '')).toEqual({ a: 1 });

    // Path not starting with "$": silently resolves a shifted path instead of throwing.
    expect(mutatedMapping.resolvePath({ b: 'wrong' }, 'a.b')).toBe('wrong');
  });

  test('the rest[0] !== "." guard actually discriminates: disabling it silently resolves a shifted segment instead of throwing', () => {
    const needle = "  if (rest[0] !== '.') {";
    expect(originalSource).toContain(needle);
    const mutated = originalSource.replace(needle, '  if (false) {');
    expect(mutated).not.toBe(originalSource);

    const mutatedMapping = loadMutant('rest0-dot-guard', mutated);
    // With the guard disabled, '$abc' (missing the '.' after '$') is no longer rejected; slicing
    // off the leading 'a' leaves 'bc', which resolves as a normal segment against { bc: 'oops' }
    // and silently succeeds instead of throwing — the real test above would now fail.
    expect(mutatedMapping.resolvePath({ bc: 'oops' }, '$abc')).toBe('oops');
  });

  test('the empty-segment guard actually discriminates: disabling it changes the error to a different, non-matching BAD_OUTPUT message', () => {
    const needle = "    if (segment === '') {";
    expect(originalSource).toContain(needle);
    const mutated = originalSource.replace(needle, '    if (false) {');
    expect(mutated).not.toBe(originalSource);

    const mutatedMapping = loadMutant('empty-segment-guard', mutated);
    // With the guard disabled, an empty segment reaches resolveSegment, whose own
    // malformed-segment regex guard (a different line) catches it instead, producing a
    // "malformed path segment ''" message rather than the "empty segment (recursive
    // descent...)" message the real test above asserts on.
    try {
      mutatedMapping.resolvePath({ a: {} }, '$.a.');
      throw new Error('expected resolvePath to throw');
    } catch (err) {
      expect(err.code).toBe('BAD_OUTPUT');
      expect(err.message).not.toMatch(/empty segment/);
      expect(err.message).toMatch(/malformed path segment ''/);
    }
  });

  test('the parse-must-be-an-object guard actually discriminates: disabling it changes the error for both a string and null parse', () => {
    const needle = "if (!parse || typeof parse !== 'object') {";
    expect(originalSource).toContain(needle);
    const mutated = originalSource.replace(needle, 'if (false) {');
    expect(mutated).not.toBe(originalSource);

    const mutatedMapping = loadMutant('parse-must-be-object-guard', mutated);

    // parse = null: destructuring `{ format } = null` throws a raw TypeError instead of
    // BAD_OUTPUT.
    let nullCaught;
    try {
      mutatedMapping.mapOutput('x', null);
    } catch (err) {
      nullCaught = err;
    }
    expect(nullCaught).toBeInstanceOf(TypeError);
    expect(nullCaught.code).not.toBe('BAD_OUTPUT');

    // parse = 'not-an-object': destructuring succeeds with all fields undefined, so the error
    // comes from the generic format guard instead, with a different message than the real test
    // above asserts on.
    try {
      mutatedMapping.mapOutput('x', 'not-an-object');
      throw new Error('expected mapOutput to throw');
    } catch (err) {
      expect(err.message).not.toMatch(/'parse' must be an object/);
      expect(err.message).toMatch(/parse\.format must be one of/);
    }
  });

  test('the parse.root string guard actually discriminates: disabling it lets a non-string root fall through to a differently worded error', () => {
    const needle = "  if (root !== undefined && typeof root !== 'string') {";
    expect(originalSource).toContain(needle);
    const mutated = originalSource.replace(needle, '  if (false) {');
    expect(mutated).not.toBe(originalSource);

    const mutatedMapping = loadMutant('parse-root-string-guard', mutated);
    // With the guard disabled, root=5 reaches resolvePath(parsed, 5) directly, whose own
    // path-validity guard (a different line) throws a differently worded BAD_OUTPUT instead of
    // the "parse.root must be a string" message the real test above asserts on.
    try {
      mutatedMapping.mapOutput(JSON.stringify({ a: 1 }), { format: 'json', root: 5, map: { x: '$.a' } });
      throw new Error('expected mapOutput to throw');
    } catch (err) {
      expect(err.code).toBe('BAD_OUTPUT');
      expect(err.message).not.toMatch(/parse\.root must be a string/);
      expect(err.message).toMatch(/dotted path must be a string/);
    }
  });

  test('the map-entry dottedPath string guard actually discriminates: disabling it loses the specific map-key naming', () => {
    const needle = "      if (typeof dottedPath !== 'string') {";
    expect(originalSource).toContain(needle);
    const mutated = originalSource.replace(needle, '      if (false) {');
    expect(mutated).not.toBe(originalSource);

    const mutatedMapping = loadMutant('map-entry-dottedpath-string-guard', mutated);
    // With the guard disabled, dottedPath=123 reaches resolvePath(baseValue, 123) directly,
    // whose own path-validity guard throws a generic, un-key-named BAD_OUTPUT instead of the
    // "parse.map['id']" message the real test above asserts on.
    try {
      mutatedMapping.mapOutput(JSON.stringify({ a: 1 }), { format: 'json', map: { id: 123 } });
      throw new Error('expected mapOutput to throw');
    } catch (err) {
      expect(err.code).toBe('BAD_OUTPUT');
      expect(err.message).not.toMatch(/parse\.map\['id'\]/);
      expect(err.message).toMatch(/dotted path must be a string/);
    }
  });

  test('the no-map object-copy branch actually discriminates: disabling it returns the parsed document by reference and mutates it', () => {
    const needle =
      "} else if (baseValue !== null && typeof baseValue === 'object' && !Array.isArray(baseValue)) {";
    expect(originalSource).toContain(needle);
    const mutated = originalSource.replace(needle, '} else if (false) {');
    expect(mutated).not.toBe(originalSource);

    const mutatedMapping = loadMutant('no-map-object-copy-branch', mutated);

    const parsedDocument = { status: 'In Progress', id: 'X-1' };
    const parseSpy = jest.spyOn(JSON, 'parse').mockReturnValueOnce(parsedDocument);

    const result = mutatedMapping.mapOutput('ignored because JSON.parse is mocked', {
      format: 'json',
      statusMap: { 'In Progress': 'in_progress' }
    });

    // With the copy branch disabled, result is the SAME object as the freshly parsed document,
    // so the statusMap mutation leaks into it directly: the real test above (which asserts
    // `result).not.toBe(parsedDocument)` and that `parsedDocument.status` stays untranslated)
    // would now fail.
    expect(result).toBe(parsedDocument);
    expect(parsedDocument.status).toBe('in_progress');

    parseSpy.mockRestore();
  });
});
