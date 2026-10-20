/**
 * Critical path smoke test: runs configured journeys; each step is a command or an HTTP call.
 *
 * Config: { baseUrl?, timeout?, journeys: [{ name, steps: [
 *   { command, expectExit? = 0, expectOutput? }
 *   | { path|url, method? = 'GET', body?, headers?, expectedStatus? = 200, expectBodyContains? } ] }] }
 */
const { notConfigured, summarize, request, runCommand } = require('../../smoke-test-runner/scripts/smoke-util.js');

class SmokeTestCriticalPaths {
  constructor(config = {}) {
    this.config = { timeout: 30000, journeys: [], ...config };
  }

  async runStep(step) {
    if (step.command) {
      const out = await runCommand(step.command, { timeout: this.config.timeout });
      const want = step.expectExit === undefined ? 0 : step.expectExit;
      if (out.code !== want) return `command "${step.command}" exit ${out.code} (expected ${want}): ${(out.stderr || out.stdout).trim().slice(0, 150)}`;
      if (step.expectOutput !== undefined && !out.stdout.includes(String(step.expectOutput))) return `output missing "${step.expectOutput}"`;
      return null;
    }
    const url = step.url || (this.config.baseUrl && step.path ? this.config.baseUrl + step.path : null);
    if (!url) return 'step needs command, url, or path (+ baseUrl)';
    const res = await request(url, { method: step.method || 'GET', headers: step.headers, body: step.body, timeout: this.config.timeout });
    const want = step.expectedStatus === undefined ? 200 : step.expectedStatus;
    if (res.status === null) return `request failed: ${res.error}`;
    if (res.status !== want) return `${step.method || 'GET'} ${url} -> HTTP ${res.status} (expected ${want})`;
    if (step.expectBodyContains !== undefined && !res.body.includes(String(step.expectBodyContains))) return `body missing "${step.expectBodyContains}"`;
    return null;
  }

  async executeTests() {
    const journeys = (this.config.journeys || []).filter(j => j && Array.isArray(j.steps) && j.steps.length);
    if (!journeys.length) {
      return notConfigured('critical paths', 'set criticalPaths.journeys[] with steps in smoke-tests.json');
    }
    const results = [];
    for (const journey of journeys) {
      const start = Date.now();
      let failure = null;
      for (let i = 0; i < journey.steps.length && !failure; i++) {
        const err = await this.runStep(journey.steps[i]);
        if (err) failure = `step ${i + 1}: ${err}`;
      }
      results.push({ name: journey.name || 'journey', passed: !failure, reason: failure || `ok (${Date.now() - start}ms)` });
    }
    return summarize('critical path', results);
  }
}

module.exports = { SmokeTestCriticalPaths };

if (require.main === module) {
  const { loadSmokeConfig } = require('../../smoke-test-runner/scripts/smoke-util.js');
  const cfg = (loadSmokeConfig(process.argv[2]) || {}).criticalPaths || {};
  new SmokeTestCriticalPaths(cfg).executeTests().then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.passed ? 0 : 1);
  });
}
