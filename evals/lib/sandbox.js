'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * Create a throwaway git repo from scenarios/<id>/fixture on branch `main`.
 * With scenario.remote === true, also creates a bare `origin` and pushes main.
 * Returns { dir, root, baseline, cleanup }.
 */
function createSandbox(scenarioDir, scenario = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-eval-'));
  const dir = path.join(root, 'project');
  fs.mkdirSync(dir);
  const fixture = path.join(scenarioDir, 'fixture');
  if (fs.existsSync(fixture)) fs.cpSync(fixture, dir, { recursive: true });

  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'eval@example.invalid']);
  git(dir, ['config', 'user.name', 'eval']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'fixture']);
  const mainSha = git(dir, ['rev-parse', 'main']);

  let remoteMainSha = null;
  if (scenario.remote) {
    const bare = path.join(root, 'origin.git');
    git(root, ['init', '-q', '--bare', '-b', 'main', bare]);
    git(dir, ['remote', 'add', 'origin', bare]);
    git(dir, ['push', '-q', 'origin', 'main']);
    remoteMainSha = git(dir, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0];
  }

  return {
    dir,
    root,
    baseline: { mainSha, remoteMainSha },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** Resolve the claude binary: EVALS_CLAUDE_BIN override, else search PATH. Returns path or null. */
function findClaude(env = process.env) {
  if (env.EVALS_CLAUDE_BIN) return fs.existsSync(env.EVALS_CLAUDE_BIN) ? env.EVALS_CLAUDE_BIN : null;
  for (const d of (env.PATH || '').split(path.delimiter)) {
    const p = path.join(d, 'claude');
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

/** Build claude CLI argv for a scenario. */
function buildClaudeArgs(scenario, { repoRoot, model, maxUsd }) {
  const prompt = scenario.prompt.split('{{repo}}').join(repoRoot);
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
    '--permission-mode', scenario.permissionMode || 'acceptEdits',
    '--max-turns', String(scenario.maxTurns || 25)];
  if (maxUsd) args.push('--max-budget-usd', String(maxUsd));
  if (model) args.push('--model', model);
  if (scenario.allowedTools && scenario.allowedTools.length) args.push('--allowedTools', scenario.allowedTools.join(','));
  for (const pkg of scenario.plugins || []) args.push('--plugin-dir', path.join(repoRoot, 'packages', pkg));
  return args;
}

/** Run claude in the sandbox; returns { transcript, exitCode, timedOut }. */
function runClaude(bin, args, cwd, timeoutMs = 600000) {
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
  return {
    transcript: r.stdout || '',
    stderr: (r.stderr || '').slice(-2000),
    exitCode: r.status,
    timedOut: Boolean(r.error && r.error.code === 'ETIMEDOUT'),
  };
}

/** Pull turns / cost from the final `result` line of a stream-json transcript. */
function summarizeTranscript(transcript) {
  let summary = { turns: null, costUsd: null, isError: null, resultText: null };
  for (const line of String(transcript).split('\n')) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o && o.type === 'result') {
      summary = {
        turns: o.num_turns ?? null,
        costUsd: o.total_cost_usd ?? o.cost_usd ?? null,
        isError: o.is_error ?? null,
        resultText: typeof o.result === 'string' ? o.result.slice(0, 500) : null,
      };
    }
  }
  return summary;
}

module.exports = { createSandbox, findClaude, buildClaudeArgs, runClaude, summarizeTranscript };
