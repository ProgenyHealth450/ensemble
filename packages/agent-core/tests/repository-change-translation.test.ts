import { translateRepositoryChange } from "../src/behavior/event-translator";
import { BehaviorEvent } from "../src/events";

/**
 * br-gpha needed `repository.changed` to exist, because a behavior on an
 * unproduced trigger is inert no matter how correct the rest of it is — the
 * failure this repo has hit repeatedly (br-jgxo, br-d7lm).
 */

const toolCall = (command: string, extra: Record<string, unknown> = {}): BehaviorEvent =>
  ({
    id: "e1",
    source: "pi",
    occurredAt: new Date().toISOString(),
    type: "runtime.tool_call.completed",
    payload: { command, ...extra },
  }) as BehaviorEvent;

describe("a command that changes the repository is recognised", () => {
  it.each(["git commit -m x", "git merge main", "git rebase main", "git revert HEAD", "git cherry-pick abc", "git apply p.patch"])(
    "translates %s",
    (command) => {
      expect(translateRepositoryChange(toolCall(command))?.type).toBe("repository.changed");
    },
  );

  it.each(["git checkout -b feature", "git switch -c feature"])("recognises branch creation: %s", (command) => {
    expect(translateRepositoryChange(toolCall(command))?.type).toBe("repository.branch.created");
  });

  it("keeps branch creation distinct from a content change", () => {
    // A new branch changes no files. Collapsing the two would make a
    // doc-claim behavior re-verify the tree every time someone branched.
    expect(translateRepositoryChange(toolCall("git checkout -b x"))?.type).not.toBe("repository.changed");
  });
});

describe("it does not fire on things that are not repository changes", () => {
  it.each(["git status", "git log", "git diff", "npm test", "echo git commit"])("ignores %s", (command) => {
    expect(translateRepositoryChange(toolCall(command))).toBeUndefined();
  });

  it("is anchored to command position, so prose mentioning a command is not one", () => {
    // Same rule as isTestCommand: matching the whole line would let a message
    // that merely contains "git commit" be read as a commit.
    expect(translateRepositoryChange(toolCall("echo 'run git commit next'"))).toBeUndefined();
  });

  it("ignores a command that failed, because a rejected commit changed nothing", () => {
    expect(translateRepositoryChange(toolCall("git commit -m x", { isError: true }))).toBeUndefined();
  });

  it("ignores events that are not tool calls", () => {
    const event = { ...toolCall("git commit -m x"), type: "runtime.session.started" } as BehaviorEvent;

    expect(translateRepositoryChange(event)).toBeUndefined();
  });
});

describe("the derived event carries what a consumer needs", () => {
  it("includes the command and cwd", () => {
    const derived = translateRepositoryChange(toolCall("git commit -m x", { cwd: "/repo" }));

    expect(derived?.payload).toMatchObject({ command: "git commit -m x", cwd: "/repo" });
  });

  it("is normalized, so it has an id and a timestamp like any other event", () => {
    const derived = translateRepositoryChange(toolCall("git commit -m x"));

    expect(derived?.id).toBeTruthy();
    expect(derived?.occurredAt).toBeTruthy();
  });
});
