import { homedir } from "node:os";
import { containedEnvironment, agentArgs } from "../src/agent-port";

/**
 * `br-4zz4`: the fix-agent child must not reach the operator's configuration.
 *
 * The original report named three routes out of the `--tools` allowlist:
 * `write` over the `xd://` MCP device transport (mounted from the operator's
 * MCP config, which in this installation includes Foreman tools that CREATE
 * AND DISPATCH runs), and `manage_skill` / `learn`, which persist under the
 * operator's OMP home and load in every future session.
 *
 * None of those are closed by the tool allowlist — the allowlist was proven
 * not to contain anything (see agent-port's docstring). They are closed by
 * pointing the child at a throwaway home, so the config that would mount
 * those transports is simply not there to read.
 *
 * `hostile-tools.e2e.test.ts` proves the skill/memory half with a live probe.
 * This pins the environment itself, which is what makes the MCP half true.
 */
describe("the child cannot read the operator's configuration", () => {
  const REAL = homedir();
  const env = containedEnvironment("/tmp/throwaway-home");

  it("redirects every root an MCP config could be read from", () => {
    // mcp.json lives under the OMP home. If these still pointed at the real
    // home the child would mount the operator's servers, tool allowlist or
    // not — `xd://` is a transport, not a filesystem path, so a `write` grant
    // reaches it.
    for (const key of ["OMP_HOME", "OMP_CONFIG_DIR", "PI_HOME", "PI_CONFIG_DIR"]) {
      expect(env[key]).toBeDefined();
      expect(env[key]).toContain("/tmp/throwaway-home");
      expect(env[key]).not.toContain(REAL);
    }
  });

  it("redirects HOME and the XDG roots, which is what the OMP roots are derived from", () => {
    for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
      expect(env[key]).toContain("/tmp/throwaway-home");
    }
  });

  it("redirects rather than unsets, because unsetting is rediscovery", () => {
    // An unset HOME makes many tools fall back to the passwd entry — which is
    // the real home again. Containment is redirection; deletion is an
    // invitation to look it up.
    expect(env.HOME).toBe("/tmp/throwaway-home");
    expect(env.HOME).not.toBe("");
    expect(env.HOME).not.toBeUndefined();
  });

  it("leaves the rest of the environment intact, so the child still works", () => {
    // Over-scrubbing breaks PATH and the child cannot start, which would be
    // reported as a containment success while actually being a broken port.
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("still disables extensions, so the child cannot recurse into this runtime", () => {
    expect(agentArgs("/tmp/wt", ["read"], "prompt")).toContain("--no-extensions");
  });
});
