#!/usr/bin/env node
'use strict';

/**
 * Headless behavioral eval runner.
 * Usage: node evals/run.js [--scenario <id>] [--model <id>] [--dry-run] [--max-usd N]
 */

const fs = require('fs');
const path = require('path');
const { runGraders } = require('./lib/graders');
const sandbox = require('./lib/sandbox');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCENARIOS_DIR = path.join(__dirname, 'scenarios');
const RESULTS_DIR = process.env.EVALS_RESULTS_DIR || path.join(__dirname, 'results');

function parseArgs(argv) {
  const o = { scenario: null, model: null, dryRun: false, maxUsd: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--scenario') o.scenario = argv[++i];
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--max-usd') o.maxUsd = Number(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (o.maxUsd !== null && !(o.maxUsd > 0)) throw new Error('--max-usd must be a positive number');
  return o;
}

function loadScenarios(dir = SCENARIOS_DIR) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'scenario.json')))
    .map((e) => {
      const scenarioDir = path.join(dir, e.name);
      const s = JSON.parse(fs.readFileSync(path.join(scenarioDir, 'scenario.json'), 'utf8'));
      return { ...s, id: s.id || e.name, type: s.type || 'agent', scenarioDir };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function runScenario(scenario, { bin, model, remainingUsd, repoRoot }) {
  const sb = sandbox.createSandbox(scenario.scenarioDir, scenario);
  const started = Date.now();
  try {
    let transcript = '';
    let run = { exitCode: 0, stderr: '', timedOut: false };
    if (scenario.type === 'agent') {
      const args = sandbox.buildClaudeArgs(scenario, { repoRoot, model, maxUsd: remainingUsd });
      run = sandbox.runClaude(bin, args, sb.dir, (scenario.timeoutSec || 600) * 1000);
      transcript = run.transcript;
    }
    const ctx = { dir: sb.dir, repoRoot, baseline: sb.baseline, transcript };
    const graders = runGraders(scenario.graders || [], ctx);
    const summary = sandbox.summarizeTranscript(transcript);
    return {
      id: scenario.id,
      type: scenario.type,
      pass: graders.length > 0 && graders.every((g) => g.pass),
      graders,
      turns: summary.turns,
      costUsd: summary.costUsd,
      claudeExitCode: run.exitCode,
      claudeResult: summary.resultText || (run.exitCode ? transcript.slice(-500) : undefined),
      timedOut: run.timedOut,
      stderr: run.stderr || undefined,
      durationMs: Date.now() - started,
    };
  } finally {
    sb.cleanup();
  }
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  let scenarios = loadScenarios();
  if (opts.scenario) {
    scenarios = scenarios.filter((s) => s.id === opts.scenario);
    if (scenarios.length === 0) {
      console.error(`unknown scenario: ${opts.scenario}`);
      return 2;
    }
  }
  const bin = sandbox.findClaude();
  const needsClaude = scenarios.some((s) => s.type === 'agent');

  if (opts.dryRun) {
    console.log(`${scenarios.length} scenario(s):`);
    for (const s of scenarios) {
      console.log(`  ${s.id} [${s.type}] graders: ${(s.graders || []).map((g) => g.type).join(', ')}`);
      console.log(`      ${s.description || ''}`);
    }
    if (needsClaude && !bin) console.log('SKIP: `claude` CLI not found on PATH; agent scenarios would not run.');
    return 0;
  }
  if (needsClaude && !bin) {
    console.error('SKIP: `claude` CLI not found on PATH (set EVALS_CLAUDE_BIN to override); cannot run agent scenarios.');
    return 3;
  }

  const results = [];
  let spent = 0;
  for (const s of scenarios) {
    const remainingUsd = opts.maxUsd ? Math.max(opts.maxUsd - spent, 0) : null;
    if (opts.maxUsd && s.type === 'agent' && remainingUsd <= 0) {
      results.push({ id: s.id, type: s.type, pass: false, skipped: 'budget exhausted', graders: [] });
      continue;
    }
    console.log(`running ${s.id} ...`);
    const r = runScenario(s, { bin, model: opts.model, remainingUsd, repoRoot: REPO_ROOT });
    spent += r.costUsd || 0;
    results.push(r);
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'} turns=${r.turns} cost=${r.costUsd}`);
    for (const g of r.graders) console.log(`    ${g.pass ? 'ok  ' : 'FAIL'} ${g.type}: ${g.detail}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const modelTag = (opts.model || 'default').replace(/[^A-Za-z0-9._-]/g, '_');
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const file = path.join(RESULTS_DIR, `${modelTag}-${stamp}.json`);
  const report = {
    model: opts.model || 'default',
    startedAt: new Date().toISOString(),
    maxUsd: opts.maxUsd,
    totalCostUsd: spent,
    passed: results.filter((r) => r.pass).length,
    total: results.length,
    results,
  };
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`results: ${path.relative(process.cwd(), file)} (${report.passed}/${report.total} passed)`);
  return report.passed === report.total ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
  }
}

module.exports = { parseArgs, loadScenarios, runScenario, main };
