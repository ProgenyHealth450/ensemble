import { FieldSchema, checkSchema, formatViolations } from "../src";

/**
 * The structural schema validator behind REQ-CQRS-001 and REQ-CQRS-005.
 *
 * Two properties carry almost all of its value. The first is that an object
 * schema is *closed*: an unrecognised key is a violation, because a command
 * argument is far more often misspelled than deliberately extended, and a
 * dropped `--dry-run` reads as a request to actually do the thing. The second
 * is that violations name the value they are about, since a malformed-command
 * report that says only "invalid" leaves the caller to bisect its own payload.
 *
 * The rest — type checks, bounds — is ordinary, but it is the part a refactor
 * is most likely to loosen, so each constraint is exercised on both sides of
 * its boundary rather than only on a value that is obviously wrong.
 */

describe("checkSchema accepts and rejects each declared type", () => {
  const cases: Array<[string, FieldSchema, unknown[], unknown[]]> = [
    ["string", { type: "string" }, ["", "hello"], [1, true, null, [], {}, undefined]],
    ["number", { type: "number" }, [0, -3, 1.5], ["1", true, null, [], {}, NaN]],
    ["boolean", { type: "boolean" }, [true, false], ["true", 0, 1, null, {}]],
    ["array", { type: "array", items: { type: "string" } }, [[], ["a", "b"]], ["a", {}, null, 3]],
    ["object", { type: "object", fields: {} }, [{}], [null, [], "x", 3, true]],
    ["record", { type: "record", values: { type: "number" } }, [{}, { a: 1 }], [null, [], "x", 3]],
  ];

  it.each(cases)("%s", (_name, schema, accepted, rejected) => {
    for (const value of accepted) {
      expect(checkSchema(schema, value)).toEqual({ valid: true, violations: [] });
    }
    for (const value of rejected) {
      expect(checkSchema(schema, value).valid).toBe(false);
    }
  });

  /**
   * `unknown` is the escape hatch for payloads whose shape belongs to a
   * handler rather than to the catalog. It has to accept everything, including
   * the values every other type rejects, or it would not be an escape hatch.
   */
  it("lets `unknown` through whatever it is given", () => {
    const schema: FieldSchema = { type: "unknown" };
    for (const value of [null, undefined, 0, "", [], {}, { nested: [1, 2] }]) {
      expect(checkSchema(schema, value).valid).toBe(true);
    }
  });

  /**
   * `null` and arrays are both `typeof "object"`, which is the single most
   * common way a hand-written structural check lets a malformed payload
   * through. An array reaching an object field usually means a caller sent a
   * list where a map was expected, and treating it as an empty object would
   * report every declared field as missing instead of naming the real mistake.
   */
  it("names the actual type when null or an array arrives where an object is required", () => {
    const object: FieldSchema = { type: "object", fields: { a: { type: "string" } } };
    const record: FieldSchema = { type: "record", values: { type: "string" } };

    expect(checkSchema(object, null).violations[0].message).toBe("expected object, got null");
    expect(checkSchema(object, []).violations[0].message).toBe("expected object, got array");
    expect(checkSchema(record, null).violations[0].message).toBe("expected object, got null");
    expect(checkSchema(record, ["a"]).violations[0].message).toBe("expected object, got array");
    expect(checkSchema({ type: "array", items: { type: "string" } }, null).violations[0].message).toBe(
      "expected array, got null",
    );
  });
});

describe("checkSchema treats an object schema as closed", () => {
  const schema: FieldSchema = {
    type: "object",
    fields: { name: { type: "string" }, dryRun: { type: "boolean" } },
    optional: ["dryRun"],
  };

  /**
   * The whole reason this validator exists rather than a permissive one. If
   * `dry_run` were ignored as an unknown key, the command would run with
   * `dryRun` defaulted to false — the caller asked for a rehearsal and got the
   * real mutation, and nothing in the result would say so. Rejecting the
   * payload as malformed is the only outcome that surfaces the typo.
   */
  it("rejects a misspelled argument instead of defaulting it away", () => {
    const result = checkSchema(schema, { name: "deploy", dry_run: true });

    expect(result.valid).toBe(false);
    expect(result.violations).toEqual([
      { path: "dry_run", message: "unknown field is not permitted by this schema" },
    ]);
  });

  it("reports every unknown key, not just the first", () => {
    const result = checkSchema(schema, { name: "deploy", dry_run: true, verbosity: 2 });

    expect(result.violations.map((v) => v.path)).toEqual(["dry_run", "verbosity"]);
  });

  /**
   * A missing required field and an unknown extra field are usually the same
   * typo seen from two sides, and reporting only one of them sends the caller
   * round the loop twice.
   */
  it("reports a missing required field alongside the unknown one that replaced it", () => {
    const result = checkSchema(schema, { nme: "deploy" });

    expect(result.violations).toEqual([
      { path: "name", message: "required field is missing" },
      { path: "nme", message: "unknown field is not permitted by this schema" },
    ]);
  });

  it("accepts a payload that omits only optional fields", () => {
    expect(checkSchema(schema, { name: "deploy" }).valid).toBe(true);
    expect(checkSchema(schema, { name: "deploy", dryRun: false }).valid).toBe(true);
  });

  /**
   * A key present with the value `undefined` is what a caller building the
   * payload with `{ dryRun: opts.dryRun }` produces when the option was not
   * supplied. Reading that as absence rather than as a value of the wrong type
   * keeps the diagnostic pointed at something the caller can act on.
   */
  it("reads an explicitly undefined value as absence", () => {
    expect(checkSchema(schema, { name: "deploy", dryRun: undefined }).valid).toBe(true);
    expect(checkSchema(schema, { name: undefined, dryRun: true }).violations).toEqual([
      { path: "name", message: "required field is missing" },
    ]);
  });

  /**
   * Presence is checked before the value is, so even a field that would accept
   * anything still has to be supplied. Otherwise `unknown` would quietly mean
   * "optional" and the two concepts could not be expressed separately.
   */
  it("requires a field declared `unknown` to be present", () => {
    const withUnknown: FieldSchema = { type: "object", fields: { payload: { type: "unknown" } } };

    expect(checkSchema(withUnknown, {}).violations).toEqual([
      { path: "payload", message: "required field is missing" },
    ]);
    expect(checkSchema(withUnknown, { payload: null }).valid).toBe(true);
  });
});

describe("checkSchema points at the value it is complaining about", () => {
  const schema: FieldSchema = {
    type: "object",
    fields: {
      name: { type: "string", minLength: 1 },
      steps: {
        type: "array",
        items: {
          type: "object",
          fields: {
            id: { type: "string" },
            retries: { type: "number", integer: true, min: 0 },
          },
          optional: ["retries"],
        },
      },
      env: { type: "record", values: { type: "string" } },
    },
  };

  /**
   * A command catalog entry is nested several levels deep, and "invalid input"
   * on a payload with a dozen steps is not a diagnostic — it is a prompt to go
   * and bisect. Dotted keys and bracketed indices let the report be read back
   * against the structure that produced it.
   */
  it("reports nested failures with the path that reaches them", () => {
    const result = checkSchema(schema, {
      name: "deploy",
      steps: [{ id: "build" }, { id: 7, retries: 1.5 }],
      env: { REGION: "us-east-1", RETRIES: 3 },
    });

    expect(result.valid).toBe(false);
    expect(result.violations.map((v) => v.path)).toEqual([
      "steps[1].id",
      "steps[1].retries",
      "env.RETRIES",
    ]);
  });

  it("reports a missing field at its own path, not its parent's", () => {
    const result = checkSchema(schema, { name: "deploy", steps: [{}], env: {} });

    expect(result.violations).toEqual([{ path: "steps[0].id", message: "required field is missing" }]);
  });

  /**
   * The root has no name to print, and an empty prefix would render as a bare
   * `: expected object, got null`. `(root)` is what makes the line readable
   * when the whole payload, rather than one field of it, is the problem.
   */
  it("renders the root as (root) and joins violations in order", () => {
    expect(formatViolations(checkSchema({ type: "object", fields: {} }, null).violations)).toBe(
      "(root): expected object, got null",
    );

    const result = checkSchema(schema, { name: "", steps: "all", env: {} });
    expect(formatViolations(result.violations)).toBe(
      "name: expected at least 1 character(s), got 0; steps: expected array, got string",
    );
    expect(formatViolations([])).toBe("");
  });
});

describe("checkSchema enforces the declared constraints", () => {
  /**
   * These bounds are the difference between a schema that documents intent and
   * one that enforces it. Each is checked just inside and just outside its
   * limit, because an off-by-one in a bound is invisible to a test that only
   * supplies obviously-wrong values.
   */
  it("restricts a string to its enum", () => {
    const schema: FieldSchema = { type: "string", enum: ["propose", "apply"] };

    expect(checkSchema(schema, "apply").valid).toBe(true);
    expect(checkSchema(schema, "Apply").valid).toBe(false);
    expect(checkSchema(schema, "").violations[0].message).toBe(
      'expected one of [propose, apply], got ""',
    );
  });

  it("enforces minLength at the boundary", () => {
    const schema: FieldSchema = { type: "string", minLength: 3 };

    expect(checkSchema(schema, "abc").valid).toBe(true);
    expect(checkSchema(schema, "ab").valid).toBe(false);
    expect(checkSchema({ type: "string", minLength: 1 }, "").violations[0].message).toBe(
      "expected at least 1 character(s), got 0",
    );
  });

  it("enforces a pattern", () => {
    const schema: FieldSchema = { type: "string", pattern: "^[a-z][a-z0-9-]*$" };

    expect(checkSchema(schema, "build-app").valid).toBe(true);
    expect(checkSchema(schema, "Build").valid).toBe(false);
    expect(checkSchema(schema, "Build").violations[0].message).toBe(
      "expected to match /^[a-z][a-z0-9-]*$/",
    );
  });

  it("applies every string constraint, not only the first that is declared", () => {
    const schema: FieldSchema = { type: "string", enum: ["a", "bb"], minLength: 2 };

    expect(checkSchema(schema, "bb").valid).toBe(true);
    expect(checkSchema(schema, "a").valid).toBe(false);
  });

  it("rejects a non-integer where an integer is required", () => {
    const schema: FieldSchema = { type: "number", integer: true };

    expect(checkSchema(schema, 4).valid).toBe(true);
    expect(checkSchema(schema, -4).valid).toBe(true);
    expect(checkSchema(schema, 4.5).violations[0].message).toBe("expected an integer, got 4.5");
  });

  it("enforces numeric min and max inclusively", () => {
    const schema: FieldSchema = { type: "number", min: 1, max: 10 };

    expect(checkSchema(schema, 1).valid).toBe(true);
    expect(checkSchema(schema, 10).valid).toBe(true);
    expect(checkSchema(schema, 0).violations[0].message).toBe("expected >= 1, got 0");
    expect(checkSchema(schema, 11).violations[0].message).toBe("expected <= 10, got 11");
  });

  /**
   * `min: 0` and `max: 0` are the cases a truthiness check silently drops, and
   * zero is exactly the bound a count or a retry budget tends to declare.
   */
  it("honours a bound of zero", () => {
    expect(checkSchema({ type: "number", min: 0 }, -1).valid).toBe(false);
    expect(checkSchema({ type: "number", min: 0 }, 0).valid).toBe(true);
    expect(checkSchema({ type: "number", max: 0 }, 1).valid).toBe(false);
    expect(checkSchema({ type: "number", max: 0 }, 0).valid).toBe(true);
  });

  it("enforces minItems and maxItems at the boundary", () => {
    const schema: FieldSchema = { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 };

    expect(checkSchema(schema, ["a"]).valid).toBe(true);
    expect(checkSchema(schema, ["a", "b"]).valid).toBe(true);
    expect(checkSchema(schema, []).violations[0].message).toBe("expected at least 1 item(s), got 0");
    expect(checkSchema(schema, ["a", "b", "c"]).violations[0].message).toBe(
      "expected at most 2 item(s), got 3",
    );
  });

  /**
   * A cardinality failure and an element failure answer different questions,
   * and a caller told only "too many items" will trim the list rather than fix
   * the element that was the wrong shape all along.
   */
  it("reports element violations alongside a cardinality violation", () => {
    const schema: FieldSchema = { type: "array", items: { type: "string" }, maxItems: 1 };
    const result = checkSchema(schema, ["a", 2]);

    expect(result.violations.map((v) => v.path)).toEqual(["", "[1]"]);
    expect(formatViolations(result.violations)).toBe(
      "(root): expected at most 1 item(s), got 2; [1]: expected string, got number",
    );
  });

  /**
   * A record's keys are open — that is what distinguishes it from an object —
   * but its values are not, so the check has to reach every entry rather than
   * stopping at the first.
   */
  it("validates every value of a record while accepting any key", () => {
    const schema: FieldSchema = { type: "record", values: { type: "number", min: 0 } };

    expect(checkSchema(schema, { a: 0, "weird key": 3 }).valid).toBe(true);
    expect(checkSchema(schema, { a: -1, b: 2, c: "x" }).violations.map((v) => v.path)).toEqual([
      "a",
      "c",
    ]);
  });

  it("carries constraints through nested containers", () => {
    const schema: FieldSchema = {
      type: "record",
      values: { type: "array", items: { type: "string", enum: ["read", "write"] } },
    };

    expect(checkSchema(schema, { alpha: ["read"], beta: [] }).valid).toBe(true);
    expect(checkSchema(schema, { alpha: ["read", "exec"] }).violations.map((v) => v.path)).toEqual([
      "alpha[1]",
    ]);
  });
});
