/**
 * Database smoke test: runs configured CLI commands (psql, mysql, redis-cli, sqlite3, ...)
 * and requires exit code 0 (and optional output match).
 *
 * Config: { timeout?, checks: [{ name, command, expectOutput? }] }  or  { command, expectOutput? }
 * Example: { "command": "psql \"$DATABASE_URL\" -tAc 'SELECT 1'", "expectOutput": "1" }
 */
const { notConfigured, summarize, runCommand } = require('../../smoke-test-runner/scripts/smoke-util.js');

class SmokeTestDatabase {
  constructor(config = {}) {
    this.config = { timeout: 30000, ...config };
  }

  async executeTests() {
    const checks = this.config.checks || (this.config.command ? [{ name: 'connectivity', command: this.config.command, expectOutput: this.config.expectOutput }] : []);
    if (!checks.length) {
      return notConfigured('database', 'set database.command (e.g. psql "$DATABASE_URL" -tAc "SELECT 1") in smoke-tests.json');
    }
    const results = [];
    for (const check of checks) {
      const name = check.name || check.command;
      const out = await runCommand(check.command, { timeout: this.config.timeout });
      if (out.code !== 0) {
        results.push({ name, passed: false, reason: `exit ${out.code}: ${(out.stderr || out.stdout).trim().slice(0, 200)}` });
      } else if (check.expectOutput !== undefined && !out.stdout.includes(String(check.expectOutput))) {
        results.push({ name, passed: false, reason: `output did not contain "${check.expectOutput}"` });
      } else {
        results.push({ name, passed: true, reason: `ok (${out.ms}ms)` });
      }
    }
    return summarize('database', results);
  }
}

module.exports = { SmokeTestDatabase };

if (require.main === module) {
  const { loadSmokeConfig } = require('../../smoke-test-runner/scripts/smoke-util.js');
  const cfg = (loadSmokeConfig(process.argv[2]) || {}).database || {};
  new SmokeTestDatabase(cfg).executeTests().then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.passed ? 0 : 1);
  });
}
