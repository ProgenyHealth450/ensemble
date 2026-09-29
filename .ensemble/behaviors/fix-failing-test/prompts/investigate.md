A test in this repository is failing. Diagnose it and, if you can, produce a
candidate patch.

Failing command: {{command}}

```
{{failureOutput}}
```

You are READ-ONLY. You have no tool that can change this repository, and you
are not being asked to apply anything. Your reply IS the deliverable: a
diagnosis, and optionally a candidate patch that a human will review before
anything touches the tree.

Rules, in priority order:

1. **Never propose editing a test to make it pass.** If the test encodes the
   wrong expectation, say so in `diagnosis` and return no `writes`. A test
   edited into agreement with broken code destroys the only evidence that the
   code is broken.

2. **Change the narrowest responsible source file.** Do not refactor
   surrounding code, rename symbols, or improve anything the failure did not
   point at.

3. **Do not weaken the check.** Deleting an assertion, loosening a matcher,
   adding a `try`/`catch` that swallows, or skipping the test are failures of
   this task, not solutions to it.

4. **If you cannot find a real fix, say so.** Return your diagnosis with no
   `writes` and a `confidence` of `low` or `inconclusive`. A wrong fix that
   makes the suite green is worse than an unfixed test, because the next
   person inherits a passing suite over broken behaviour.

5. **Report the confidence you actually have.** `confidence` is read by the
   runtime as a structured value and decides whether a proposal is created at
   all. Overstating it does not make a patch more likely to be accepted; it
   makes a wrong patch more likely to reach a human's review queue.

## Response contract

Reply with ONLY a fenced JSON block of exactly this shape, and nothing else.

```json
{
  "diagnosis": "one paragraph: what is broken and why the test fails",
  "confidence": "high | medium | low | inconclusive",
  "evidence": ["path/to/file.ts:42 - what you found there"],
  "writes": [
    { "path": "relative/path/from/repo/root.ts", "contents": "<ENTIRE new file contents>" }
  ]
}
```

- `diagnosis` and `confidence` are REQUIRED. A reply missing either is
  discarded, and the step is retried once before the run ends inconclusive.
- `writes` is OPTIONAL. Omit it entirely when you have no patch; do not send
  an empty array with a confident diagnosis and do not invent a change to
  have something to return.
- `contents` must be the COMPLETE new file, not a diff and not an excerpt.
- Paths are relative to the repository root and may not contain `..`.

This contract is enforced by the runtime, not by good faith: a reply that
does not parse as JSON of this shape is rejected without being read for
meaning, however correct its prose may be.
