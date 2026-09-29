import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Exit gate 0, first half (`br-behavior-runtime-cqrs-xl24.4`): ONE dispatch
 * path.
 *
 * The defect being locked out is specific and was observed live. A single
 * `test.failure.observed` envelope started two things at once: the governed
 * invoker, which correctly refused to write under `mode: propose`, and a
 * continuation that called `pi.sendUserMessage` so the user's own agent made
 * the repair with the user's own tools. Both ran. The governed path had been
 * dead for three days and nobody noticed, because the continuation always
 * "worked" (br-dowt, br-cxn8, br-boam).
 *
 * §7 of the CQRS requirements is explicit that merging them silently, or
 * keeping both behind a flag, is not acceptable. So this test reads the
 * runtime source and asserts the second path is absent rather than merely
 * disabled. It is a source-level assertion on purpose: a behavioural test can
 * only prove the second path did not fire in the scenario it happened to set
 * up, and the original bug was precisely that the second path fired in
 * scenarios nobody had set up.
 */

const SRC = join(__dirname, "..", "src");

function sourceFiles(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) sourceFiles(abs, into);
    else if (entry.endsWith(".ts")) into.push(abs);
  }
  return into;
}

/** Source with comments stripped: the ban is on CODE, and the history is discussed in prose. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the continuation path is gone, not defaulted off", () => {
  const files = sourceFiles(SRC);

  it("no runtime code sends a user message to perform behavior work", () => {
    // `sendUserMessage` is how the continuation made the host model do the
    // mutation. behavior-loader.ts still uses it to deliver a behavior's own
    // prompt when a human invokes its slash command, which is a different
    // thing: it is user-initiated and performs no dispatch.
    const offenders = files.filter(
      (f) => !f.endsWith("behavior-loader.ts") && /sendUserMessage/.test(code(f)),
    );
    expect(offenders).toEqual([]);
  });

  it("no runtime code queues work onto a later turn", () => {
    const offenders = files.filter((f) => /continuationQueue|enqueueContinuation/.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it("no whole-tree restore survives in the interactive workspace", () => {
    // REQ-SAFE-005 forbids `git checkout -- .` as routine rollback: it
    // discards the user's concurrent edits along with the candidate, and then
    // reports `restored: true` for files it never captured.
    const offenders = files.filter((f) => /restoreWorkingTree|snapshotWorkingTree/.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it("dispatch names no behavior", () => {
    // Exit gate 2's second half, checked here because it is the same property:
    // if the runtime knows what `fix-failing-test` is, a new behavior needs
    // TypeScript again and acceptance criterion 1 is lost.
    const names = ["fix-failing-test", "investigate-test-failure", "constitution-learning"];
    const offenders: string[] = [];
    for (const file of files) {
      const body = code(file);
      for (const name of names) {
        if (body.includes(name)) offenders.push(`${file}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no special-case branch on a test-failure event type remains in dispatch", () => {
    // The adapter used to branch on `test.failure.observed` to decide whether
    // to queue a repair. Detection is now a package trigger, not a runtime if.
    const offenders = files
      .filter((f) => f.endsWith("extension.ts") || f.endsWith("workflow-dispatch.ts"))
      .filter((f) => /["']test\.failure\.observed["']/.test(code(f)));
    expect(offenders).toEqual([]);
  });
});
