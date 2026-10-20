/**
 * Shared helpers for the smoke-test category scripts.
 * Every category returns { passed, status, reason, details, results } where
 * status is 'passed' | 'failed' | 'not-configured'. 'not-configured' is NEVER a pass.
 */
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CONFIG_FILENAMES = ['smoke-tests.json', 'smoke-tests.yaml', 'smoke-tests.yml'];

function notConfigured(category, hint) {
  return {
    passed: false,
    status: 'not-configured',
    reason: `NOT CONFIGURED: ${category} - ${hint}`,
    details: {},
    results: []
  };
}

function summarize(label, results) {
  const failed = results.filter(r => !r.passed);
  const passed = failed.length === 0 && results.length > 0;
  return {
    passed,
    status: passed ? 'passed' : 'failed',
    reason: passed
      ? `All ${results.length} ${label} checks passed`
      : `${failed.length}/${results.length} ${label} checks failed: ${failed.map(f => `${f.name} (${f.reason})`).join('; ')}`,
    details: { total: results.length, passed: results.length - failed.length, failed: failed.length },
    results
  };
}

/** HTTP request; never throws. Resolves { status, body, ms, error }. */
function request(url, { method = 'GET', headers = {}, body, timeout = 10000 } = {}) {
  return new Promise(resolve => {
    const start = Date.now();
    let target;
    try { target = new URL(url); } catch (e) { return resolve({ status: null, body: '', ms: 0, error: `invalid URL: ${url}` }); }
    const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = { ...headers };
    if (payload !== undefined && !Object.keys(h).some(k => k.toLowerCase() === 'content-type')) h['Content-Type'] = 'application/json';
    if (payload !== undefined) h['Content-Length'] = Buffer.byteLength(payload);
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(target, { method, headers: h, timeout }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, ms: Date.now() - start }));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeout}ms`)));
    req.on('error', e => resolve({ status: null, body: '', ms: Date.now() - start, error: e.message }));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** Run a shell command; never throws. Resolves { code, stdout, stderr, ms }. */
function runCommand(command, { timeout = 30000, cwd, env } = {}) {
  return new Promise(resolve => {
    const start = Date.now();
    const child = spawn(command, { shell: true, cwd, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', e => { clearTimeout(timer); resolve({ code: null, stdout, stderr: e.message, ms: Date.now() - start }); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code, stdout, stderr: timedOut ? `timeout after ${timeout}ms` : stderr, ms: Date.now() - start });
    });
  });
}

/** Load smoke-tests.json|yaml from an explicit path or cwd. Returns null when absent. */
function loadSmokeConfig(explicitPath, cwd = process.cwd()) {
  const candidates = explicitPath ? [explicitPath] : CONFIG_FILENAMES.map(f => path.join(cwd, f));
  for (const file of candidates) {
    if (!fs.existsSync(file)) {
      if (explicitPath) throw new Error(`smoke config not found: ${file}`);
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    if (file.endsWith('.json')) return JSON.parse(text);
    return require('js-yaml').load(text);
  }
  return null;
}

module.exports = { notConfigured, summarize, request, runCommand, loadSmokeConfig, CONFIG_FILENAMES };
