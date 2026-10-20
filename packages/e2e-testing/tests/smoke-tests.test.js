const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const skills = path.join(__dirname, '..', 'skills');
const scripts = `${skills}/smoke-test-runner/scripts`;
const { SmokeTestAuth } = require(`${scripts}/test-auth-flows.js`);
const { SmokeTestDatabase } = require(`${scripts}/test-connectivity.js`);
const { SmokeTestExternalServices } = require(`${scripts}/test-integrations.js`);
const { SmokeTestCriticalPaths } = require(`${scripts}/execute-journeys.js`);
const { SmokeTestRunner } = require(`${scripts}/orchestrate-smoke-tests.js`);

let server;
let base;
beforeAll(done => {
  server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/health') return send(200, { ok: true });
    if (req.url === '/broken') return send(500, { ok: false });
    if (req.url === '/login') return send(200, { token: 'real-token' });
    if (req.url === '/login-bad') return send(401, {});
    if (req.url === '/me') return req.headers.authorization === 'Bearer real-token' ? send(200, {}) : send(401, {});
    if (req.url === '/open') return send(200, {});
    return send(404, {});
  }).listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll(done => { server.closeAllConnections(); server.close(() => done()); });

const auth = extra => ({ baseUrl: base, login: { path: '/login', body: { u: 'a' } }, protected: { path: '/me' }, ...extra });

describe('auth', () => {
  test('passes against a correct service', async () => {
    const r = await new SmokeTestAuth(auth()).executeTests();
    expect(r.status).toBe('passed');
  });
  test('fails when login is rejected', async () => {
    const r = await new SmokeTestAuth(auth({ login: { path: '/login-bad', body: {} } })).executeTests();
    expect(r.passed).toBe(false);
    expect(r.results.find(x => x.name === 'login').passed).toBe(false);
  });
  test('fails when protected route is open to anonymous callers', async () => {
    const r = await new SmokeTestAuth(auth({ protected: { path: '/open' } })).executeTests();
    expect(r.results.find(x => x.name === 'protected-rejects-anonymous').passed).toBe(false);
  });
  test('unconfigured is NOT CONFIGURED, not a pass', async () => {
    const r = await new SmokeTestAuth({}).executeTests();
    expect(r.passed).toBe(false);
    expect(r.status).toBe('not-configured');
    expect(r.reason).toMatch(/NOT CONFIGURED/);
  });
});

describe('external services', () => {
  test('healthy passes, 500 fails, dead host fails', async () => {
    const ok = await new SmokeTestExternalServices({ services: [{ name: 'a', url: `${base}/health` }] }).executeTests();
    expect(ok.passed).toBe(true);
    const bad = await new SmokeTestExternalServices({ services: [{ name: 'a', url: `${base}/broken` }] }).executeTests();
    expect(bad.passed).toBe(false);
    const dead = await new SmokeTestExternalServices({ timeout: 500, services: [{ name: 'd', url: 'http://127.0.0.1:1/x' }] }).executeTests();
    expect(dead.passed).toBe(false);
  });
  test('unconfigured is not a pass', async () => {
    const r = await new SmokeTestExternalServices({}).executeTests();
    expect(r.status).toBe('not-configured');
    expect(r.passed).toBe(false);
  });
});

describe('database', () => {
  const hasSqlite = spawnSync('sqlite3', ['--version']).status === 0;
  (hasSqlite ? test : test.skip)('real SELECT 1 passes; failing query fails', async () => {
    const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-db-')), 't.db');
    const ok = await new SmokeTestDatabase({ command: `sqlite3 ${db} 'SELECT 1'`, expectOutput: '1' }).executeTests();
    expect(ok.passed).toBe(true);
    const bad = await new SmokeTestDatabase({ command: `sqlite3 ${db} 'SELECT * FROM missing_table'` }).executeTests();
    expect(bad.passed).toBe(false);
  });
  test('expectOutput mismatch and missing binary fail', async () => {
    expect((await new SmokeTestDatabase({ command: 'echo 2', expectOutput: '1' }).executeTests()).passed).toBe(false);
    expect((await new SmokeTestDatabase({ command: 'definitely-not-a-db-cli' }).executeTests()).passed).toBe(false);
  });
  test('unconfigured is not a pass', async () => {
    const r = await new SmokeTestDatabase({}).executeTests();
    expect(r.status).toBe('not-configured');
  });
});

describe('critical paths', () => {
  test('command and http steps are asserted', async () => {
    const ok = await new SmokeTestCriticalPaths({ baseUrl: base, journeys: [{ name: 'j', steps: [{ command: 'true' }, { path: '/health', expectBodyContains: 'ok' }] }] }).executeTests();
    expect(ok.passed).toBe(true);
    const badCmd = await new SmokeTestCriticalPaths({ journeys: [{ name: 'j', steps: [{ command: 'false' }] }] }).executeTests();
    expect(badCmd.passed).toBe(false);
    const badHttp = await new SmokeTestCriticalPaths({ baseUrl: base, journeys: [{ name: 'j', steps: [{ path: '/broken' }] }] }).executeTests();
    expect(badHttp.passed).toBe(false);
  });
  test('unconfigured is not a pass', async () => {
    expect((await new SmokeTestCriticalPaths({}).executeTests()).status).toBe('not-configured');
  });
});

describe('runner verdict', () => {
  const full = () => ({
    api: { baseUrl: base, retries: 0, endpoints: [{ path: '/health', method: 'GET', expectedStatus: 200 }] },
    database: { command: 'echo 1', expectOutput: '1' },
    externalServices: { services: [{ name: 'x', url: `${base}/health` }] },
    auth: auth(),
    criticalPaths: { baseUrl: base, journeys: [{ name: 'j', steps: [{ path: '/health' }] }] }
  });
  const run = (smokeConfig, extra = {}) => new SmokeTestRunner({ smokeConfig, ...extra }).executeAll();
  let logSpy;
  beforeEach(() => { logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => logSpy.mockRestore());

  test('all configured and healthy: passed', async () => {
    const r = await run(full());
    expect(r.status).toBe('passed');
    expect(r.categoriesExecuted).toBe(5);
  });
  test('empty config is incomplete, never passed', async () => {
    const r = await run({});
    expect(r.passed).toBe(false);
    expect(r.status).toBe('incomplete');
    expect(r.categoriesNotConfigured).toBe(5);
  });
  test('a required category that is not configured blocks the pass', async () => {
    const cfg = full();
    delete cfg.database;
    const r = await run(cfg);
    expect(r.passed).toBe(false);
    expect(r.results.database.status).toBe('not-configured');
  });
  test('optional unconfigured category does not block', async () => {
    const cfg = full();
    delete cfg.database;
    const r = await run(cfg, { required: ['api', 'auth', 'externalServices', 'criticalPaths'] });
    expect(r.passed).toBe(true);
  });
  test('a failing category fails the verdict', async () => {
    const cfg = full();
    cfg.externalServices = { services: [{ name: 'x', url: `${base}/broken` }] };
    const r = await run(cfg);
    expect(r.status).toBe('failed');
  });
});

describe('runner CLI exit codes', () => {
  const cli = path.join(skills, 'smoke-test-runner/scripts/orchestrate-smoke-tests.js');
  test('exits non-zero when no config exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-cli-'));
    const r = spawnSync('node', [cli], { cwd: dir, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/NOT CONFIGURED/);
  });
});

describe('S1: failure reasons never leak subprocess output', () => {
  const leaky = "echo 'FATAL postgres://u:hunter2@host/db password=s3cr3tpw' >&2; exit 2";
  const { SmokeTestAPI } = require(`${scripts}/execute-health-checks.js`);
  const { redact } = require(`${scripts}/smoke-util.js`);

  test('database reason omits output by default', async () => {
    const r = await new SmokeTestDatabase({ command: leaky }).executeTests();
    expect(r.passed).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/hunter2|s3cr3tpw/);
    expect(r.reason).toMatch(/exit 2/);
  });
  test('critical-path command step omits output by default', async () => {
    const r = await new SmokeTestCriticalPaths({ journeys: [{ name: 'j', steps: [{ command: leaky }] }] }).executeTests();
    expect(JSON.stringify(r)).not.toMatch(/hunter2|s3cr3tpw/);
    expect(r.reason).toMatch(/exit 2/);
  });
  test('includeOutput masks credentials and bounds the snippet', async () => {
    const r = await new SmokeTestDatabase({ command: leaky, includeOutput: true }).executeTests();
    expect(JSON.stringify(r)).not.toMatch(/hunter2|s3cr3tpw/);
    expect(r.reason).toMatch(/postgres:\/\/\[REDACTED\]@host\/db/);
  });
  test('redact masks bearer, auth headers, key=value, long tokens; bounded to 300', () => {
    const out = redact('Authorization: Bearer abc.def token=xyz API_KEY: k123 ' + 'A1b2'.repeat(12) + ' ' + 'z'.repeat(500));
    expect(out).not.toMatch(/abc\.def|xyz|k123|A1b2A1b2/);
    expect(redact('x'.repeat(20) + ' y'.repeat(400)).length).toBeLessThanOrEqual(300);
  });
  test('runner propagates no output into the verdict, top-level includeOutput masks it', async () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const off = await new SmokeTestRunner({ smokeConfig: { database: { command: leaky } }, categories: ['database'] }).executeAll();
      expect(JSON.stringify(off)).not.toMatch(/hunter2|s3cr3tpw/);
      const on = await new SmokeTestRunner({ smokeConfig: { includeOutput: true, database: { command: leaky } }, categories: ['database'] }).executeAll();
      expect(JSON.stringify(on)).not.toMatch(/hunter2|s3cr3tpw/);
      expect(on.reason).toMatch(/REDACTED/);
    } finally { spy.mockRestore(); }
  });
  test('missing binary and timeout are described without output', async () => {
    const r = await new SmokeTestDatabase({ command: 'definitely-not-a-db-cli' }).executeTests();
    expect(r.reason).toMatch(/exit 127 \(command not found\)/);
    const t = await new SmokeTestDatabase({ command: 'sleep 5', timeout: 100 }).executeTests();
    expect(t.reason).toMatch(/timeout after 100ms/);
  });
  test('a timeout returns promptly even when the command has a child process holding its output', async () => {
    const started = Date.now();
    const t = await new SmokeTestDatabase({ command: 'sleep 4; echo done', timeout: 150 }).executeTests();
    expect(t.reason).toMatch(/timeout after 150ms/);
    expect(Date.now() - started).toBeLessThan(2500);
  });
  test('API health checks report a status key and survive malformed endpoints', async () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const ok = await new SmokeTestAPI({ baseUrl: base, retries: 0 }).executeHealthChecks({ environment: 't', endpoints: [{ path: '/health', method: 'GET', expectedStatus: 200 }] });
      expect(ok.status).toBe('passed');
      const bad = await new SmokeTestAPI({ baseUrl: base, retries: 0 }).executeHealthChecks({ environment: 't', endpoints: [{ path: '/broken', method: 'GET', expectedStatus: 200 }, null] });
      expect(bad.status).toBe('failed');
      expect(bad.passed).toBe(false);
    } finally { spy.mockRestore(); }
  });
});

describe('S2: malformed check entries yield structured failures', () => {
  test('database entry without command fails naming the check', async () => {
    const r = await new SmokeTestDatabase({ checks: [{ name: 'ping' }] }).executeTests();
    expect(r.status).toBe('failed');
    expect(r.reason).toMatch(/check ping has no command/);
  });
  test('database: null / string / wrong-typed entries never throw', async () => {
    const r = await new SmokeTestDatabase({ checks: [null, 'psql', { command: 42 }, { name: 'ok', command: 'true' }] }).executeTests();
    expect(r.status).toBe('failed');
    expect(r.details).toMatchObject({ total: 4, failed: 3 });
    expect((await new SmokeTestDatabase({ checks: 'psql' }).executeTests()).status).toBe('failed');
  });
  test('external services: malformed entries fail, never throw', async () => {
    const r = await new SmokeTestExternalServices({ services: [null, 'x', { name: 'nourl' }, { name: 'ok', url: `${base}/health` }] }).executeTests();
    expect(r.status).toBe('failed');
    expect(r.details).toMatchObject({ total: 4, failed: 3 });
    expect(r.reason).toMatch(/service nourl has no url/);
    expect((await new SmokeTestExternalServices({ services: {} }).executeTests()).status).toBe('failed');
  });
  test('critical paths: malformed journeys/steps fail, never throw or get skipped', async () => {
    const r = await new SmokeTestCriticalPaths({ journeys: [null, { name: 'empty' }, { name: 's', steps: [null] }, { name: 'c', steps: [{ command: 5 }] }] }).executeTests();
    expect(r.status).toBe('failed');
    expect(r.details).toMatchObject({ total: 4, failed: 4 });
    expect((await new SmokeTestCriticalPaths({ journeys: 'x' }).executeTests()).status).toBe('failed');
  });
  test('auth: malformed sections are not-configured, never throw', async () => {
    expect((await new SmokeTestAuth({ baseUrl: base, login: 'x', protected: 5 }).executeTests()).status).toBe('not-configured');
    expect((await new SmokeTestAuth({ baseUrl: base, login: null, protected: null }).executeTests()).status).toBe('not-configured');
  });
});

describe('S3: unloadable config still yields a verdict envelope', () => {
  const cli = path.join(skills, 'smoke-test-runner/scripts/orchestrate-smoke-tests.js');
  const verdict = stdout => JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1));
  test('missing explicit --config', () => {
    const r = spawnSync('node', [cli, '--config', '/nonexistent/smoke-tests.json'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    const v = verdict(r.stdout);
    expect(v.status).toBe('failed');
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/smoke config not found/);
    expect(r.stdout + r.stderr).not.toMatch(/\n\s+at /);
  });
  test('unparseable config does not echo its content', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-bad-'));
    const file = path.join(dir, 'smoke-tests.json');
    fs.writeFileSync(file, '{ "password": "hunter2", ');
    const r = spawnSync('node', [cli, '--config', file], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    const v = verdict(r.stdout);
    expect(v.status).toBe('failed');
    expect(v.reason).toMatch(/could not be parsed/);
    expect(r.stdout + r.stderr).not.toMatch(/hunter2|\n\s+at /);
  });
});

describe('includeOutput covers both streams, masks before truncating', () => {
  test('stderr noise + stdout secret is masked, never leaked', async () => {
    const cmd = "echo 'warn ok' >&2; echo 'password=hunter2'; exit 3";
    const on = await new SmokeTestDatabase({ command: cmd, includeOutput: true }).executeTests();
    expect(on.reason).not.toMatch(/hunter2/);
    expect(on.reason).toMatch(/warn ok/);
    expect(on.reason).toMatch(/password=\[REDACTED\]/);
    const off = await new SmokeTestDatabase({ command: cmd }).executeTests();
    expect(off.reason).not.toMatch(/hunter2|warn ok/);
  });
  test('secret straddling the 300-char boundary is not partially exposed', async () => {
    const cmd = `printf '%0250d' 0 | tr 0 x >&2; echo; echo 'password=hunter2secretvalue'; exit 3`;
    const r = await new SmokeTestDatabase({ command: cmd, includeOutput: true }).executeTests();
    expect(r.reason).not.toMatch(/hunter|secretvalue/);
  });
  test('a secret whose keyword ends stderr and whose value starts stdout is masked', async () => {
    const cmd = "printf 'connecting with password=' >&2; printf 'hunter2value'; exit 3";
    const r = await new SmokeTestDatabase({ command: cmd, includeOutput: true }).executeTests();
    expect(r.reason).not.toMatch(/hunter2value/);
  });
});
