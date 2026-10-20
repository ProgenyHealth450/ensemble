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
