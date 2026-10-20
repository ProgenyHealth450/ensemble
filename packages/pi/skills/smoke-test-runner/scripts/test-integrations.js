/**
 * External services smoke test: real HTTP health probes with a timeout.
 *
 * Config: { timeout?, services: [{ name, url, method? = 'GET', expectedStatus? = 200 (number or array), headers? }] }
 */
const { notConfigured, summarize, request } = require('../../smoke-test-runner/scripts/smoke-util.js');

class SmokeTestExternalServices {
  constructor(config = {}) {
    this.config = { timeout: 10000, services: [], ...config };
  }

  async executeTests() {
    const services = this.config.services || [];
    if (!services.length) {
      return notConfigured('external services', 'set externalServices.services[] with name and url in smoke-tests.json');
    }
    const results = [];
    for (const svc of services) {
      const expected = [].concat(svc.expectedStatus === undefined ? 200 : svc.expectedStatus);
      const res = await request(svc.url, { method: svc.method || 'GET', headers: svc.headers, timeout: svc.timeout || this.config.timeout });
      const name = svc.name || svc.url;
      if (res.status === null) results.push({ name, passed: false, reason: `request failed: ${res.error}` });
      else if (!expected.includes(res.status)) results.push({ name, passed: false, reason: `HTTP ${res.status} (expected ${expected.join('/')})` });
      else results.push({ name, passed: true, reason: `HTTP ${res.status} (${res.ms}ms)` });
    }
    return summarize('external service', results);
  }
}

module.exports = { SmokeTestExternalServices };

if (require.main === module) {
  const { loadSmokeConfig } = require('../../smoke-test-runner/scripts/smoke-util.js');
  const cfg = (loadSmokeConfig(process.argv[2]) || {}).externalServices || {};
  new SmokeTestExternalServices(cfg).executeTests().then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.passed ? 0 : 1);
  });
}
