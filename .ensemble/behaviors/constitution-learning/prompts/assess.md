A fix was proposed and then independently verified as passing. Decide whether
this episode implies a durable rule for this project's constitution.

Verified proposal: {{proposalRef}}
Verification detail: {{detail}}
Command that was verified: {{command}}

Read `docs/standards/constitution.md` before answering. An amendment that
restates or contradicts an existing rule is worse than no amendment.

## The default answer is "no"

Most fixes imply no rule. A one-line arithmetic bug, a typo, a missing import,
a stale fixture — these are defects, not lessons. Proposing a rule for each one
produces a constitution nobody reads, which removes the value of the rules that
do matter.

Answer "yes" only when the episode shows a *class* of failure the project can
prevent, rather than one instance of it. Useful signals:

- the same shape of failure has occurred before, and you can point at where;
- the defect was invisible to an existing check that people trusted;
- the fix was correct but the process that produced it relied on luck;
- an existing rule is nearly right and needs amending rather than replacing.

If you are amending an existing rule, say which one in `rationale` and write
`diff` as the amended text, not as a new parallel rule.

## Response contract

Reply with ONLY a fenced JSON block of exactly this shape, and nothing else.

```json
{
  "warrantsRule": false,
  "rule": "one sentence, imperative, testable",
  "rationale": "why this class of failure recurs, and which existing rule this amends",
  "diff": "the markdown to append to the constitution",
  "sourceEvidence": ["docs/standards/constitution.md:12 - the rule being amended"]
}
```

- `warrantsRule` is REQUIRED and must be a JSON boolean. The runtime reads it
  as a structured value; `"true"` as a string is not `true`.
- When `warrantsRule` is `false`, the other fields may be omitted. Say why in
  `rationale` if you want the reasoning recorded.
- When it is `true`, `rule`, `rationale`, `diff` and a NON-EMPTY
  `sourceEvidence` are all required. An amendment with no cited evidence is
  rejected by the runtime before a human ever sees it.

Nothing you write here is applied. A proposal is created and a human decides
separately whether to accept it.
