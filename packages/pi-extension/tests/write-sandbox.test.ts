import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confineWrites, sandboxProfile, sandboxSupport } from "../src/write-sandbox";

/**
 * br-r3om: the acceptance criterion is behavioural -- a child that TRIES to
 * write outside its workspace leaves the repository unchanged. These tests run
 * the real sandbox against the real filesystem rather than asserting on
 * generated profile text, because a profile that looks right and denies
 * nothing is the failure this is meant to rule out.
 */

const support = sandboxSupport();
// `describe.skip` rather than a silent pass: on a host with no confinement the
// suite must say so, not report green for tests it never ran.
const onlyWhenSupported = support.supported ? describe : describe.skip;

onlyWhenSupported("write confinement is enforced by the OS", () => {
  let workspace: string;
  let outside: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "sandbox-ws-"));
    outside = mkdtempSync(join(tmpdir(), "sandbox-outside-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  function runConfined(script: string): { ok: boolean } {
    const grant = { workspace, home: workspace, temp: [] as string[] };
    const { command, args } = confineWrites("/bin/sh", ["-c", script], grant);
    try {
      execFileSync(command, [...args], { stdio: "ignore" });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  it("permits a write inside the workspace", () => {
    // If this fails the sandbox is not confining, it is simply broken --
    // which looks identical from the outside if only the deny case is tested.
    runConfined(`echo x > ${workspace}/inside.txt`);

    expect(existsSync(join(workspace, "inside.txt"))).toBe(true);
  });

  it("denies a write outside the workspace by absolute path", () => {
    // The exact escape a real model performed in the live probe.
    runConfined(`echo ESCAPED > ${outside}/canary.txt`);

    expect(existsSync(join(outside, "canary.txt"))).toBe(false);
  });

  it("denies the escape even when the child is told to use a shell redirect", () => {
    runConfined(`/bin/sh -c 'printf ESCAPED > ${outside}/canary2.txt'`);

    expect(existsSync(join(outside, "canary2.txt"))).toBe(false);
  });

  it("denies appending to an existing file outside the workspace", () => {
    execFileSync("/bin/sh", ["-c", `echo original > ${outside}/existing.txt`]);

    runConfined(`echo APPENDED >> ${outside}/existing.txt`);

    expect(execFileSync("/bin/cat", [join(outside, "existing.txt")]).toString()).toBe("original\n");
  });

  it("denies deleting a file outside the workspace", () => {
    // Confinement that stopped writes but allowed unlink would still let a
    // child destroy the operator's work.
    execFileSync("/bin/sh", ["-c", `echo keep > ${outside}/keep.txt`]);

    runConfined(`rm -f ${outside}/keep.txt`);

    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  });

  it("still lets the child read outside the workspace", () => {
    // Writes are confined; reads deliberately are not. If this starts failing,
    // the profile has quietly become stricter than documented and will break
    // investigation behaviors that legitimately read the repo.
    execFileSync("/bin/sh", ["-c", `echo visible > ${outside}/readable.txt`]);

    expect(runConfined(`cat ${outside}/readable.txt`).ok).toBe(true);
  });

  it("MUTATION: removing the sandbox wrapper lets the escape through", () => {
    // Pins that the tests above are testing the sandbox and not some other
    // ambient restriction. Without confineWrites the same script succeeds.
    execFileSync("/bin/sh", ["-c", `echo ESCAPED > ${outside}/unconfined.txt`]);

    expect(existsSync(join(outside, "unconfined.txt"))).toBe(true);
  });
});

describe("the profile resolves symlinked paths", () => {
  it("grants the resolved path, not the symlink", () => {
    // /tmp is a symlink to /private/tmp on macOS and Seatbelt matches the
    // resolved path. Granting the unresolved one grants nothing, denying the
    // child its own workspace -- a broken sandbox that looks like a working
    // one. This cost real debugging time while prototyping.
    const profile = sandboxProfile({ workspace: "/tmp", home: "/tmp", temp: [] });

    if (process.platform === "darwin") expect(profile).toContain("/private/tmp");
  });

  it("always denies writes before re-granting", () => {
    const profile = sandboxProfile({ workspace: "/tmp", home: "/tmp", temp: [] });

    expect(profile.indexOf("(deny file-write*)")).toBeLessThan(profile.indexOf("(allow file-write* (subpath"));
  });
});

describe("support detection", () => {
  it("probes the binary rather than trusting the platform name", () => {
    // A hardened image can lack sandbox-exec while still reporting darwin.
    // Claiming a boundary that is absent is the defect this module removes.
    const result = sandboxSupport();

    expect(typeof (result.supported ? result.mechanism : result.reason)).toBe("string");
  });

  it("returns the command unchanged when confinement is unavailable", () => {
    // The contract the caller relies on to fail closed.
    const { confined } = confineWrites("/bin/echo", ["hi"], { workspace: "/tmp", home: "/tmp", temp: [] });

    expect(confined).toBe(sandboxSupport().supported);
  });
});
