import {
  MAX_STEP_TIMEOUT_MS,
  WORKFLOW_SCHEMA_VERSION,
  WorkflowDiagnostic,
  WorkflowValidationInput,
  WorkflowValidationResult,
  stepIds,
  validateWorkflow,
} from "../src";

/**
 * REQ-BEH-004 / Story 2.1: package workflow data is validated before anything
 * interprets it.
 *
 * The property under test is not "bad YAML is caught". It is that the
 * validator refuses rather than copes. Every failure mode below has a
 * plausible-looking lenient alternative — skip the step kind it does not
 * recognise, interpret an unfamiliar schema version on a best-effort basis,
 * treat a missing prompt as an empty one, let a step ask for a tool its
 * behavior never declared — and each of those alternatives produces a run that
 * looks like it worked. A workflow that is 90% interpreted is the failure this
 * validator exists to prevent, so the assertions check that `workflow` is
 * withheld entirely, not merely that a warning appeared.
 */

const BEHAVIOR = "investigate-test-failure";

type RawStep = Record<string, unknown>;

interface RawWorkflow {
  schema_version: unknown;
  start: unknown;
  steps: RawStep[];
}

/**
 * A workflow that exercises all five step kinds and is fully reachable.
 *
 * Every rejection test below is this document plus one defect, so a
 * diagnostic can only be attributed to the thing the test changed.
 */
function baseWorkflow(): RawWorkflow {
  return {
    schema_version: WORKFLOW_SCHEMA_VERSION,
    start: "investigate",
    steps: [
      {
        id: "investigate",
        kind: "agent",
        prompt: "prompts/investigate.md",
        tools: ["read", "grep"],
        expect: "json",
        timeout: "10m",
        attempts: 2,
        max_output_bytes: 131072,
        inputs: { command: "${event.payload.command}" },
        on_failure: "gave-up",
      },
      {
        id: "confident",
        kind: "condition",
        left: "${steps.investigate.confidence}",
        operator: "in",
        right: ["high", "medium"],
        then: "approve-record",
        otherwise: "gave-up",
      },
      {
        id: "approve-record",
        kind: "approval",
        title: "Record this diagnosis?",
        message: "Diagnosis: ${steps.investigate.diagnosis}",
        on_approved: "record",
        on_declined: "gave-up",
      },
      {
        id: "record",
        kind: "command",
        command: "investigation.record",
        timeout: "30s",
        args: { diagnosis: "${steps.investigate.diagnosis}" },
        on_failure: "gave-up",
      },
      {
        id: "investigated",
        kind: "outcome",
        outcome: "test.failure.investigated",
        status: "succeeded",
        evidence: ["${steps.investigate.diagnosis}"],
      },
      {
        id: "gave-up",
        kind: "outcome",
        outcome: "test.failure.investigated",
        status: "inconclusive",
      },
    ],
  };
}

/** The base workflow with one targeted mutation applied. */
function build(mutate: (wf: RawWorkflow) => void = () => undefined): RawWorkflow {
  const wf = baseWorkflow();
  mutate(wf);
  return wf;
}

function step(wf: RawWorkflow, id: string): RawStep {
  const found = wf.steps.find((s) => s.id === id);
  if (!found) throw new Error(`test bug: base workflow has no step "${id}"`);
  return found;
}

/** Base workflow with `patch` merged into one step. */
function patched(id: string, patch: RawStep): RawWorkflow {
  return build((wf) => {
    Object.assign(step(wf, id), patch);
  });
}

/** Validates the base package with `overrides` swapped in. */
function validate(overrides: Partial<WorkflowValidationInput> = {}): WorkflowValidationResult {
  return validateWorkflow({
    behaviorName: BEHAVIOR,
    workflow: build(),
    behaviorTools: ["read", "grep", "glob", "ensemble.bash"],
    behaviorCommands: ["investigation.record"],
    declaredOutcomes: ["test.failure.investigated"],
    knownCommands: ["investigation.record", "fix.propose"],
    // `fix.propose` deliberately requires a capability that is not its own
    // ID, so the capability check cannot pass by comparing a name to itself.
    commandCapability: (id) => (id === "fix.propose" ? "fix.apply" : id),
    readPrompt: (path) => (path === "prompts/investigate.md" ? "# Investigate\n\nWhat failed, and why?\n" : undefined),
    ...overrides,
  });
}

/**
 * Asserts the shared contract of every rejection, then hands back the
 * diagnostics for a case-specific assertion.
 *
 * Two invariants ride along on every single rejection test rather than living
 * in one test of their own: no `workflow` is returned (so nothing partially
 * valid can reach the interpreter), and every diagnostic names the behavior
 * AND the step, which is the reporting half of REQ-BEH-004. A diagnostic that
 * says only "invalid workflow" cannot be acted on by whoever has to fix the
 * package.
 */
function reject(overrides: Partial<WorkflowValidationInput> = {}): readonly WorkflowDiagnostic[] {
  const result = validate(overrides);
  expect(result.valid).toBe(false);
  expect(result.workflow).toBeUndefined();
  expect(result.diagnostics.length).toBeGreaterThan(0);
  for (const diagnostic of result.diagnostics) {
    expect(diagnostic.behavior).toBe(BEHAVIOR);
    expect(diagnostic.step.length).toBeGreaterThan(0);
    expect(diagnostic.message.length).toBeGreaterThan(0);
  }
  return result.diagnostics;
}

/** The messages attributed to one step, joined so a single match covers them. */
function messagesFor(diagnostics: readonly WorkflowDiagnostic[], stepId: string): string {
  return diagnostics
    .filter((d) => d.step === stepId)
    .map((d) => d.message)
    .join(" | ");
}

describe("a valid workflow is accepted and handed on", () => {
  it("returns valid: true with the workflow payload", () => {
    const result = validate();

    // The positive case matters as much as the negative ones. A validator
    // that rejects everything satisfies every rejection test in this file and
    // is useless, and a package author reading only failures cannot tell
    // whether the rule is "no unreachable steps" or "no steps".
    expect(result.diagnostics).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.workflow).toBeDefined();
    expect(result.workflow?.start).toBe("investigate");
    expect(result.workflow?.schema_version).toBe(WORKFLOW_SCHEMA_VERSION);
    expect(stepIds(result.workflow!)).toEqual([
      "investigate",
      "confident",
      "approve-record",
      "record",
      "investigated",
      "gave-up",
    ]);
  });

  it("accepts a step timeout exactly at the runtime maximum", () => {
    // The bound is a maximum, not an exclusive limit. Getting this backwards
    // would make the documented ceiling unusable.
    expect(validate({ workflow: patched("investigate", { timeout: "30m" }) }).valid).toBe(true);
    expect(MAX_STEP_TIMEOUT_MS).toBe(30 * 60_000);
  });

  it("accepts a step that narrows its behavior's tool grant, including to nothing", () => {
    expect(validate({ workflow: patched("investigate", { tools: ["read"] }) }).valid).toBe(true);
    expect(validate({ workflow: patched("investigate", { tools: [] }) }).valid).toBe(true);
  });

  it("checks prompt existence only when a reader is injected", () => {
    // Without `readPrompt` the validator cannot know what is on disk, and it
    // says so by not claiming to have checked. This is the honest half of the
    // missing-prompt rule: the caller that can resolve files gets the
    // stricter validation, and the library default stays usable.
    expect(validate({ readPrompt: undefined }).valid).toBe(true);
  });
});

describe("unsupported constructs are rejected, never silently skipped", () => {
  it("rejects an unrecognised step kind and refuses the whole workflow", () => {
    const diagnostics = reject({ workflow: patched("approve-record", { kind: "escalate" }) });

    // REQ-BEH-002: skipping the step would run a workflow missing its human
    // gate while still reporting the outcome the author wrote, which is the
    // single most dangerous way to be lenient here.
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].step).toBe("approve-record");
    expect(diagnostics[0].message).toMatch(/unsupported step kind "escalate"/);
    expect(diagnostics[0].message).toMatch(/agent, command, condition, approval, outcome/);
  });

  it("names the offending step even when the kind is absent or not a string", () => {
    for (const kind of [undefined, 42, null]) {
      const diagnostics = reject({ workflow: patched("approve-record", { kind }) });
      expect(messagesFor(diagnostics, "approve-record")).toMatch(/unsupported step kind/);
    }
  });

  it("refuses an unknown schema_version rather than interpreting it best-effort", () => {
    const diagnostics = reject({
      workflow: build((wf) => {
        wf.schema_version = "2.0.0";
      }),
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].step).toBe("(workflow)");
    expect(diagnostics[0].message).toMatch(/unsupported workflow schema_version "2\.0\.0"/);
    expect(diagnostics[0].message).toContain(WORKFLOW_SCHEMA_VERSION);
  });

  it("stops at the version check instead of reporting on primitives it cannot interpret", () => {
    // A 2.0.0 workflow may legitimately use steps this runtime has never
    // heard of. Reporting those as errors would invite an author to "fix"
    // them by deleting the parts a newer runtime needs; the single honest
    // answer is that this runtime cannot read the document at all.
    const diagnostics = reject({
      workflow: build((wf) => {
        wf.schema_version = "2.0.0";
        wf.steps.push({ id: "parallel-fan-out", kind: "parallel", branches: ["a", "b"] });
      }),
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toMatch(/schema_version/);
  });

  it("refuses a missing schema_version", () => {
    const diagnostics = reject({
      workflow: build((wf) => {
        delete (wf as Partial<RawWorkflow>).schema_version;
      }),
    });
    expect(diagnostics[0].message).toMatch(/unsupported workflow schema_version undefined/);
  });

  it("refuses a workflow that is not a mapping, or has no steps", () => {
    for (const [workflow, expected] of [
      ["schema_version: 1.0.0", /must be a mapping, got string/],
      [null, /must be a mapping, got null/],
      [[], /must be a mapping, got object/],
    ] as const) {
      expect(messagesFor(reject({ workflow }), "(workflow)")).toMatch(expected);
    }

    const empty = reject({
      workflow: build((wf) => {
        wf.steps = [];
      }),
    });
    expect(messagesFor(empty, "(workflow)")).toMatch(/steps must be a non-empty array/);
  });
});

describe("step identity and control flow", () => {
  it("rejects a duplicate step id", () => {
    const diagnostics = reject({
      workflow: build((wf) => {
        wf.steps.push({ id: "gave-up", kind: "outcome", outcome: "test.failure.investigated", status: "failed" });
      }),
    });

    // Two steps sharing an ID make `${steps.gave-up}` ambiguous and let the
    // second silently shadow the first depending on map ordering.
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].step).toBe("gave-up");
    expect(diagnostics[0].message).toBe("duplicate step id");
  });

  it("rejects a step with a missing or empty id", () => {
    for (const id of [undefined, "", 7]) {
      const diagnostics = reject({
        workflow: build((wf) => {
          wf.steps.push({ id, kind: "outcome", outcome: "test.failure.investigated", status: "failed" });
        }),
      });
      expect(messagesFor(diagnostics, "(workflow)")).toMatch(/every step requires a non-empty string 'id'/);
    }
  });

  it("rejects a start that does not name a declared step", () => {
    const diagnostics = reject({
      workflow: build((wf) => {
        wf.start = "investigage";
      }),
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].step).toBe("(workflow)");
    expect(diagnostics[0].message).toMatch(/start must name a declared step; got "investigage"/);
  });

  const danglingEdges: ReadonlyArray<{ field: string; owner: string; patch: RawStep }> = [
    { field: "then", owner: "confident", patch: { then: "typo" } },
    { field: "otherwise", owner: "confident", patch: { otherwise: "typo" } },
    { field: "on_approved", owner: "approve-record", patch: { on_approved: "typo" } },
    { field: "on_declined", owner: "approve-record", patch: { on_declined: "typo" } },
    { field: "on_failure", owner: "investigate", patch: { on_failure: "typo" } },
  ];

  it.each(danglingEdges)("rejects $field naming an undeclared step", ({ field, owner, patch }) => {
    // Each of these is a control-flow edge. A dangling edge discovered at run
    // time strands the workflow mid-execution, with whatever effects the
    // earlier steps already performed left in place.
    const diagnostics = reject({ workflow: patched(owner, patch) });
    expect(messagesFor(diagnostics, owner)).toContain(`'${field}' names "typo", which is not a declared step`);
  });

  it("reports unreachable steps", () => {
    const diagnostics = reject({
      workflow: build((wf) => {
        wf.steps.push({
          id: "orphan",
          kind: "outcome",
          outcome: "test.failure.investigated",
          status: "blocked",
        });
      }),
    });

    // Dead package data is usually a rename that missed one reference, so the
    // path the author believes is live is not the path that runs.
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].step).toBe("orphan");
    expect(diagnostics[0].message).toBe("step is unreachable from 'start'");
  });

  it("rejects a workflow with no outcome step, because it has no terminal state", () => {
    const diagnostics = reject({
      workflow: {
        schema_version: WORKFLOW_SCHEMA_VERSION,
        start: "investigate",
        steps: [
          { id: "investigate", kind: "agent", prompt: "prompts/investigate.md", tools: ["read"], expect: "json" },
          {
            id: "again",
            kind: "condition",
            left: "${steps.investigate.confidence}",
            operator: "exists",
            then: "investigate",
            otherwise: "investigate",
          },
        ],
      },
    });

    // Without a terminal state the interpreter has to invent one, and an
    // invented outcome is indistinguishable from a declared one downstream.
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].step).toBe("(workflow)");
    expect(diagnostics[0].message).toMatch(/declares no 'outcome' step, so it has no terminal state/);
  });
});

describe("conditions branch on validated references, not on prose", () => {
  it("rejects a condition whose left-hand side is a literal", () => {
    const diagnostics = reject({ workflow: patched("confident", { left: "high" }) });

    // A literal left-hand side makes the branch constant: the author has
    // written a decision and dressed it as a test of one.
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].step).toBe("confident");
    expect(diagnostics[0].message).toMatch(/'left' "high" is a literal; a condition must branch on a \$\{\.\.\.\} reference/);
  });

  it("rejects a condition with a missing or non-string left", () => {
    for (const left of [undefined, "", { path: "steps.investigate" }]) {
      const diagnostics = reject({ workflow: patched("confident", { left }) });
      expect(messagesFor(diagnostics, "confident")).toMatch(/requires 'left' referencing a validated prior result/);
    }
  });

  it("rejects `in` without an array right-hand side", () => {
    for (const right of ["high", undefined, { high: true }]) {
      const diagnostics = reject({ workflow: patched("confident", { right }) });
      expect(messagesFor(diagnostics, "confident")).toMatch(/operator "in" requires 'right' to be an array/);
    }
  });

  it("rejects equals/not_equals with no right-hand side to compare against", () => {
    for (const operator of ["equals", "not_equals"]) {
      const diagnostics = reject({ workflow: patched("confident", { operator, right: undefined }) });
      expect(messagesFor(diagnostics, "confident")).toContain(`operator "${operator}" requires 'right'`);
    }
  });

  it("rejects an operator outside the supported set", () => {
    const diagnostics = reject({ workflow: patched("confident", { operator: "matches", right: "high|medium" }) });

    // `matches` is the natural request and the one that must not exist: a
    // regex over model prose is exactly the "inspect what the model said"
    // capability the condition primitive is defined to exclude.
    expect(messagesFor(diagnostics, "confident")).toMatch(/unsupported operator "matches"/);
    expect(messagesFor(diagnostics, "confident")).toMatch(/equals, not_equals, in, exists, not_exists/);
  });
});

describe("references stay inside the closed scope", () => {
  it("rejects a ${steps.X} reference to an undeclared step", () => {
    const diagnostics = reject({
      workflow: patched("investigate", { inputs: { prior: "${steps.triage.summary}" } }),
    });

    expect(messagesFor(diagnostics, "investigate")).toContain(
      'reference ${steps.triage.summary} names step "triage", which is not declared',
    );
  });

  it.each(["env.OPENAI_API_KEY", "process.env.HOME", "secrets.token", "globalThis.fetch"])(
    "rejects a reference rooted outside the closed scope: %s",
    (path) => {
      // The reference grammar is substitution over four roots. Anything else
      // would let package data read ambient process state, which is how a
      // manifest stops being data.
      const diagnostics = reject({ workflow: patched("investigate", { inputs: { leak: `\${${path}}` } }) });
      const root = path.split(".")[0];
      expect(messagesFor(diagnostics, "investigate")).toContain(
        `reference \${${path}} has root "${root}", not one of [event, steps, behavior, workspace]`,
      );
    },
  );

  it("finds references wherever they appear in a step, not just in inputs", () => {
    // `collectReferences` walks the whole step. A validator that checked only
    // the fields it expected to hold references would pass a bad binding
    // hidden in command args or outcome evidence.
    const inArgs = reject({ workflow: patched("record", { args: { diagnosis: "${steps.nope.value}" } }) });
    expect(messagesFor(inArgs, "record")).toMatch(/names step "nope", which is not declared/);

    const inEvidence = reject({ workflow: patched("investigated", { evidence: ["${steps.nope.value}"] }) });
    expect(messagesFor(inEvidence, "investigated")).toMatch(/names step "nope", which is not declared/);

    const inMessage = reject({ workflow: patched("approve-record", { message: "Approve ${steps.nope.value}?" }) });
    expect(messagesFor(inMessage, "approve-record")).toMatch(/names step "nope", which is not declared/);
  });
});

describe("a step may narrow its behavior's grants, never widen them", () => {
  it("rejects an agent step requesting a tool the behavior does not declare", () => {
    const diagnostics = reject({ workflow: patched("investigate", { tools: ["read", "bash"] }) });

    // If a step could widen, `capabilities.tools` would be advisory, and the
    // manifest an operator reads to decide whether to trust the package would
    // no longer describe what the package can do.
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].step).toBe("investigate");
    expect(diagnostics[0].message).toContain('tool "bash" is not in the behavior\'s capabilities.tools');
    expect(diagnostics[0].message).toContain("[read, grep, glob, ensemble.bash]");
    expect(diagnostics[0].message).toMatch(/a step may narrow a grant but never widen it/);
  });

  it("reports every widened tool, not just the first", () => {
    const diagnostics = reject({ workflow: patched("investigate", { tools: ["bash", "write", "read"] }) });
    expect(messagesFor(diagnostics, "investigate")).toContain('tool "bash"');
    expect(messagesFor(diagnostics, "investigate")).toContain('tool "write"');
  });

  it("rejects a behavior with no tools at all granting one to a step", () => {
    const diagnostics = reject({ behaviorTools: [] });
    expect(messagesFor(diagnostics, "investigate")).toContain("capabilities.tools [none]");
  });

  it("rejects a tools field that is missing or not an array of strings", () => {
    expect(messagesFor(reject({ workflow: patched("investigate", { tools: undefined }) }), "investigate")).toMatch(
      /agent step requires a 'tools' array/,
    );
    expect(messagesFor(reject({ workflow: patched("investigate", { tools: [7] }) }), "investigate")).toMatch(
      /every entry in 'tools' must be a string/,
    );
  });
});

describe("command bindings fail closed", () => {
  it("rejects a command step naming an unregistered command", () => {
    const diagnostics = reject({ workflow: patched("record", { command: "fix.apply" }) });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].step).toBe("record");
    expect(diagnostics[0].message).toContain('command "fix.apply" is not registered');
    expect(diagnostics[0].message).toContain("[investigation.record, fix.propose]");
  });

  it("refuses every command step when no registry knowledge was supplied", () => {
    // Fail closed, not open: with an empty catalog the tempting reading is
    // "the caller did not tell me, so assume it is fine". That assumption
    // defers an unknown-command failure to run time, after the steps before
    // it have already had their effects.
    const diagnostics = reject({ knownCommands: [] });
    expect(messagesFor(diagnostics, "record")).toContain("known commands are [none]");
  });

  it("rejects a command whose required capability the behavior does not declare", () => {
    const diagnostics = reject({
      workflow: patched("record", { command: "fix.propose", args: {} }),
    });

    // The capability is the command's, not the step's, and the behavior must
    // have declared it. `fix.propose` requires `fix.apply` here precisely so
    // the check cannot pass by the ID matching itself.
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].step).toBe("record");
    expect(diagnostics[0].message).toContain('command "fix.propose" requires capability "fix.apply"');
    expect(diagnostics[0].message).toContain("(capabilities.commands: [investigation.record])");
  });

  it("rejects a registered command when the behavior declares no commands at all", () => {
    const diagnostics = reject({ behaviorCommands: [] });
    expect(messagesFor(diagnostics, "record")).toContain("(capabilities.commands: [none])");
  });

  it("rejects a command step with a missing command or non-mapping args", () => {
    expect(messagesFor(reject({ workflow: patched("record", { command: undefined }) }), "record")).toMatch(
      /command step requires 'command' naming a registered command/,
    );
    expect(messagesFor(reject({ workflow: patched("record", { args: ["diagnosis"] }) }), "record")).toMatch(
      /'args' must be a mapping/,
    );
  });
});

describe("prompt references are resolved and read, not assumed", () => {
  it("rejects a missing prompt file", () => {
    const diagnostics = reject({ readPrompt: () => undefined });

    // REQ-BEH-003: the prompt is the step's actual instruction. A package
    // whose prompt file was renamed must fail visibly, not run the agent with
    // an empty instruction and report whatever came back.
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].step).toBe("investigate");
    expect(diagnostics[0].message).toBe("prompt file 'prompts/investigate.md' is missing or unreadable");
  });

  it("rejects an empty or whitespace-only prompt file", () => {
    for (const contents of ["", "   \n\t  \n"]) {
      const diagnostics = reject({ readPrompt: () => contents });
      expect(messagesFor(diagnostics, "investigate")).toBe("prompt file 'prompts/investigate.md' is empty");
    }
  });

  it("rejects a prompt path that escapes the package", () => {
    for (const prompt of ["/etc/passwd", "../../../.ssh/id_rsa", "prompts/../../secrets.md"]) {
      const diagnostics = reject({ workflow: patched("investigate", { prompt }) });
      expect(messagesFor(diagnostics, "investigate")).toMatch(
        /must be a package-relative path without '\.\.'/,
      );
    }
  });

  it("rejects a missing or empty prompt reference", () => {
    for (const prompt of [undefined, "", 42]) {
      const diagnostics = reject({ workflow: patched("investigate", { prompt }) });
      expect(messagesFor(diagnostics, "investigate")).toMatch(
        /agent step requires 'prompt' naming a package-relative prompt file/,
      );
    }
  });
});

describe("bounds are enforced, not merely declared (REQ-SAFE-007)", () => {
  it("rejects an unparseable timeout", () => {
    for (const timeout of ["soon", "10 minutes", "-5s", "5", "1d"]) {
      const diagnostics = reject({ workflow: patched("investigate", { timeout }) });
      expect(messagesFor(diagnostics, "investigate")).toContain(
        `'timeout' ${JSON.stringify(timeout)} is not a duration such as '90s' or '5m'`,
      );
    }
  });

  it("rejects a timeout that is not a string", () => {
    const diagnostics = reject({ workflow: patched("investigate", { timeout: 600 }) });
    expect(messagesFor(diagnostics, "investigate")).toMatch(/'timeout' must be a duration string such as '90s'/);
  });

  it("rejects a non-positive timeout", () => {
    for (const timeout of ["0s", "0ms", "0h"]) {
      const diagnostics = reject({ workflow: patched("investigate", { timeout }) });
      expect(messagesFor(diagnostics, "investigate")).toMatch(/'timeout' must be greater than zero/);
    }
  });

  it("rejects a timeout above the runtime maximum", () => {
    // A package cannot opt out of bounding by declaring a larger number; the
    // ceiling belongs to the runtime.
    const diagnostics = reject({ workflow: patched("investigate", { timeout: "31m" }) });
    expect(messagesFor(diagnostics, "investigate")).toBe(
      `'timeout' 31m exceeds the runtime maximum of ${MAX_STEP_TIMEOUT_MS}ms`,
    );
  });

  it("rejects an attempt budget outside 1..3", () => {
    for (const attempts of [0, 4, -1, "2"]) {
      const diagnostics = reject({ workflow: patched("investigate", { attempts }) });
      expect(messagesFor(diagnostics, "investigate")).toMatch(/'attempts' must be a number between 1 and 3/);
    }
  });

  it("rejects a non-positive output bound", () => {
    for (const max_output_bytes of [0, -1, "131072"]) {
      const diagnostics = reject({ workflow: patched("investigate", { max_output_bytes }) });
      expect(messagesFor(diagnostics, "investigate")).toMatch(/'max_output_bytes' must be a positive number/);
    }
  });

  it("rejects an agent step with no declared response contract", () => {
    for (const expected of [undefined, "prose", "yaml"]) {
      const diagnostics = reject({ workflow: patched("investigate", { expect: expected }) });
      expect(messagesFor(diagnostics, "investigate")).toMatch(/requires 'expect' of "json" or "text"/);
    }
  });
});

describe("declared outcomes are the only outcomes", () => {
  it("rejects an outcome not present in the manifest's outcomes", () => {
    const diagnostics = reject({ workflow: patched("investigated", { outcome: "test.failure.repaired" }) });

    // `outcomes` is the manifest's public contract with whoever consumes the
    // run. A step concluding with an undeclared one emits a result no
    // downstream subscriber agreed to receive.
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].step).toBe("investigated");
    expect(diagnostics[0].message).toBe(
      'outcome "test.failure.repaired" is not declared in the manifest\'s outcomes [test.failure.investigated]',
    );
  });

  it("rejects an outcome when the manifest declares none", () => {
    expect(messagesFor(reject({ declaredOutcomes: [] }), "investigated")).toContain("outcomes [none]");
  });

  it("rejects a missing outcome name", () => {
    for (const outcome of [undefined, "", 3]) {
      expect(messagesFor(reject({ workflow: patched("investigated", { outcome }) }), "investigated")).toBe(
        "outcome step requires 'outcome'",
      );
    }
  });

  it("rejects a terminal status outside the supported set", () => {
    const diagnostics = reject({ workflow: patched("investigated", { status: "cancelled" }) });
    expect(messagesFor(diagnostics, "investigated")).toBe(
      "'status' must be one of [succeeded, inconclusive, blocked, failed]; got \"cancelled\"",
    );
  });
});

describe("diagnostics identify behavior and step (REQ-BEH-004)", () => {
  it("attributes every problem in a multiply-broken workflow to its own step", () => {
    const result = validate({
      behaviorName: "broken-package",
      workflow: build((wf) => {
        Object.assign(step(wf, "investigate"), { tools: ["bash"], timeout: "never" });
        Object.assign(step(wf, "confident"), { left: "yes" });
        Object.assign(step(wf, "record"), { command: "rm.rf" });
        Object.assign(step(wf, "investigated"), { outcome: "made.up" });
      }),
    });

    expect(result.valid).toBe(false);
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.behavior).toBe("broken-package");
    }

    // One defect never suppresses the report of an unrelated one: an author
    // fixing a package one round-trip per error is an author who stops
    // reading the diagnostics.
    const offenders = new Set(result.diagnostics.map((d) => d.step));
    expect(offenders).toEqual(new Set(["investigate", "confident", "record", "investigated"]));
    expect(messagesFor(result.diagnostics, "investigate")).toMatch(/tool "bash"/);
    expect(messagesFor(result.diagnostics, "investigate")).toMatch(/'timeout'/);
    expect(messagesFor(result.diagnostics, "confident")).toMatch(/is a literal/);
    expect(messagesFor(result.diagnostics, "record")).toMatch(/is not registered/);
    expect(messagesFor(result.diagnostics, "investigated")).toMatch(/is not declared in the manifest's outcomes/);
  });

  it("uses the documented (workflow) sentinel for whole-workflow problems", () => {
    // Whole-workflow problems still need a step field, and the sentinel says
    // "this belongs to no single step" rather than blaming an arbitrary one.
    const diagnostics = reject({
      workflow: build((wf) => {
        wf.start = "nowhere";
      }),
    });
    expect(diagnostics.every((d) => d.step === "(workflow)")).toBe(true);
  });
});
