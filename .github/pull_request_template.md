## Summary

<!-- What changes and why. -->

## Checklist

- [ ] Size is within ~400 changed hand-written lines (generated output excluded), or the overage is justified here:
- [ ] A new component (package, plugin, hook, guard) has its own PR and is not bundled into a refactor or audit PR
- [ ] For any removed or renamed command, skill, agent or CLI flag: consumers checked (sibling repos, `packages/pi`, `packages/codex`, `packages/opencode`) and a deprecated shim left, or the consumer change merges in the same window
- [ ] Generated artifacts regenerated (`npm run generate` and the pi/codex/opencode generators) and committed
- [ ] `npm run ci:local` run before pushing
- [ ] Every deferred review finding is classified under the `pr-review-cycle` stopping rule (blocking vs. bead for opt-in/best-effort):
