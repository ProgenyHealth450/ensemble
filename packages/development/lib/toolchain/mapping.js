'use strict';

/**
 * Output mapping engine (TRD-2026-8d825f54 TRD-012, PRD REQ-002, REQ-022).
 *
 * `mapOutput(stdout, parse)` is the second half of the runner's output pipeline described in
 * the TRD's System Architecture ("Interfaces and Formats": `capabilities{<id>: {run[],
 * parse{format, root, map{}, statusMap{}}}}`): it turns one tool invocation's raw `stdout`
 * string into a plain JavaScript value using only the information already declared in an
 * adapter manifest's `parse` block, with no new runtime dependency (TRD interpretation I6).
 * It never spawns a process, never reads an adapter manifest itself and never validates the
 * mapped value against a normalized JSON schema — schema validation against
 * `packages/development/toolchain/schemas/normalized/*.json` is wired into `runCapability`
 * (TRD-011, a sibling task in `./runner.js`) via Ajv, using this module's return value as its
 * input. Do not add process-spawning or schema-validation code here.
 *
 * `parse` shape (as declared on one adapter manifest capability):
 * ```
 * parse = {
 *   format: 'json' | 'lines' | 'text',
 *   root?: string,                    // dotted path, json format only; default '$'
 *   map?: { <outKey>: <dottedPath> }, // field projection against the (root-projected) value
 *   statusMap?: { <rawValue>: <normalizedValue> }
 * }
 * ```
 *
 * ## Format handling
 *
 * - `'json'`: `stdout` is parsed with `JSON.parse`. A parse failure is never a raw
 *   `SyntaxError`; it is wrapped into a `BAD_OUTPUT`-coded error naming that the JSON was
 *   malformed. The parsed value is then projected through `root` (default `'$'`, meaning "the
 *   whole parsed value") using the dotted-path resolver below; `map`, when present, is applied
 *   against that root-projected value, so a `map` path's own leading `$` refers to the
 *   root-projected value, not necessarily the raw parsed document (this matches the TRD's
 *   Implementation AC example, which supplies no `root` and expects `map` paths such as
 *   `$.issues[0].key` to resolve against the whole parsed document).
 * - `'lines'`: `stdout` is split on `\n`; a single trailing empty element produced by a final
 *   newline is trimmed, then every remaining empty line is dropped, leaving an array of
 *   non-empty line strings, one per record. `root` is not applicable to this format (there is
 *   no JSON document to project a sub-root from) and is ignored if supplied. `map`, when
 *   present, is applied against this array of lines (for example `$[0]` for the first line);
 *   when `map` is omitted, the array of lines is returned directly, unwrapped.
 * - `'text'`: the whole trimmed `stdout` string is the single value; no JSON parsing happens.
 *   `root` is ignored, as for `'lines'`. `map`, when present, is applied against the trimmed
 *   string (for example `$` to copy it verbatim into an output key); when `map` is omitted,
 *   the trimmed string is returned directly.
 *
 * ## `map` field projection
 *
 * For each `<outKey>: <dottedPath>` entry in `map`, `result[outKey]` is set to the dotted path
 * resolved against the format-appropriate base value described above. Every path must resolve
 * to a present value or `mapOutput` throws a `BAD_OUTPUT`-coded error naming the path and the
 * first segment that could not be found — there is no "resolve to undefined and move on"
 * behavior, matching this module's fail-closed requirement.
 *
 * ## `statusMap` value translation
 *
 * After `map` (or the bare parsed value, when `map` is omitted) produces a plain object result
 * with its own `status` property, and `statusMap` is supplied, the raw value at `result.status`
 * is looked up in `statusMap`: if present, `result.status` is replaced with the mapped value;
 * if absent, `mapOutput` throws a `BAD_OUTPUT`-coded error naming the unmapped raw value (TRD-012
 * Implementation AC 2: "an unmapped value yields BAD_OUTPUT naming the value"). When the result
 * has no `status` property at all, `statusMap` (if supplied) is simply unused — this is not an
 * error, since not every capability's normalized shape has a status.
 *
 * ## Dotted-path grammar (`resolvePath`)
 *
 * Supported, exactly:
 * - `$` alone resolves to the whole base value.
 * - `$.<segment>(.<segment>)*` walks one or more `.`-separated segments into the base value.
 * - `$[<N>](.[<N>])*`-style direct index chains immediately after `$` (no name), e.g. `$[0]`,
 *   index into the base value itself when it is an array, before any named segment.
 * - A segment is `<name>` optionally followed by one or more `[<N>]` array-index suffixes
 *   (e.g. `issues[0]`, `a[0][1]`): `<name>` looks up an own, enumerable property of a plain
 *   object (never an array, never a `null`/primitive value — walking into one of those with a
 *   named segment is a `BAD_OUTPUT` error), then each `[<N>]` indexes into the resulting array
 *   in turn (indexing a non-array, or an out-of-range index, is also `BAD_OUTPUT`).
 * - A segment may instead be an alternation `<nameA>|<nameB>` (TRD interpretation I6, "array or
 *   object"): each alternative (itself optionally carrying its own `[<N>]` suffixes, e.g.
 *   `issues[0]|issue[0]`) is tried left-to-right against the current value; the first
 *   alternative whose `<name>` is present wins. This is exactly the two-alternative example the
 *   TRD gives (`$.issues|issue`, "try `.issues` then fall back to `.issue`"); nothing prevents
 *   more than two `|`-separated alternatives, but only two are ever exercised by this repo's
 *   fixtures or tests.
 *
 * Deliberately NOT supported (document rather than silently misinterpret): wildcards (`*`),
 * recursive descent (`..`), slice expressions, filter/script expressions (`[?(...)]`),
 * negative array indices, indexing a plain object by a numeric-looking key (only arrays accept
 * `[N]`), and property names that themselves contain `.`, `|`, `[` or `]` (there is no quoting
 * or escaping syntax). This is intentionally a small path language, not a JSONPath
 * implementation (TRD interpretation I6: no new runtime dependency).
 *
 * ## Known limits
 *
 * `mapOutput` never mutates its `stdout` argument; for `'json'` with `map` it always builds a
 * fresh `result` object, and for the no-`map` case it returns a shallow clone of a plain-object
 * parsed value (so a subsequent `statusMap` translation never mutates data the caller might
 * still hold a reference to) but returns arrays and primitive values (from `'lines'`/`'text'`,
 * or a `'json'` value whose root/map resolves to a non-object) as-is, since there is nothing to
 * safely clone-and-translate for those shapes and no documented `status` translation applies
 * to them.
 *
 * `statusMap` lookup is a plain `Object.prototype.hasOwnProperty` check on the raw string value
 * found at `result.status`; it does not coerce types (a numeric or boolean raw status is looked
 * up by its own type, not stringified first) and does not fall back to a default when the key
 * is merely absent from `statusMap` — that is always `BAD_OUTPUT`, per the TRD's explicit
 * "an unmapped value yields BAD_OUTPUT" requirement.
 */

const SEGMENT_PATTERN = /^([^[\]|]+)((?:\[\d+\])*)$/;
const INDEX_PATTERN = /\[(\d+)\]/g;
const LEADING_INDEX_PATTERN = /^\[(\d+)\]/;

/**
 * Build a `BAD_OUTPUT`-coded error. Every error thrown by this module goes through here so no
 * raw `SyntaxError`/`TypeError` from `JSON.parse` or a failed property/index lookup ever
 * escapes this module uncoded.
 *
 * @param {string} message human-readable message naming what was expected and what was found
 * @returns {Error} an `Error` with `.code = 'BAD_OUTPUT'`
 */
function badOutputError(message) {
  const err = new Error(message);
  err.code = 'BAD_OUTPUT';
  return err;
}

/**
 * Describe a value's "shape" for an error message (`null` reported distinctly from `object`).
 * @param {unknown} value
 * @returns {string}
 */
function describeType(value) {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

/**
 * Index into an array value with a non-negative integer, per the dotted-path grammar's `[N]`
 * suffix. Indexing a non-array, or an out-of-range index, is `BAD_OUTPUT`.
 *
 * @param {unknown} current the value a `[N]` suffix is being applied to
 * @param {number} idx the parsed index
 * @param {string} path the full original path, for error messages
 * @returns {unknown}
 */
function indexInto(current, idx, path) {
  if (!Array.isArray(current)) {
    throw badOutputError(
      `mapOutput: path '${path}' indexes '[${idx}]' into a non-array value (found ${describeType(current)})`
    );
  }
  if (idx < 0 || idx >= current.length || current[idx] === undefined) {
    throw badOutputError(
      `mapOutput: path '${path}' index '[${idx}]' is out of bounds (array length ${current.length})`
    );
  }
  return current[idx];
}

/**
 * Resolve one `.`-separated segment (optionally a `|`-alternation of candidates, each
 * optionally carrying its own `[N]` index suffixes) against the current value.
 *
 * @param {unknown} current
 * @param {string} segment raw segment text, e.g. `'issues[0]'` or `'issues|issue'`
 * @param {string} path the full original path, for error messages
 * @returns {unknown}
 */
function resolveSegment(current, segment, path) {
  const candidates = segment.split('|');
  for (const candidate of candidates) {
    const match = SEGMENT_PATTERN.exec(candidate);
    if (!match) {
      throw badOutputError(`mapOutput: malformed path segment '${candidate}' in path '${path}'`);
    }
    const [, name, indexChain] = match;
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(current, name)) {
      continue;
    }
    let value = current[name];
    let match2;
    INDEX_PATTERN.lastIndex = 0;
    // eslint-disable-next-line no-cond-assign
    while ((match2 = INDEX_PATTERN.exec(indexChain)) !== null) {
      value = indexInto(value, Number(match2[1]), path);
    }
    return value;
  }
  throw badOutputError(`mapOutput: path '${path}' has no property matching '${segment}' on the resolved value`);
}

/**
 * Resolve a dotted path (see the module header's "Dotted-path grammar" section) against a base
 * value. Exported separately from `mapOutput` so the path grammar can be unit-tested in
 * isolation.
 *
 * @param {unknown} value the base value the path is resolved against
 * @param {string} path a dotted path such as `'$'`, `'$.a.b[0]'` or `'$.issues|issue'`
 * @returns {unknown}
 */
function resolvePath(value, path) {
  if (typeof path !== 'string' || path.length === 0 || path[0] !== '$') {
    throw badOutputError(`mapOutput: dotted path must be a string starting with '$', got ${JSON.stringify(path)}`);
  }

  let rest = path.slice(1);
  let current = value;

  let leadingMatch;
  // eslint-disable-next-line no-cond-assign
  while ((leadingMatch = LEADING_INDEX_PATTERN.exec(rest)) !== null) {
    current = indexInto(current, Number(leadingMatch[1]), path);
    rest = rest.slice(leadingMatch[0].length);
  }

  if (rest === '') {
    return current;
  }
  if (rest[0] !== '.') {
    throw badOutputError(`mapOutput: malformed path '${path}': expected '.' after '$' or an index chain`);
  }

  const segments = rest.slice(1).split('.');
  for (const segment of segments) {
    if (segment === '') {
      throw badOutputError(`mapOutput: malformed path '${path}': empty segment (recursive descent '..' is not supported)`);
    }
    current = resolveSegment(current, segment, path);
  }
  return current;
}

/**
 * Map one tool invocation's raw stdout into a plain value, per `parse` (see module header).
 *
 * @param {string} stdout raw stdout captured from the executed tool
 * @param {{format: 'json'|'lines'|'text', root?: string, map?: Record<string,string>, statusMap?: Record<string,string>}} parse
 * @returns {unknown} the mapped value (an object when `map` is supplied, otherwise the
 *   format-appropriate parsed value)
 */
function mapOutput(stdout, parse) {
  if (!parse || typeof parse !== 'object') {
    throw badOutputError(`mapOutput: 'parse' must be an object, got ${describeType(parse)}`);
  }
  const { format, root, map, statusMap } = parse;
  if (format !== 'json' && format !== 'lines' && format !== 'text') {
    throw badOutputError(`mapOutput: parse.format must be one of 'json'|'lines'|'text', got ${JSON.stringify(format)}`);
  }
  if (root !== undefined && typeof root !== 'string') {
    throw badOutputError(`mapOutput: parse.root must be a string when present, got ${describeType(root)}`);
  }
  if (map !== undefined && (typeof map !== 'object' || map === null || Array.isArray(map))) {
    throw badOutputError(`mapOutput: parse.map must be an object when present, got ${describeType(map)}`);
  }
  if (statusMap !== undefined && (typeof statusMap !== 'object' || statusMap === null || Array.isArray(statusMap))) {
    throw badOutputError(`mapOutput: parse.statusMap must be an object when present, got ${describeType(statusMap)}`);
  }

  let baseValue;
  if (format === 'json') {
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (err) {
      throw badOutputError(`mapOutput: malformed JSON stdout (${err.message})`);
    }
    baseValue = resolvePath(parsed, root === undefined ? '$' : root);
  } else if (format === 'lines') {
    const rawLines = String(stdout).split('\n');
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
      rawLines.pop();
    }
    baseValue = rawLines.filter((line) => line.length > 0);
  } else {
    baseValue = String(stdout).trim();
  }

  let result;
  if (map) {
    result = {};
    for (const [outKey, dottedPath] of Object.entries(map)) {
      if (typeof dottedPath !== 'string') {
        throw badOutputError(`mapOutput: parse.map['${outKey}'] must be a dotted-path string, got ${describeType(dottedPath)}`);
      }
      result[outKey] = resolvePath(baseValue, dottedPath);
    }
  } else if (baseValue !== null && typeof baseValue === 'object' && !Array.isArray(baseValue)) {
    result = { ...baseValue };
  } else {
    result = baseValue;
  }

  if (
    statusMap &&
    result !== null &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    Object.prototype.hasOwnProperty.call(result, 'status')
  ) {
    const rawStatus = result.status;
    if (!Object.prototype.hasOwnProperty.call(statusMap, rawStatus)) {
      throw badOutputError(`mapOutput: status value ${JSON.stringify(rawStatus)} has no entry in parse.statusMap`);
    }
    result.status = statusMap[rawStatus];
  }

  return result;
}

module.exports = {
  mapOutput,
  resolvePath
};
