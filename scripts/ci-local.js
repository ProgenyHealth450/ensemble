#!/usr/bin/env node
'use strict';
/**
 * ci:local -- reproduce what GitHub CI does on the COMMITTED state, in a clean
 * clone, before pushing. A developer workspace carries gitignored build output
 * (e.g. packages/agent-core/dist), stray ignored dirs and macOS shell
 * semantics; none of that exists on CI's fresh Linux checkout. This script
 * clones HEAD (never the working tree), installs, and runs the CI steps with
 * CI=true. It never touches the working tree or index of the invoking repo.
 *
 * Step list mirrors .github/workflows: test.yml (npm test, Node 22 + 24),
 * validate.yml (scripts/tests, validate, generated markdown),
 * generated-drift.yml (build pi, generate chain, git-status drift check).
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CI_NODE_MATRIX = [22, 24];

const STEPS = [
  { name: 'install', cmd: 'npm ci --legacy-peer-deps' },
  { name: 'build-pi', cmd: 'npm run build --workspace=packages/pi' },
  { name: 'scripts-tests', cmd: 'npx jest scripts/tests' },
  { name: 'validate', cmd: 'npm run validate' },
  { name: 'generate-validate', cmd: 'npm run generate:validate' },
  {
    name: 'generated-drift',
    cmd:
      'npm run generate && npm run generate:pi && npm run generate:codex && npm run generate:opencode' +
      ' && if [ -n "$(git status --porcelain)" ]; then echo "Generated output differs from committed files:"; git status --porcelain; exit 1; fi',
  },
  { name: 'test', cmd: 'npm test' },
];

function parseArgs(argv) {
  const opts = { failFast: false, keep: false, list: false, help: false, steps: null, node: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fail-fast') opts.failFast = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--list') opts.list = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--steps') opts.steps = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith('--steps=')) opts.steps = a.slice(8).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--node') opts.node = argv[++i];
    else if (a.startsWith('--node=')) opts.node = a.slice(7);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

/**
 * Pure: select the steps to run. Throws on unknown step names. When `--steps`
 * is given, steps still run in canonical order.
 */
function buildPlan(opts = {}, steps = STEPS) {
  let selected = steps;
  if (opts.steps && opts.steps.length) {
    const known = new Set(steps.map((s) => s.name));
    const unknown = opts.steps.filter((n) => !known.has(n));
    if (unknown.length) {
      throw new Error(`Unknown step(s): ${unknown.join(', ')}. Known: ${[...known].join(', ')}`);
    }
    const want = new Set(opts.steps);
    selected = steps.filter((s) => want.has(s.name));
  }
  return { steps: selected, failFast: Boolean(opts.failFast) };
}

/** Pure: render the summary table. results = [{name, status, seconds}] */
function formatSummary(results) {
  const width = Math.max(4, ...results.map((r) => r.name.length));
  const lines = [`${'STEP'.padEnd(width)}  RESULT   SECONDS`];
  for (const r of results) {
    lines.push(`${r.name.padEnd(width)}  ${r.status.padEnd(7)}  ${r.seconds.toFixed(1)}`);
  }
  const failed = results.filter((r) => r.status === 'FAIL').length;
  lines.push('');
  lines.push(failed ? `${failed} step(s) FAILED` : 'All steps passed');
  return lines.join('\n');
}

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

/** Clone the committed HEAD of repoRoot into a fresh temp dir. Returns the dir. */
function cloneHead(repoRoot) {
  const sha = git(['rev-parse', 'HEAD'], repoRoot);
  if (sha.status !== 0) throw new Error(`Not a git repo with a commit: ${repoRoot}`);
  const head = sha.stdout.trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-local-'));
  const clone = git(['clone', '--quiet', '--no-checkout', '--local', '--no-hardlinks', repoRoot, dir]);
  if (clone.status !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`git clone failed: ${clone.stderr}`);
  }
  let co = git(['checkout', '--quiet', '--detach', head], dir);
  if (co.status !== 0) {
    // HEAD not reachable from a branch (detached): fetch it explicitly.
    git(['fetch', '--quiet', repoRoot, 'HEAD'], dir);
    co = git(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], dir);
  }
  if (co.status !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`git checkout failed: ${co.stderr}`);
  }
  return dir;
}

function dirtyFiles(repoRoot) {
  const r = git(['status', '--porcelain'], repoRoot);
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
}

/** Resolve a bin dir for another Node major via npx (needs network/cache). */
function resolveNodeBinDir(major) {
  const r = spawnSync('npx', ['--yes', '-p', `node@${major}`, 'node', '-p', 'process.execPath'], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`Could not obtain Node ${major} via npx (offline?): ${(r.stderr || '').trim()}`);
  }
  return path.dirname(r.stdout.trim().split('\n').pop());
}

/**
 * Run the plan in a clean clone of repoRoot's HEAD.
 * Returns { code, results, dir }.
 */
function runCi({ repoRoot, steps = STEPS, failFast = false, keep = false, nodeBinDir = null, stdio = 'inherit', log = console.log }) {
  const dirty = dirtyFiles(repoRoot);
  if (dirty.length) {
    log('\n!!! WARNING: working tree has uncommitted/untracked changes. They are NOT under test:');
    dirty.slice(0, 20).forEach((l) => log(`      ${l}`));
    if (dirty.length > 20) log(`      ... and ${dirty.length - 20} more`);
    log('!!! Commit them to include them in the run.\n');
  }

  const dir = cloneHead(repoRoot);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned || keep) return;
    cleaned = true;
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const onSigint = () => {
    cleanup();
    process.exit(130);
  };
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigint);

  const env = { ...process.env, CI: 'true' };
  if (nodeBinDir) env.PATH = `${nodeBinDir}${path.delimiter}${env.PATH}`;

  const results = [];
  try {
    for (const step of steps) {
      log(`\n=== ${step.name}: ${step.cmd}`);
      const t0 = Date.now();
      const r = spawnSync('bash', ['-c', step.cmd], { cwd: dir, env, stdio });
      const seconds = (Date.now() - t0) / 1000;
      results.push({ name: step.name, status: r.status === 0 ? 'PASS' : 'FAIL', seconds });
      if (r.status !== 0 && failFast) break;
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigint);
    cleanup();
  }
  log(`\n${formatSummary(results)}`);
  if (keep) log(`Kept clean clone at: ${dir}`);
  return { code: results.some((r) => r.status === 'FAIL') ? 1 : 0, results, dir };
}

const HELP = `Usage: npm run ci:local -- [options]

Reproduces CI on a clean clone of the committed HEAD (no node_modules, dist or
other ignored files). Uncommitted changes are NOT tested.

Options:
  --steps a,b     run only the named steps (canonical order)
  --list          list step names and commands, then exit
  --fail-fast     stop at the first failing step (default: continue)
  --keep          keep the temp clone and print its path
  --node <major>  run steps under another Node via \`npx --yes -p node@<major>\`
                  (downloads Node; will not work offline unless cached)
  -h, --help      show this help

CI Node matrix: ${CI_NODE_MATRIX.join(', ')}. Note: "install" is required for any
other step to work, so --steps should normally include it (except when reusing --keep).`;

function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  let plan;
  try {
    plan = buildPlan(opts);
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  if (opts.list) {
    plan.steps.forEach((s) => console.log(`${s.name.padEnd(18)} ${s.cmd}`));
    return 0;
  }
  const major = Number(process.versions.node.split('.')[0]);
  console.log(`Node ${process.version} (major ${major}) ${CI_NODE_MATRIX.includes(major) ? 'is' : 'is NOT'} in the CI matrix [${CI_NODE_MATRIX.join(', ')}]`);
  let nodeBinDir = null;
  if (opts.node) {
    try {
      nodeBinDir = resolveNodeBinDir(opts.node);
      console.log(`Running steps under Node ${opts.node} from ${nodeBinDir}`);
    } catch (e) {
      console.error(e.message);
      return 2;
    }
  }
  const repoRoot = git(['rev-parse', '--show-toplevel'], process.cwd()).stdout.trim() || path.resolve(__dirname, '..');
  try {
    return runCi({ repoRoot, steps: plan.steps, failFast: plan.failFast, keep: opts.keep, nodeBinDir }).code;
  } catch (e) {
    console.error(e.message);
    return 2;
  }
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { STEPS, CI_NODE_MATRIX, parseArgs, buildPlan, formatSummary, runCi, cloneHead, main };
