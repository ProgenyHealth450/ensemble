# Extract checkable claims from changed documentation

The repository just changed. Find documentation claims that can be checked
**mechanically**, and propose them. You are not deciding whether they hold —
a command does that, against the real tree. Your job is to find them and,
crucially, to leave out the ones that would produce a false alarm.

## What to propose

Emit claims of exactly these kinds:

- `path` — a repository file or directory the prose says exists, e.g.
  `packages/agent-core/src/behavior/compiler.ts`. Shorthand that omits a
  leading `packages/` is fine; the checker resolves it.
- `npm-script` — a script the reader is told to run, as in `npm run validate`.
  Propose the script name alone (`validate`).
- `symbol` — an exported function, class, interface or type named in prose.
  Propose the bare identifier.

Include the document path as `source` for every claim, so a failure names the
file a human has to open.

## What to leave out, and why this matters more than what to include

A checker that cries wolf gets ignored, and then the one real finding is lost
with the rest. Measured on this repository's own architecture docs, a naive
extraction reported 30 of 31 claims as broken and nearly all were correct. So
exclude:

- **Historical references.** A document describing something that *used to*
  exist is not wrong. `cqrs-gap-report.md` names `autofix-loop.ts` and
  `behavior-runner.ts`, both deliberately deleted; those are accurate accounts
  of a previous state, not stale claims.
- **Illustrative examples.** `src/math.js` in a worked example is not a claim
  that the file exists.
- **External things.** URLs, other repositories, npm package names, binaries
  on `PATH`. The checker only knows this tree.
- **Anything hedged.** If the prose says "if present in your checkout", the
  author already declined to claim it. Do not launder a hedge into an
  assertion — one of the fabrications that motivated this behavior was exactly
  that hedge wrapped around a CLI that never existed.
- **Generic words.** A symbol claim on `compile` is useful; one on `run` or
  `get` will match something irrelevant and prove nothing.

If a document contains nothing checkable, say so and propose no claims. An
empty list is a real answer, and the command reports it as "nothing checked"
rather than as a pass.

## Why the split exists

These claims are adjudicated mechanically and separately. That is deliberate:
the fabrications that motivated this behavior included invented line citations,
produced by grepping a file *after* inserting a note and then reading that note
back as corroboration. A proposer that also adjudicates is marking its own
homework, and will confirm whatever it already believes.

So propose generously within the rules above, and let the checker decide.

## Output

Return JSON:

```json
{
  "claims": [
    { "kind": "path", "value": "packages/agent-core/src/behavior/compiler.ts", "source": "docs/architecture/guide.md" },
    { "kind": "npm-script", "value": "validate", "source": "docs/architecture/guide.md" }
  ]
}
```
