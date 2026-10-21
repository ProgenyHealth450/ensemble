#!/usr/bin/env node
'use strict';

/**
 * Local CI gate CLI (TRD-005). Thin JSON-in/JSON-out dispatcher over the
 * local-ci-* modules: one JSON payload on stdin per subcommand, one JSON
 * object on stdout. The only logic here is ORDERING (`gate`: prerequisites ->
 * run -> record -> post) and the merge-readiness decision (`merge`), both of
 * which only combine verdicts the modules already produce.
 *
 *   config   {source|path}                         validateConfig
 *   record   {action: build|parse|verify, input}   buildRecord / parseRecord / verifyRecord
 *   run      {options}                             runGate (never publishes)
 *   post     {input:{repo,sha,state,context,description}}  postStatus
 *   review   {action: classify|decide, reviews}    classifyReviews / decideBlock
 *   sweep    {facts, trackedKeys}                  findUntracked
 *   timing   {action: ready|verdict|record|fidelity|note, input}
 *   merge    {headSha, statuses, config|path, reviews?}    merge readiness for a PR
 *   gate     {repoRoot, headSha, repo, dryRun?, config?, ...}  full gate run
 *
 * FAIL CLOSED: malformed or oversized (> MAX_STDIN_BYTES) JSON is rejected
 * before any handler runs (exit 1, `{error}`, no side effects). Every string
 * emitted passes through redact(). A result with `ok:false` exits 1.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { buildRecord, parseRecord, verifyRecord } = require('./local-ci-record');
const { postStatus, loadCredential, redact, MAX_DESCRIPTION, CANNOT_ATTEST } = require('./local-ci-app');
const { classifyReviews, decideBlock } = require('./local-ci-review');
const { findUntracked } = require('./local-ci-sweep');
const timing = require('./local-ci-timing');
const rollout = require('./local-ci-rollout');

// config and runner need js-yaml. They load on first use so the CLI still starts
// (and reports a usable error) where js-yaml is not resolvable, e.g. a bare vendor dir.
const validateConfig = (source) => require('./local-ci-config').validateConfig(source);
const runGate = (options, injected) => require('./local-ci-runner').runGate(options, injected);

/** Largest accepted stdin payload: 1 MiB. */
const MAX_STDIN_BYTES = 1024 * 1024;
const DEFAULT_CONFIG_PATH = '.ensemble/local-ci.yaml';
const DEFAULT_CI_SCRIPT = 'scripts/ci-local.js';
const SHA_RE = /^[0-9a-fA-F]{40}$/;

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';

function shown(name) {
  return typeof name === 'string' ? JSON.stringify(name.slice(0, 40)) : String(name);
}

function need(payload, key, check, what) {
  if (!isObject(payload)) throw new Error('payload must be a JSON object');
  if (!check(payload[key])) throw new Error(`${what}: ${key} is missing or malformed`);
  return payload[key];
}

/** Read stdin as JSON, rejecting payloads over MAX_STDIN_BYTES without parsing. */
function readStdinJson(fd = 0) {
  const chunks = [];
  let total = 0;
  const buf = Buffer.alloc(64 * 1024);
  for (;;) {
    let n;
    try {
      n = fs.readSync(fd, buf, 0, buf.length, null);
    } catch (err) {
      if (err.code === 'EAGAIN') continue;
      if (err.code === 'EOF') break;
      throw err;
    }
    if (n === 0) break;
    total += n;
    if (total > MAX_STDIN_BYTES) throw new Error(`payload exceeds ${MAX_STDIN_BYTES} bytes`);
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function defaultDeps() {
  const tool = (cmd, args, cwd) => {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
    return { status: r.error ? 127 : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
  };
  return {
    node: () => tool('node', ['--version']),
    git: (args, cwd) => tool('git', args, cwd),
    exists: (p) => fs.existsSync(p),
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    runGate,
    postStatus,
    loadCredential,
    now: () => Date.now(),
    env: process.env,
    fetch: undefined,
  };
}

/** Config from payload.config (object|YAML text) or the repo file. */
function loadConfig(payload, deps, repoRoot) {
  let source = payload.config;
  if (source === undefined) {
    const file = payload.path || path.join(repoRoot || process.cwd(), DEFAULT_CONFIG_PATH);
    try {
      source = deps.readFile(file);
    } catch (_e) {
      source = undefined; // validateConfig reports a missing config
    }
  }
  return validateConfig(source);
}

/* ------------------------------------------------------------ simple handlers */

function runConfig(payload, deps) {
  if (!isObject(payload)) throw new Error('payload must be a JSON object');
  if (payload.source !== undefined) return validateConfig(payload.source);
  return loadConfig({ path: payload.path }, deps, payload.repoRoot);
}

const RECORD_ACTIONS = Object.freeze({
  build: (input) => buildRecord(input),
  parse: (input) => parseRecord(input),
  verify: (input) => verifyRecord(input),
});

function runRecord(payload) {
  const action = need(payload, 'action', isText, 'record');
  if (!hasOwn(RECORD_ACTIONS, action)) throw new Error(`record: unknown action ${shown(action)}`);
  return RECORD_ACTIONS[action](payload.input);
}

function runRun(payload, deps) {
  const options = need(payload, 'options', isObject, 'run');
  return deps.runGate(options, deps.runnerDeps);
}

async function runPost(payload, deps) {
  const input = need(payload, 'input', isObject, 'post');
  const found = deps.loadCredential({ env: deps.env, cwd: payload.repoRoot || process.cwd() });
  return deps.postStatus({ ...input, credential: found && found.credential, fetch: deps.fetch, now: deps.now() });
}

const REVIEW_ACTIONS = Object.freeze({
  classify: (reviews) => classifyReviews(reviews),
  decide: (reviews) => decideBlock(reviews),
});

function runReview(payload) {
  const action = need(payload, 'action', isText, 'review');
  if (!hasOwn(REVIEW_ACTIONS, action)) throw new Error(`review: unknown action ${shown(action)}`);
  return REVIEW_ACTIONS[action](payload.reviews);
}

function runSweep(payload) {
  const facts = need(payload, 'facts', isObject, 'sweep');
  return findUntracked(facts, payload.trackedKeys || []);
}

const TIMING_ACTIONS = Object.freeze({
  ready: (input) => timing.checkEnablementReady(input),
  verdict: (input) => timing.verdict(input.localMs, input.hostedMs, input.toleranceMs),
  record: (input) => timing.recordTimings(input),
  fidelity: (input) => timing.fidelityGaps(input.local, input.hosted),
  note: (input) => timing.renderNote(input),
});

function runTiming(payload) {
  const action = need(payload, 'action', isText, 'timing');
  if (!hasOwn(TIMING_ACTIONS, action)) throw new Error(`timing: unknown action ${shown(action)}`);
  const input = need(payload, 'input', isObject, 'timing');
  const result = TIMING_ACTIONS[action](input);
  return action === 'note' ? { ok: typeof result === 'string', note: result } : result;
}

/* ------------------------------------------------------------ rollout / rollback */

const ROLLOUT_ACTIONS = Object.freeze({
  snapshot: (input) => rollout.snapshotProtection(input.response, { repo: input.repo, branch: input.branch, now: input.now }),
  'plan-enable': (input) => rollout.planEnable(input),
  'plan-rollback': (input) => rollout.planRollback(input),
  preconditions: (input) => rollout.checkEnablementPreconditions(input),
  proof: (input) => rollout.checkProofNote(input.text),
});

/** Plans are DATA: this subcommand never calls GitHub and never changes protection. */
function runRollout(payload) {
  const action = need(payload, 'action', isText, 'rollout');
  if (!hasOwn(ROLLOUT_ACTIONS, action)) throw new Error(`rollout: unknown action ${shown(action)}`);
  const input = need(payload, 'input', isObject, 'rollout');
  return ROLLOUT_ACTIONS[action](input);
}

/* -------------------------------------------------------------- merge readiness */

/**
 * Can this PR merge on the strength of the local gate alone?
 * payload: { headSha, statuses:[{context,state,description,sha}], config|path, reviews? }
 * `sha` is the commit each status was posted on. Ready only when a SUCCESS status
 * in the configured context verifies (verifyRecord) against the exact head and
 * the configured workflow set. Hosted CI is never consulted.
 */
function runMerge(payload, deps) {
  const headSha = need(payload, 'headSha', (v) => typeof v === 'string' && SHA_RE.test(v), 'merge');
  const statuses = need(payload, 'statuses', Array.isArray, 'merge');
  const refuse = (reason, extra) => ({ ok: false, mergeReady: false, headSha, reason, ...(extra || {}) });

  const cfg = loadConfig(payload, deps, payload.repoRoot);
  if (!cfg.ok) return refuse(`local CI config invalid: ${cfg.problems.join('; ')}`);
  const workflowSet = cfg.approvalSet.workflows.map((w) => w.file);

  if (payload.reviews !== undefined) {
    const block = decideBlock(payload.reviews);
    if (block.blocked) return refuse(`blocked by review: ${block.reasons.join('; ')}`, { reviewers: block.reviewers });
  }

  const ours = statuses.filter((s) => isObject(s) && s.context === cfg.approvalSet.statusContext);
  if (ours.length === 0) {
    return refuse(`no local CI status (${cfg.approvalSet.statusContext}) found: the local gate has not run for ${headSha}`, { missingRun: true });
  }

  const problems = [];
  for (const s of ours) {
    if (s.state !== 'success') {
      problems.push(`status on ${s.sha} is ${s.state}`);
      continue;
    }
    const v = verifyRecord({ description: s.description, statusCommitSha: s.sha, headSha, workflowSet });
    if (v.ok) return { ok: true, mergeReady: true, headSha, context: cfg.approvalSet.statusContext, record: v.fields, hostedCiWaitRequired: false };
    problems.push(v.headMismatch || v.setMismatch || v.error || 'record did not verify');
  }
  const moved = ours.find((s) => s.state === 'success' && isText(s.sha) && s.sha !== headSha);
  return refuse(problems.join('; '), {
    missingRun: !ours.some((s) => s.state === 'success'),
    ...(moved ? { statusSha: moved.sha, headMoved: true } : {}),
  });
}

/* ------------------------------------------------------------------------ gate */

function preflight(repoRoot, ciScript, deps) {
  const missing = (prerequisite, detail) => ({
    ok: false,
    prerequisite,
    error: `prerequisite missing: ${prerequisite}${detail ? ` (${detail})` : ''}`,
  });
  const node = deps.node();
  if (!node || node.status !== 0 || !/^v\d+\./.test(String(node.stdout).trim())) return missing('node');
  const git = deps.git(['--version'], repoRoot);
  if (!git || git.status !== 0) return missing('git');
  if (!deps.exists(path.join(repoRoot, ciScript))) return missing(ciScript, 'the configured CI entry point');
  return { ok: true };
}

/** Failures the report must name: workflow, job, step, head SHA. */
function describeFailures(result, ciScript, equivalents) {
  const sha = result.sha;
  const out = [];
  for (const u of result.unmirrored || []) {
    out.push({ kind: 'unsupported-step', workflow: u.workflow, job: u.job, step: u.step, sha, message: u.reason });
  }
  for (const f of result.failures || []) {
    if (f.kind === 'unmirrored-step') continue; // already listed from result.unmirrored
    const eq = (equivalents || []).find((e) => e.runs === f.step);
    out.push({
      kind: f.kind,
      workflow: eq ? `covers workflow step "${eq.workflowStep}"` : ciScript,
      job: f.node === null || f.node === undefined ? null : `node ${f.node}`,
      step: f.step,
      sha,
      message: f.message,
    });
  }
  return out;
}

const REPORTABLE_KINDS = new Set(['unsupported-step', 'step-failed']);

function clip(text) {
  return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION - 1)}\u2026` : text;
}

async function runGateFlow(payload, deps) {
  if (!isObject(payload)) throw new Error('payload must be a JSON object');
  const repoRoot = path.resolve(need(payload, 'repoRoot', isText, 'gate'));
  const headSha = need(payload, 'headSha', (v) => typeof v === 'string' && SHA_RE.test(v), 'gate');
  const dryRun = payload.dryRun === true;
  const ciScript = payload.ciScript || DEFAULT_CI_SCRIPT;
  const report = { ok: false, stage: 'preflight', headSha, dryRun, posted: false, mergeReady: false, failures: [] };
  const stop = (stage, error, extra) => ({ ...report, stage, error, ...(extra || {}) });

  // 1. Prerequisites: nothing is run or posted without them, and merging is never the fallback.
  const pre = preflight(repoRoot, ciScript, deps);
  if (!pre.ok) return stop('preflight', pre.error, { prerequisite: pre.prerequisite });

  // 2. Approval set from the repo config.
  const cfg = loadConfig(payload, deps, repoRoot);
  if (!cfg.ok) return stop('config', `local CI config invalid: ${cfg.problems.join('; ')}`);
  if (!dryRun && !(isText(payload.repo) && /^[\w.-]+\/[\w.-]+$/.test(payload.repo))) {
    return stop('config', 'repo must be owner/name to post a status');
  }

  // 3. Run in a clean clone at the exact head (the runner owns checkout and cleanup).
  const options = {
    ...(isObject(payload.runner) ? payload.runner : {}),
    repoRoot,
    headSha,
    approvalSet: cfg.approvalSet,
    extraSteps: cfg.approvalSet.extraSteps,
    equivalents: cfg.approvalSet.equivalents,
    excludedSteps: cfg.approvalSet.excludedSteps,
    ciScript,
  };
  const result = deps.runGate(options, deps.runnerDeps);
  report.stage = 'run';
  report.nodes = (result.nodes || []).map((n) => ({ node: n.node, ok: n.ok }));

  const passed =
    result.ok === true &&
    (result.failures || []).length === 0 &&
    (result.unmirrored || []).length === 0 &&
    Array.isArray(result.nodes) &&
    result.nodes.length > 0 &&
    result.nodes.every((n) => n.ok === true);

  const found = deps.loadCredential({ env: deps.env, cwd: repoRoot });
  const credential = found && found.credential ? found.credential : null;
  const post = (state, description) =>
    deps.postStatus({ repo: payload.repo, sha: headSha, state, context: cfg.approvalSet.statusContext, description, credential, fetch: deps.fetch, now: deps.now() });

  // 4. Anything but a clean pass is a refusal; at most a FAILURE status is published.
  if (!passed) {
    report.failures = describeFailures(result, ciScript, cfg.approvalSet.equivalents);
    report.error = result.error || 'local CI did not pass';
    const reportable = report.failures.filter((f) => REPORTABLE_KINDS.has(f.kind));
    if (!dryRun && credential && reportable.length > 0) {
      const f = reportable[0];
      const published = await post('failure', clip(`ci-local failed: ${f.workflow} / ${f.job} / ${f.step} @ ${headSha.slice(0, 8)}`));
      report.posted = published.published === true;
      report.post = published;
    }
    return report;
  }

  // 5. Success is only ever claimed with a credential, and only by posting it.
  report.stage = 'attest';
  if (!credential) {
    return { ...report, cannotAttest: true, error: `${CANNOT_ATTEST}: ${(found && found.reason) || 'no credential'}; nothing published, merge refused` };
  }
  if (dryRun) return { ...report, ok: true, mergeReady: true, wouldPost: true };

  const blob = deps.git(['rev-parse', `${headSha}:${ciScript}`], repoRoot);
  if (!blob || blob.status !== 0) return stop('attest', `cannot hash ${ciScript} at ${headSha}`);
  const record = buildRecord({
    runnerBlobSha: String(blob.stdout).trim(),
    workflowSet: cfg.approvalSet.workflows.map((w) => w.file),
    log: JSON.stringify({ sha: headSha, nodes: result.nodes }),
  });
  if (!record.ok) return stop('attest', `cannot build record: ${record.error}`);

  const published = await post('success', record.description);
  report.post = published;
  report.posted = published.published === true;
  report.record = record.fields;
  report.ok = report.posted;
  report.mergeReady = report.posted;
  if (!report.posted) report.error = published.reason || 'status was not published';
  return report;
}

/* -------------------------------------------------------------------- dispatch */

const HANDLERS = Object.freeze({
  config: runConfig,
  record: runRecord,
  run: runRun,
  post: runPost,
  review: runReview,
  sweep: runSweep,
  timing: runTiming,
  rollout: runRollout,
  merge: runMerge,
  gate: runGateFlow,
});

/**
 * Entry point: argv WITHOUT node + script. Resolves to the exit code
 * (0 success, 1 failure or an `ok:false` result). `io.readJson` and
 * `io.write` default to real stdin/stdout.
 */
async function main(argv, injected) {
  const deps = { ...defaultDeps(), ...(injected || {}) };
  const io = { readJson: readStdinJson, write: (s) => process.stdout.write(s), ...((injected && injected.io) || {}) };
  const emit = (value) => io.write(`${JSON.stringify(redact(value))}\n`);

  const subcommand = Array.isArray(argv) ? argv[0] : undefined;
  const handler = typeof subcommand === 'string' && hasOwn(HANDLERS, subcommand) ? HANDLERS[subcommand] : undefined;
  if (handler === undefined) {
    emit({ error: `Unknown subcommand ${shown(subcommand)}. Usage: local-ci-cli <${Object.keys(HANDLERS).join('|')}> < payload.json` });
    return 1;
  }

  let payload;
  try {
    payload = io.readJson();
  } catch (err) {
    emit({ error: `invalid JSON on stdin: ${err.message}` });
    return 1;
  }

  try {
    const result = await handler(payload, deps);
    if (typeof JSON.stringify(result) !== 'string') throw new Error('Result was not JSON-serializable');
    emit(result);
    return isObject(result) && result.ok === false ? 1 : 0;
  } catch (err) {
    emit({ error: err && err.message ? err.message : String(err) });
    return 1;
  }
}

module.exports = {
  main,
  runConfig,
  runRecord,
  runRun,
  runPost,
  runReview,
  runSweep,
  runTiming,
  runRollout,
  runMerge,
  runGateFlow,
  HANDLERS,
  MAX_STDIN_BYTES,
  defaultDeps,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
