A test is failing. Diagnose it. Do not propose a patch — this behavior
observes and reports, and has no command that could apply one.

Failing command: {{command}}

```
{{failureOutput}}
```

Read the sources the failure points at before concluding. A diagnosis written
from the stack trace alone is a guess with a citation.

Say plainly when the evidence does not support a conclusion. `inconclusive` is
a real and useful answer: it records that the failure was seen and not
understood, which is strictly better than a confident wrong cause that the
next reader takes as established.

## Response contract

Reply with ONLY a fenced JSON block of exactly this shape, and nothing else.

```json
{
  "diagnosis": "one paragraph: what is broken and why the test fails",
  "confidence": "high | medium | low | inconclusive",
  "evidence": ["path/to/file.ts:42 - what you found there"]
}
```

`diagnosis` and `confidence` are required. `evidence` may be an empty array,
but each entry that is present must point at something a reader can open.

This contract is enforced by the runtime: a reply that does not parse as JSON
of this shape is rejected without being read for meaning.
