// `import * as fs` compiles to a namespace COPY whose keys are defined without
// `configurable: true`, so `jest.spyOn` on it throws -- and would watch an
// object `proposal-store.ts` never calls through, since its named imports
// compile to property reads on the real CJS exports. Requiring the module
// directly gives the spy the same object the code under test uses.
import fsModule = require("node:fs");
const fs = fsModule;
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Proposal, ProposalStore, currentHash, hashContents } from "../src";

/**
 * The proposal store is what makes `mode: propose` a working mode instead of a
 * dead end. A behavior that may not write still has to produce something, and
 * that something has to survive the run, be addressable afterwards, and carry
 * enough information for a later `apply` to tell whether the world moved
 * underneath it.
 *
 * So there are only three properties worth testing here, and each of them is
 * load-bearing for a safety requirement rather than for the data structure:
 *
 *   - a proposal written in one step is readable, amendable and listable in a
 *     later one (it is durable, not transient);
 *   - a ref is an untrusted string, because it travels through workflow data
 *     between steps, and the store is asked to open a file named after it;
 *   - `staleWrites` can tell that the tree moved, which is the entire basis on
 *     which `fix.apply` refuses to overwrite a concurrent user edit.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ensemble-proposal-store-"));
});

afterEach(() => {
  jest.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function seed(relPath: string, contents: string): void {
  const abs = join(root, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, contents, "utf8");
}

function draft(overrides: Partial<Omit<Proposal, "ref" | "createdAt" | "verifications">> = {}): Omit<
  Proposal,
  "ref" | "createdAt" | "verifications"
> {
  return {
    kind: "fix",
    behavior: "auto-fix",
    issue: "rounding drops the last cent",
    rationale: "the accumulator truncates instead of rounding",
    correlationId: "corr-1",
    evidence: ["note:observed in CI"],
    writes: [{ path: "src/rounding.ts", contents: "export const round = () => 1;\n", baseSha256: null }],
    ...overrides,
  };
}

describe("a proposal survives the step that created it", () => {
  it("round-trips create → read → update → list", () => {
    const store = new ProposalStore(root);

    const created = store.create(draft(), "2026-01-01T00:00:00.000Z");

    // The ref is the handle every later step uses, so its shape is part of the
    // contract rather than an implementation detail.
    expect(created.ref).toMatch(/^fix-[0-9a-f]{12}$/);
    expect(created.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(created.verifications).toEqual([]);
    expect(fs.existsSync(join(store.directory, `${created.ref}.json`))).toBe(true);

    // Read back through a *fresh* store: a proposal that only exists in the
    // creating object's memory would pass a naive round-trip and still be lost
    // between workflow steps, which is the failure this store exists to stop.
    const reopened = new ProposalStore(root);
    expect(reopened.read(created.ref)).toEqual(created);

    const verified: Proposal = {
      ...created,
      verifications: [
        { verdict: "passed", detail: "jest: 12 passed, 0 failed, 12 total", command: "npx jest", at: "t1", total: 12 },
      ],
    };
    expect(reopened.update(verified)).toEqual(verified);
    expect(new ProposalStore(root).read(created.ref)).toEqual(verified);

    // A second proposal, and then both come back from `list`.
    const other = store.create(draft({ kind: "constitution", issue: "cite evidence" }), "2026-01-01T00:00:01.000Z");
    const listed = new ProposalStore(root).list();
    expect(listed.map((p) => p.ref).sort()).toEqual([created.ref, other.ref].sort());
    expect(listed.find((p) => p.ref === created.ref)).toEqual(verified);
  });

  it("returns undefined for a well-formed ref that names nothing, and for a corrupt file", () => {
    const store = new ProposalStore(root);

    // Nothing created yet: the directory does not even exist.
    expect(store.list()).toEqual([]);
    expect(store.read("fix-0123456789ab")).toBeUndefined();

    const created = store.create(draft(), "2026-01-01T00:00:00.000Z");
    writeFileSync(join(store.directory, `${created.ref}.json`), "{ not json", "utf8");

    // A truncated write is an absence of a proposal, not a crash in the step
    // that asked for it.
    expect(store.read(created.ref)).toBeUndefined();
    expect(store.list()).toEqual([]);
  });
});

describe("a ref is an untrusted string", () => {
  /**
   * Refs are passed between workflow steps as ordinary data, so by the time
   * one reaches the store it is caller-controlled input that gets joined onto
   * a filesystem path. The guard is a whitelist applied *before* any path is
   * built, which is why these cases can assert that the filesystem was never
   * consulted at all.
   */
  const malformed = [
    "../leak",
    "../../etc/passwd",
    "fix-0123456789ab/../../../etc/passwd",
    "/etc/passwd",
    "fix-XYZ123456789",
    "fix-0123456789abc",
    "fix-0123456789a",
    "FIX-0123456789ab",
    "fix_0123456789ab",
    "",
    "fix-0123456789ab.json",
  ];

  it("rejects a malformed ref without touching the filesystem", () => {
    const store = new ProposalStore(root);
    store.create(draft(), "2026-01-01T00:00:00.000Z");

    const existsSync = jest.spyOn(fs, "existsSync");
    const readFileSync = jest.spyOn(fs, "readFileSync");

    for (const ref of malformed) {
      expect(store.read(ref)).toBeUndefined();
    }

    // Not merely "returned undefined": never looked. A guard that stats the
    // path first has already let an attacker-chosen string reach the
    // filesystem, and `undefined` vs. an error is then an information leak
    // about what exists.
    expect(existsSync).not.toHaveBeenCalled();
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("refuses a traversal ref even when the file it names really exists", () => {
    const store = new ProposalStore(root);
    const legitimate = store.create(draft(), "2026-01-01T00:00:00.000Z");

    // A real, perfectly valid proposal document one directory above the store.
    // `join(dir, "../leak.json")` resolves straight onto it, so nothing but
    // the ref format check stands between the caller and this file.
    const outside = join(root, ".ensemble", "leak.json");
    writeFileSync(outside, `${JSON.stringify({ ...legitimate, ref: "leak" }, null, 2)}\n`, "utf8");
    expect(fs.existsSync(outside)).toBe(true);

    expect(store.read("../leak")).toBeUndefined();
    // Control: the same store reads a legitimate ref happily, so the refusal
    // above is about the ref and not about a broken store.
    expect(store.read(legitimate.ref)).toEqual(legitimate);
  });
});

describe("staleWrites tells the applier that the tree moved", () => {
  it("reports nothing when the tree is unchanged", () => {
    seed("src/rounding.ts", "original\n");
    seed("src/untouched.ts", "also original\n");
    const store = new ProposalStore(root);

    const proposal = store.create(
      draft({
        writes: [
          { path: "src/rounding.ts", contents: "fixed\n", baseSha256: currentHash(root, "src/rounding.ts") },
          { path: "src/untouched.ts", contents: "fixed too\n", baseSha256: currentHash(root, "src/untouched.ts") },
        ],
      }),
      "2026-01-01T00:00:00.000Z",
    );

    expect(store.staleWrites(proposal)).toEqual([]);
  });

  it("detects a file whose content changed since the proposal was created", () => {
    seed("src/rounding.ts", "original\n");
    seed("src/untouched.ts", "also original\n");
    const store = new ProposalStore(root);

    const proposal = store.create(
      draft({
        writes: [
          { path: "src/rounding.ts", contents: "fixed\n", baseSha256: currentHash(root, "src/rounding.ts") },
          { path: "src/untouched.ts", contents: "fixed too\n", baseSha256: currentHash(root, "src/untouched.ts") },
        ],
      }),
      "2026-01-01T00:00:00.000Z",
    );

    // The user edits one of the targets while the proposal is in review.
    seed("src/rounding.ts", "the user's own work\n");

    // Only the moved file is named. Reporting the whole proposal stale would
    // be safe but useless; the applier's message has to say which file.
    expect(store.staleWrites(proposal)).toEqual(["src/rounding.ts"]);
  });

  it("detects a file that did not exist at proposal time but exists now", () => {
    const store = new ProposalStore(root);

    // `baseSha256: null` is the honest record of "this file was absent",
    // which is what a create-new-file proposal looks like.
    const proposal = store.create(
      draft({ writes: [{ path: "src/new-helper.ts", contents: "generated\n", baseSha256: null }] }),
      "2026-01-01T00:00:00.000Z",
    );
    expect(store.staleWrites(proposal)).toEqual([]);

    // Someone else created the file first. Applying now would silently destroy
    // their version — absence is a fact about the tree exactly like content is.
    seed("src/new-helper.ts", "written by the user in the meantime\n");

    expect(store.staleWrites(proposal)).toEqual(["src/new-helper.ts"]);
  });

  it("treats a deleted file as a moved file", () => {
    seed("src/rounding.ts", "original\n");
    const store = new ProposalStore(root);
    const proposal = store.create(
      draft({
        writes: [{ path: "src/rounding.ts", contents: "fixed\n", baseSha256: currentHash(root, "src/rounding.ts") }],
      }),
      "2026-01-01T00:00:00.000Z",
    );

    rmSync(join(root, "src/rounding.ts"));

    // The proposal was computed against content that is now gone; re-creating
    // the file from a stale candidate is not the same act as fixing it.
    expect(store.staleWrites(proposal)).toEqual(["src/rounding.ts"]);
  });

  it("reads the tree through the store's own root", () => {
    // `currentHash` is the primitive `staleWrites` is built from; if it
    // resolved relative to `process.cwd()` the staleness check would silently
    // compare against whatever directory jest happened to start in.
    seed("src/rounding.ts", "original\n");
    expect(currentHash(root, "src/rounding.ts")).toBe(hashContents("original\n"));
    expect(currentHash(root, "src/absent.ts")).toBeNull();
    // A directory is not a file, and must not hash as one.
    expect(currentHash(root, "src")).toBeNull();
  });
});
