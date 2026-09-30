/**
 * A deliberately tiny structural schema validator.
 *
 * REQ-CQRS-001 requires every command descriptor to declare an input and a
 * result schema, and REQ-CQRS-005 requires agent-provided event payloads to be
 * schema-validated. Both need a validator that is:
 *
 *   - dependency-free, because agent-core is the provider-neutral core and
 *     must not drag a JSON Schema engine into every adapter (REQ-RUN-004);
 *   - deterministic, because schemas participate in behavior digests;
 *   - closed, because "unknown field" has to be an error rather than a
 *     silently-ignored typo. A command whose argument name is misspelled must
 *     be `malformed`, not accepted with a missing value (REQ-CQRS-003).
 *
 * It is not JSON Schema and does not pretend to be. It covers exactly the
 * shapes the command catalog uses. Anything richer belongs in a handler's own
 * precondition check, where the failure can be explained in domain terms.
 */

export type FieldSchema =
  | { type: "string"; enum?: readonly string[]; minLength?: number; pattern?: string }
  | { type: "number"; integer?: boolean; min?: number; max?: number }
  | { type: "boolean" }
  | { type: "array"; items: FieldSchema; minItems?: number; maxItems?: number }
  | { type: "object"; fields: Record<string, FieldSchema>; optional?: readonly string[] }
  | { type: "record"; values: FieldSchema }
  | { type: "unknown" };

export interface SchemaViolation {
  /** Dotted path to the offending value, `""` for the root. */
  readonly path: string;
  readonly message: string;
}

export interface SchemaCheck {
  readonly valid: boolean;
  readonly violations: readonly SchemaViolation[];
}

const OK: SchemaCheck = { valid: true, violations: [] };

function fail(path: string, message: string): SchemaCheck {
  return { valid: false, violations: [{ path, message }] };
}

function merge(checks: SchemaCheck[]): SchemaCheck {
  const violations = checks.flatMap((c) => c.violations);
  return violations.length === 0 ? OK : { valid: false, violations };
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function checkSchema(schema: FieldSchema, value: unknown, path = ""): SchemaCheck {
  switch (schema.type) {
    case "unknown":
      return OK;

    case "string": {
      if (typeof value !== "string") return fail(path, `expected string, got ${describe(value)}`);
      if (schema.enum && !schema.enum.includes(value)) {
        return fail(path, `expected one of [${schema.enum.join(", ")}], got "${value}"`);
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        return fail(path, `expected at least ${schema.minLength} character(s), got ${value.length}`);
      }
      if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
        return fail(path, `expected to match /${schema.pattern}/`);
      }
      return OK;
    }

    case "number": {
      if (typeof value !== "number" || Number.isNaN(value)) {
        return fail(path, `expected number, got ${describe(value)}`);
      }
      if (schema.integer && !Number.isInteger(value)) return fail(path, `expected an integer, got ${value}`);
      if (schema.min !== undefined && value < schema.min) return fail(path, `expected >= ${schema.min}, got ${value}`);
      if (schema.max !== undefined && value > schema.max) return fail(path, `expected <= ${schema.max}, got ${value}`);
      return OK;
    }

    case "boolean":
      return typeof value === "boolean" ? OK : fail(path, `expected boolean, got ${describe(value)}`);

    case "array": {
      if (!Array.isArray(value)) return fail(path, `expected array, got ${describe(value)}`);
      // Cardinality and element shape are independent facts, and neither
      // makes the other unknowable. Returning early on the count would send a
      // caller back for a second round trip to discover that an element was
      // the wrong type all along -- the same reason the object branch reports
      // missing and unknown fields together instead of first-wins.
      const checks: SchemaCheck[] = [];
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        checks.push(fail(path, `expected at least ${schema.minItems} item(s), got ${value.length}`));
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        checks.push(fail(path, `expected at most ${schema.maxItems} item(s), got ${value.length}`));
      }
      checks.push(...value.map((item, i) => checkSchema(schema.items, item, `${path}[${i}]`)));
      return merge(checks);
    }

    case "record": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return fail(path, `expected object, got ${describe(value)}`);
      }
      return merge(
        Object.entries(value as Record<string, unknown>).map(([k, v]) =>
          checkSchema(schema.values, v, join(path, k)),
        ),
      );
    }

    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return fail(path, `expected object, got ${describe(value)}`);
      }
      const record = value as Record<string, unknown>;
      const optional = new Set(schema.optional ?? []);
      const checks: SchemaCheck[] = [];

      for (const [key, fieldSchema] of Object.entries(schema.fields)) {
        if (!(key in record) || record[key] === undefined) {
          if (!optional.has(key)) checks.push(fail(join(path, key), "required field is missing"));
          continue;
        }
        checks.push(checkSchema(fieldSchema, record[key], join(path, key)));
      }

      // Closed by design. An unexpected key is far more often a misspelled
      // expected one than a deliberate extension, and silently dropping it
      // turns a typo into a command that ran with a default.
      for (const key of Object.keys(record)) {
        if (!(key in schema.fields)) {
          checks.push(fail(join(path, key), "unknown field is not permitted by this schema"));
        }
      }

      return merge(checks);
    }
  }
}

/** Renders violations as one line, ordered, for a result reason or diagnostic. */
export function formatViolations(violations: readonly SchemaViolation[]): string {
  return violations.map((v) => `${v.path || "(root)"}: ${v.message}`).join("; ");
}
