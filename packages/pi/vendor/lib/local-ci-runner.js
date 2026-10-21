'use strict';

/**
 * Isolated local-CI gate runner.
 *
 * Runs the repository's own `ci:local` entry point from inside a clean clone of
 * the PR head commit (`.ensemble/local-ci-runs/<sha>`), once per required Node
 * version, and returns a result. It NEVER publishes anything: the caller decides
 * what to do with the result. FAIL CLOSED: every unknown, missing or
 * unprovable thing (unfetchable commit, unavailable Node version, workflow step
 * that is not mirrored, step that exits non-zero, unreadable config) yields
 * `ok:false` with the reason named; a pass only comes from every required step
 * passing on every required Node version.
 *
 * Process and git access is injected (`deps`) so failure cases can be driven
 * without downloading Node or running a real `npm ci`.
 *
 * runGate(options, deps?) -> {
 *   ok, sha, error?, failures:[{kind, step, node, sha, message}],
 *   unmirrored:[{workflow, job, step}], nodes:[{node, ok, steps:[{name,status}]}],
 *   staleRemoved:[dirName], clonePath
 * }
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const RUNS_DIR = path.join('.ensemble', 'local-ci-runs');
const SHA_RE = /^[0-9a-f]{40}$/;
const DEFAULT_STALE_MS = 60 * 60 * 1000;
const DEFAULT_CI_COMMAND = 'node scripts/ci-local.js';
const DEFAULT_CI_SCRIPT = 'scripts/ci-local.js';
const DEFAULT_SECRETS_FILE = path.join('.ensemble', 'local-ci.secrets.env');
// Steps the runner itself provides: the clean clone and the explicit Node version.
const DEFAULT_IGNORED_ACTIONS = ['actions/checkout', 'actions/setup-node'];
const REDACTED = '[REDACTED]';
const OUTPUT_TAIL = 4000;

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function normalizeCmd(cmd) {
  return String(cmd).replace(/\s+/g, ' ').trim();
}

function defaultDeps() {
  return {
    git(args, { cwd } = {}) {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      return { status: r.error ? 127 : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
    },
    run(cmd, { cwd, env } = {}) {
      const r = spawnSync('bash', ['-c', cmd], { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      return { status: r.error ? 127 : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
    },
    resolveNodeBinDir(major) {
      const r = spawnSync('npx', ['--yes', '-p', `node@${major}`, 'node', '-p', 'process.execPath'], { encoding: 'utf8' });
      if (r.error || r.status !== 0) {
        throw new Error(`could not obtain Node ${major} via npx: ${(r.stderr || (r.error && r.error.message) || '').trim()}`);
      }
      return path.dirname(r.stdout.trim().split('\n').pop());
    },
  };
}

/* ------------------------------------------------------------------ secrets */

function parseSecretsFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/**
 * Load the named secrets from a gitignored local file or the environment.
 * Throws if the file exists but is tracked or not ignored (a tracked file must
 * never be a secret source). Environment values win over the file.
 */
function loadSecrets({ repoRoot, names, secretsFile, env, deps }) {
  const values = {};
  if (!names || names.length === 0) return values;
  const rel = secretsFile || DEFAULT_SECRETS_FILE;
  const abs = path.resolve(repoRoot, rel);
  if (fs.existsSync(abs)) {
    const tracked = deps.git(['ls-files', '--error-unmatch', '--', rel], { cwd: repoRoot });
    if (tracked.status === 0) throw new Error(`secrets file ${rel} is tracked by git; refusing to read secrets from a tracked file`);
    const ignored = deps.git(['check-ignore', '-q', '--', rel], { cwd: repoRoot });
    if (ignored.status !== 0) throw new Error(`secrets file ${rel} is not gitignored; refusing to read it (add it to .gitignore)`);
    const parsed = parseSecretsFile(fs.readFileSync(abs, 'utf8'));
    for (const n of names) if (typeof parsed[n] === 'string') values[n] = parsed[n];
  }
  for (const n of names) if (typeof env[n] === 'string' && env[n] !== '') values[n] = env[n];
  return values;
}

/** Replace every secret value in `text`. Longest values first. */
function redact(text, secretValues) {
  if (typeof text !== 'string') return text;
  let out = text;
  const vals = secretValues.filter((v) => typeof v === 'string' && v !== '').sort((a, b) => b.length - a.length);
  for (const v of vals) out = out.split(v).join(REDACTED);
  return out;
}

function redactDeep(value, secretValues) {
  if (typeof value === 'string') return redact(value, secretValues);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secretValues));
  if (isObject(value)) {
    const o = {};
    for (const k of Object.keys(value)) o[k] = redactDeep(value[k], secretValues);
    return o;
  }
  return value;
}

/* ------------------------------------------------------------- stale sweep */

/**
 * Remove clones under <repoRoot>/.ensemble/local-ci-runs/ that are older than
 * `maxAgeMs`. Touches ONLY real directories whose name is a 40-hex commit sha;
 * every other entry (and everything outside the prefix) is left alone.
 * Returns the names removed.
 */
function sweepStaleClones({ repoRoot, maxAgeMs = DEFAULT_STALE_MS, now = Date.now() }) {
  const root = path.join(repoRoot, RUNS_DIR);
  let entries;
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  const removed = [];
  for (const name of entries) {
    if (!SHA_RE.test(name)) continue;
    const p = path.join(root, name);
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    if (now - st.mtimeMs <= maxAgeMs) continue;
    fs.rmSync(p, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/* ------------------------------------------------------------------- clone */

/**
 * Create a clean clone of repoRoot at exactly `sha` in <repoRoot>/.ensemble/local-ci-runs/<sha>.
 * Returns {ok:true, dir} or {ok:false, error}. On failure nothing is left behind.
 */
function cloneAtSha({ repoRoot, sha, remote = 'origin', deps }) {
  const unfetchable = (why) => ({ ok: false, error: `cannot obtain head commit ${sha}: ${why}` });
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
    return { ok: false, error: `head commit ${JSON.stringify(sha)} is not a full 40-hex commit sha` };
  }
  const have = (cwd) => deps.git(['cat-file', '-e', `${sha}^{commit}`], { cwd }).status === 0;
  if (!have(repoRoot)) {
    const f = deps.git(['fetch', '--quiet', remote, sha], { cwd: repoRoot });
    if (f.status !== 0 || !have(repoRoot)) return unfetchable((f.stderr || 'not present locally and fetch failed').trim());
  }
  const root = path.join(repoRoot, RUNS_DIR);
  const dir = path.join(root, sha);
  if (fs.existsSync(dir)) {
    return { ok: false, error: `clone directory ${dir} already exists (another run for ${sha} may be in progress); remove it if it is stale` };
  }
  fs.mkdirSync(root, { recursive: true });
  const discard = () => fs.rmSync(dir, { recursive: true, force: true });
  const c = deps.git(['clone', '--quiet', '--no-checkout', '--local', '--no-hardlinks', repoRoot, dir], {});
  if (c.status !== 0) {
    discard();
    return unfetchable(`git clone failed: ${c.stderr.trim()}`);
  }
  if (!have(dir)) {
    // Commit exists in the source repo but is not reachable from a ref: fetch it by sha.
    const f = deps.git(['-c', 'uploadpack.allowAnySHA1InWant=true', 'fetch', '--quiet', repoRoot, sha], { cwd: dir });
    if (f.status !== 0 || !have(dir)) {
      discard();
      return unfetchable((f.stderr || 'commit missing from clone').trim());
    }
  }
  const co = deps.git(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', sha], { cwd: dir });
  if (co.status !== 0) {
    discard();
    return unfetchable(`git checkout failed: ${co.stderr.trim()}`);
  }
  const head = deps.git(['rev-parse', 'HEAD'], { cwd: dir });
  if (head.status !== 0 || head.stdout.trim() !== sha) {
    discard();
    return unfetchable(`clone HEAD is ${head.stdout.trim() || 'unknown'}, not the requested commit`);
  }
  return { ok: true, dir };
}

/* --------------------------------------------------------- step mirroring */

/** Label of a workflow step: its name, else its first run line, else its action. */
function stepLabel(step) {
  if (typeof step.name === 'string' && step.name.trim()) return step.name.trim();
  if (typeof step.run === 'string') return step.run.trim().split('\n')[0];
  if (typeof step.uses === 'string') return step.uses;
  return '(unnamed step)';
}

function actionName(uses) {
  return String(uses).split('@')[0].toLowerCase();
}

/**
 * Pure: compare the REQUIRED steps of the approval-set workflow jobs with the
 * steps the runner actually runs.
 *
 *   workflows:  [{file, doc}]  parsed workflow files (doc = parsed YAML)
 *   approvalSet.workflows: [{file, jobs:[{id}]}]
 *   runnable:   [{name, cmd}]  ci:local steps + configured extra steps
 *   equivalents:[{workflowStep, runs}]  workflowStep (label or run text) is
 *               covered by the runnable step named `runs`
 *   ignoredActions: actions the runner supplies itself (checkout, setup-node)
 *   excludedSteps: [{workflow, job, step, reason}] steps that cannot run locally
 *               and are recorded as deliberately excluded (AC-009-3). Matched by
 *               workflow file + job id + step label, so a same-named step in
 *               another job is NOT excluded.
 *
 * A workflow step is mirrored if its `run` text equals a runnable command, or an
 * equivalents entry maps it to an existing runnable step. Any other step (an
 * unsupported action, a run command nobody runs) is unmirrored.
 * Returns [{workflow, job, step, reason}].
 */
function findUnmirroredSteps({ workflows, approvalSet, runnable, equivalents = [], ignoredActions = DEFAULT_IGNORED_ACTIONS, excludedSteps = [] }) {
  const ignored = new Set(ignoredActions.map((a) => a.toLowerCase()));
  const byCmd = new Set(runnable.map((r) => normalizeCmd(r.cmd)));
  const byName = new Set(runnable.map((r) => r.name));
  const unmirrored = [];
  const parsed = new Map(workflows.map((w) => [w.file, w.doc]));

  for (const wf of approvalSet.workflows || []) {
    const doc = parsed.get(wf.file);
    for (const job of wf.jobs || []) {
      const jobDef = isObject(doc) && isObject(doc.jobs) ? doc.jobs[job.id] : undefined;
      if (!isObject(jobDef) || !Array.isArray(jobDef.steps)) {
        unmirrored.push({ workflow: wf.file, job: job.id, step: '(job not found or has no steps)', reason: 'workflow job cannot be read' });
        continue;
      }
      for (const step of jobDef.steps) {
        if (!isObject(step)) {
          unmirrored.push({ workflow: wf.file, job: job.id, step: '(malformed step)', reason: 'step is not a mapping' });
          continue;
        }
        const label = stepLabel(step);
        if (excludedSteps.some((x) => isObject(x) && x.workflow === wf.file && x.job === job.id && x.step === label)) continue;
        if (typeof step.uses === 'string' && ignored.has(actionName(step.uses))) continue;
        if (typeof step.run === 'string' && byCmd.has(normalizeCmd(step.run))) continue;
        const eq = equivalents.find(
          (e) => isObject(e) && (e.workflowStep === label || (typeof step.run === 'string' && normalizeCmd(e.workflowStep) === normalizeCmd(step.run)))
        );
        if (eq && byName.has(eq.runs)) continue;
        unmirrored.push({
          workflow: wf.file,
          job: job.id,
          step: label,
          reason: eq ? `equivalent step "${eq.runs}" is not in the configured step list` : 'no configured step mirrors it',
        });
      }
    }
  }
  return unmirrored;
}

/** Required Node majors: union of numeric `node-version` matrix values in the approval set. */
function requiredNodeVersions(approvalSet) {
  const set = new Set();
  for (const c of approvalSet.checks || []) {
    const v = isObject(c.matrix) ? c.matrix['node-version'] : undefined;
    const n = Number(v);
    if (v !== undefined && Number.isInteger(n) && n > 0) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

/* --------------------------------------------------------------- reporting */

function tail(text) {
  const t = String(text || '').trim();
  return t.length > OUTPUT_TAIL ? `...${t.slice(-OUTPUT_TAIL)}` : t;
}

/** Parse ci:local's summary table for failed step names. */
function parseFailedSteps(output) {
  const failed = [];
  for (const line of String(output).split('\n')) {
    const m = /^(\S+)\s+FAIL\s+[\d.]+\s*$/.exec(line);
    if (m) failed.push(m[1]);
  }
  return failed;
}

function parsePassedSteps(output) {
  const passed = [];
  for (const line of String(output).split('\n')) {
    const m = /^(\S+)\s+PASS\s+[\d.]+\s*$/.exec(line);
    if (m) passed.push(m[1]);
  }
  return passed;
}

/* --------------------------------------------------------------------- run */

/**
 * Run the local CI gate for `headSha`.
 *
 * options:
 *   repoRoot       (required) the maintainer's repository
 *   headSha        (required) full 40-hex PR head commit
 *   approvalSet    (required) approvalSet from local-ci-config.validateConfig
 *   extraSteps     [{name, cmd}] additional commands run per Node version in the clone
 *   equivalents    [{workflowStep, runs}] workflow step -> runnable step name covering it
 *   ignoredActions actions the runner supplies (default checkout, setup-node)
 *   excludedSteps  [{workflow, job, step, reason}] steps recorded as not runnable locally
 *   ciSteps        [{name, cmd}] ci:local's step list (default: read from the clone's scripts/ci-local.js)
 *   ciCommand      default 'node scripts/ci-local.js'; ciScript its file (default scripts/ci-local.js)
 *   nodeVersions   override the required Node majors (default: from approvalSet matrices)
 *   secretNames    names of secrets steps need; values from secretsFile or env
 *   secretsFile    repo-relative gitignored file (default .ensemble/local-ci.secrets.env)
 *   env            environment (default process.env)
 *   remote         git remote to fetch a missing head from (default origin)
 *   staleMs, now   stale-clone threshold and clock
 *   keep           keep the clone (debugging only)
 */
function runGate(options, injected) {
  const deps = { ...defaultDeps(), ...(injected || {}) };
  const opts = options || {};
  const sha = opts.headSha;
  const env = opts.env || process.env;
  const result = { ok: false, sha, failures: [], unmirrored: [], nodes: [], staleRemoved: [], clonePath: null };
  let secretValues = [];

  const fail = (kind, step, node, message) => {
    result.failures.push({ kind, step: step || null, node: node === undefined ? null : node, sha, message });
    result.ok = false;
  };
  const finish = () => redactDeep(result, secretValues);

  if (!opts.repoRoot || !isObject(opts.approvalSet) || !Array.isArray(opts.approvalSet.workflows)) {
    result.error = 'runGate requires repoRoot and a validated approvalSet';
    fail('invalid-input', null, undefined, result.error);
    return finish();
  }
  const repoRoot = path.resolve(opts.repoRoot);

  // Prerequisite: git.
  const gv = deps.git(['--version'], { cwd: repoRoot });
  if (gv.status !== 0) {
    result.error = `prerequisite missing: git is unavailable (${tail(gv.stderr)})`;
    fail('prerequisite', 'git', undefined, result.error);
    return finish();
  }

  // Secrets never come from a tracked file.
  let secrets;
  try {
    secrets = loadSecrets({ repoRoot, names: opts.secretNames || [], secretsFile: opts.secretsFile, env, deps });
  } catch (err) {
    result.error = err.message;
    fail('secrets', null, undefined, err.message);
    return finish();
  }
  secretValues = Object.values(secrets);

  // Clones left by a crashed earlier run (only sha-named dirs under the prefix).
  try {
    result.staleRemoved = sweepStaleClones({ repoRoot, maxAgeMs: opts.staleMs, now: opts.now });
  } catch (err) {
    result.error = `could not clean stale clones: ${err.message}`;
    fail('cleanup', null, undefined, result.error);
    return finish();
  }

  const clone = cloneAtSha({ repoRoot, sha, remote: opts.remote, deps });
  if (!clone.ok) {
    result.error = clone.error;
    fail('unfetchable-head', null, undefined, clone.error);
    return finish();
  }
  const dir = clone.dir;
  result.clonePath = dir;

  try {
    // Prerequisite: the repository's own entry point, in the PR head.
    const ciScript = opts.ciScript || DEFAULT_CI_SCRIPT;
    if (!fs.existsSync(path.join(dir, ciScript))) {
      const msg = `prerequisite missing: ${ciScript} does not exist at ${sha}`;
      result.error = msg;
      fail('prerequisite', ciScript, undefined, msg);
      return finish();
    }

    let ciSteps = opts.ciSteps;
    if (!ciSteps) {
      try {
        ciSteps = require(path.join(dir, ciScript)).STEPS;
      } catch (err) {
        ciSteps = undefined;
        result.error = `prerequisite missing: cannot read the step list from ${ciScript}: ${err.message}`;
      }
    }
    if (!Array.isArray(ciSteps) || ciSteps.length === 0) {
      result.error = result.error || `prerequisite missing: ${ciScript} exposes no step list`;
      fail('prerequisite', ciScript, undefined, result.error);
      return finish();
    }
    const extraSteps = Array.isArray(opts.extraSteps) ? opts.extraSteps : [];
    const runnable = [...ciSteps, ...extraSteps].filter((s) => isObject(s) && typeof s.name === 'string' && typeof s.cmd === 'string');

    // Read the REQUIRED workflows at the PR head and compare with what we run.
    const workflows = [];
    for (const wf of opts.approvalSet.workflows) {
      let doc;
      try {
        doc = yaml.load(fs.readFileSync(path.join(dir, wf.file), 'utf8'));
      } catch (err) {
        doc = undefined;
      }
      workflows.push({ file: wf.file, doc });
    }
    result.unmirrored = findUnmirroredSteps({
      workflows,
      approvalSet: opts.approvalSet,
      runnable,
      equivalents: opts.equivalents,
      ignoredActions: opts.ignoredActions,
      excludedSteps: opts.excludedSteps,
    });
    for (const u of result.unmirrored) {
      fail('unmirrored-step', u.step, undefined, `required workflow step "${u.step}" (${u.workflow} job ${u.job}) is not mirrored: ${u.reason}`);
    }
    if (result.unmirrored.length > 0) return finish();

    const versions = opts.nodeVersions || requiredNodeVersions(opts.approvalSet);
    if (!Array.isArray(versions) || versions.length === 0) {
      fail('node-version', null, undefined, 'no required Node versions are configured; refusing to run on the machine default');
      return finish();
    }

    const ciCommand = opts.ciCommand || DEFAULT_CI_COMMAND;
    for (const major of versions) {
      const node = { node: major, ok: false, steps: [] };
      result.nodes.push(node);

      let binDir;
      try {
        binDir = deps.resolveNodeBinDir(major);
      } catch (err) {
        fail('node-version', null, major, `required Node ${major} cannot be provided: ${err.message}`);
        continue;
      }
      const stepEnv = { ...env, ...secrets, CI: 'true', PATH: `${binDir}${path.delimiter}${env.PATH || ''}` };

      const ver = deps.run('node --version', { cwd: dir, env: stepEnv });
      const reported = ver.status === 0 ? /^v(\d+)\./.exec(ver.stdout.trim()) : null;
      if (!reported || Number(reported[1]) !== major) {
        fail('node-version', null, major, `required Node ${major} is not what ran (got ${tail(ver.stdout) || 'no version'}); not counting it`);
        continue;
      }

      let nodeOk = true;
      const ci = deps.run(ciCommand, { cwd: dir, env: stepEnv });
      const out = `${ci.stdout}\n${ci.stderr}`;
      for (const name of parsePassedSteps(out)) node.steps.push({ name, status: 'PASS' });
      if (ci.status !== 0) {
        nodeOk = false;
        const failed = parseFailedSteps(out);
        const names = failed.length ? failed : [`${ciCommand} (exit ${ci.status})`];
        for (const name of names) {
          node.steps.push({ name, status: 'FAIL' });
          fail('step-failed', name, major, `step "${name}" failed on Node ${major} at ${sha}: ${tail(out)}`);
        }
      }
      for (const s of extraSteps) {
        const r = deps.run(s.cmd, { cwd: dir, env: stepEnv });
        if (r.status === 0) {
          node.steps.push({ name: s.name, status: 'PASS' });
        } else {
          nodeOk = false;
          node.steps.push({ name: s.name, status: 'FAIL' });
          fail('step-failed', s.name, major, `step "${s.name}" failed on Node ${major} at ${sha} (exit ${r.status}): ${tail(`${r.stdout}\n${r.stderr}`)}`);
        }
      }
      node.ok = nodeOk;
    }

    result.ok = result.failures.length === 0 && result.nodes.length === versions.length && result.nodes.every((n) => n.ok);
    return finish();
  } catch (err) {
    result.error = `local CI runner error: ${err.message}`;
    fail('runner-error', null, undefined, result.error);
    return finish();
  } finally {
    if (!opts.keep) fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = {
  runGate,
  cloneAtSha,
  sweepStaleClones,
  findUnmirroredSteps,
  requiredNodeVersions,
  loadSecrets,
  parseSecretsFile,
  redact,
  RUNS_DIR,
  DEFAULT_STALE_MS,
  DEFAULT_IGNORED_ACTIONS,
};
