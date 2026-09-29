import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import assert from 'node:assert/strict';
import {
  connectionUrlFromComponents,
  detectExampleDbKeys,
  resolveConnections,
  synthesizeConnectionFromComponents,
} from '../dist/db/env-parser.js';
import { createStudioServer } from '../dist/server/studio-server.js';
import { renderStudioHtml } from '../dist/server/studio-ui.js';

console.log('--- Starting Fragmented Config & XAMPP Parameter Mode Verification ---');

// Component keys on the host machine must not leak into the fixtures below.
for (const key of Object.keys(process.env)) {
  if (/^(PROD_)?DB_|^MYSQL_|^POSTGRES_|^PG(HOST|PORT|USER|PASSWORD|DATABASE)$|DATABASE_URL|MONGO|FIRESTORE/.test(key)) delete process.env[key];
}

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method || 'GET',
        headers: options.headers || {},
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null, raw: data });
          } catch {
            resolve({ status: res.statusCode, body: null, raw: data });
          }
        });
      },
    );
    req.on('error', reject);
    if (options.body) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    req.end();
  });
}

function postConnect(baseUrl, body) {
  return requestJson(`${baseUrl}/api/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
}

/** A loopback port with nothing listening, so connections are refused quickly. */
async function closedPort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

// ─── 1. Pure synthesis (no filesystem) ──────────────────────────────────────
{
  const xampp = synthesizeConnectionFromComponents({
    DB_CONNECTION: 'mysql',
    DB_HOST: '127.0.0.1',
    DB_PORT: '3306',
    DB_DATABASE: 'shop',
    DB_USERNAME: 'root',
    DB_PASSWORD: '',
  });
  assert.ok(xampp, 'XAMPP-style keys must synthesize a connection');
  assert.equal(xampp.url, 'mysql://root@127.0.0.1:3306/shop');
  assert.equal(xampp.engine, 'mysql');
  assert.equal(xampp.sourceKey, 'DB_HOST');
  assert.equal(xampp.config.hasPassword, false);
  assert.ok(xampp.config.sourceKeys.includes('DB_DATABASE'));

  const pg = synthesizeConnectionFromComponents({
    DB_CONNECTION: 'pgsql',
    DB_HOST: 'db.local',
    DB_DATABASE: 'my app',
    DB_USERNAME: 'app',
    DB_PASSWORD: 'p@ss:w/rd',
  });
  assert.equal(pg.engine, 'postgresql');
  assert.equal(pg.config.port, 5432, 'PostgreSQL default port applies when DB_PORT is absent');
  assert.equal(pg.url, 'postgresql://app:p%40ss%3Aw%2Frd@db.local:5432/my%20app', 'credentials and db name are percent-encoded');
  assert.equal(pg.config.hasPassword, true);
  assert.ok(!pg.config.maskedUrl.includes('p%40ss') && pg.config.maskedUrl.includes('••••••••'), 'fragmentedConfig URL is masked');
  assert.ok(!JSON.stringify(pg.config).includes('p@ss'), 'fragmentedConfig never carries the raw password');

  assert.equal(synthesizeConnectionFromComponents({ DB_CONNECTION: 'sqlite', DB_DATABASE: 'database.sqlite' }), null, 'sqlite driver is not synthesized');
  assert.equal(synthesizeConnectionFromComponents({ DB_USERNAME: 'root' }), null, 'no host or database: nothing to synthesize');
  assert.equal(synthesizeConnectionFromComponents({ DB_HOST: 'localhost', DB_PORT: '5432', DB_DATABASE: 'x' }).engine, 'postgresql', 'port 5432 implies PostgreSQL');
  assert.equal(synthesizeConnectionFromComponents({ PGHOST: 'h', PGDATABASE: 'd' }).url, 'postgresql://h:5432/d', 'libpq PG* family');
  assert.equal(synthesizeConnectionFromComponents({ MYSQL_HOST: 'h', MYSQL_DATABASE: 'd' }).engine, 'mysql', 'Docker MYSQL_* family');
  assert.equal(
    synthesizeConnectionFromComponents({ PROD_DB_HOST: 'prod.db', PROD_DB_DATABASE: 'live', PROD_DB_CONNECTION: 'mysql' }, 'prod').url,
    'mysql://prod.db:3306/live',
    'PROD_DB_* family synthesizes the Prod connection',
  );

  assert.equal(connectionUrlFromComponents({ engine: 'mysql', host: '::1', user: 'root' }), 'mysql://root@[::1]:3306', 'IPv6 hosts are bracketed');
  assert.throws(() => connectionUrlFromComponents({ engine: 'mongodb', host: 'h' }), /Unsupported engine/);
  assert.throws(() => connectionUrlFromComponents({ engine: 'mysql', host: '' }), /requires a host/);
  assert.throws(() => connectionUrlFromComponents({ engine: 'mysql', host: 'a/b' }), /Host must not/);
  assert.throws(() => connectionUrlFromComponents({ engine: 'mysql', host: 'h', port: 70000 }), /Invalid port/);
  console.log('✔ synthesizeConnectionFromComponents / connectionUrlFromComponents: MySQL, PostgreSQL, families, encoding, edge cases');
}

// ─── 2. Filesystem resolution from an XAMPP / Laravel project ───────────────
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-test-fragmented-'));
const refusedPort = await closedPort();

try {
  const laravelExample = [
    'APP_NAME=Laravel',
    'DB_CONNECTION=mysql',
    'DB_HOST=127.0.0.1',
    'DB_PORT=3306',
    'DB_DATABASE=laravel',
    'DB_USERNAME=root',
    'DB_PASSWORD=',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(tempDir, '.env.example'), laravelExample, 'utf8');
  fs.writeFileSync(
    path.join(tempDir, '.env'),
    ['DB_CONNECTION=mysql', 'DB_HOST=127.0.0.1', `DB_PORT=${refusedPort}`, 'DB_DATABASE=shop', 'DB_USERNAME=root', 'DB_PASSWORD=', ''].join('\n'),
    'utf8',
  );

  const conns = resolveConnections(tempDir);
  assert.ok(conns.dev, 'Dev connection must be synthesized when no single URI is configured');
  assert.equal(conns.dev.synthesized, true);
  assert.equal(conns.dev.engine, 'mysql');
  assert.equal(conns.dev.url, `mysql://root@127.0.0.1:${refusedPort}/shop`);
  assert.equal(conns.dev.sourceKey, 'DB_HOST');
  assert.equal(conns.prod, null, 'Prod stays unconfigured');
  console.log('✔ resolveConnections synthesizes Dev from XAMPP-style .env (template DB_HOST/DB_CONNECTION values are not mistaken for URLs)');

  const info = detectExampleDbKeys(tempDir);
  assert.equal(info.fragmentedDetected, true);
  assert.equal(info.fragmentedConfig.engine, 'mysql');
  assert.equal(info.fragmentedConfig.port, refusedPort);
  assert.equal(info.fragmentedConfig.database, 'shop');
  console.log('✔ detectExampleDbKeys reports fragmentedDetected + fragmentedConfig');

  // An explicit single URI still wins over fragmented keys.
  fs.appendFileSync(path.join(tempDir, '.env'), 'DATABASE_URL=sqlite:./app.db\n', 'utf8');
  const withUri = resolveConnections(tempDir);
  assert.equal(withUri.dev.engine, 'sqlite');
  assert.equal(withUri.dev.synthesized, undefined, 'single URI is not marked synthesized');
  fs.writeFileSync(
    path.join(tempDir, '.env'),
    fs.readFileSync(path.join(tempDir, '.env'), 'utf8').replace('DATABASE_URL=sqlite:./app.db\n', ''),
    'utf8',
  );
  console.log('✔ Explicit DATABASE_URL takes precedence over fragmented keys');

  // ─── 3. Studio server: status, env-info, POST /api/connect components ─────
  const server = createStudioServer({ cwd: tempDir, html: () => renderStudioHtml({ version: '1.0.0-test' }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const status = await requestJson(`${baseUrl}/api/status`);
    assert.equal(status.status, 200);
    assert.equal(status.body.dev.synthesized, true, 'GET /api/status marks the Dev connection as synthesized');
    assert.equal(status.body.dev.connected, false);
    assert.match(status.body.dev.error, /ECONNREFUSED/);
    console.log('✔ GET /api/status reports synthesized: true (offline on a refused port)');

    const envInfo = await requestJson(`${baseUrl}/api/env-info`);
    assert.equal(envInfo.status, 200);
    assert.equal(envInfo.body.fragmentedDetected, true);
    assert.equal(envInfo.body.fragmentedConfig.host, '127.0.0.1');
    assert.equal(envInfo.body.fragmentedConfig.user, 'root');
    assert.ok(!('password' in envInfo.body.fragmentedConfig), 'env-info never exposes a password field');
    console.log('✔ GET /api/env-info surfaces fragmentedConfig without secrets');

    const secret = 'Sup3r-Secret!';
    const connect = await postConnect(baseUrl, {
      env: 'dev',
      engine: 'mysql',
      components: { engine: 'mysql', host: '127.0.0.1', port: refusedPort, user: 'root', password: secret, database: 'shop' },
    });
    assert.equal(connect.status, 200, 'components payload is accepted');
    assert.equal(connect.body.success, false, 'refused port reports a failed ping');
    assert.equal(connect.body.engine, 'mysql');
    assert.equal(connect.body.maskedUrl, `mysql://root:••••••••@127.0.0.1:${refusedPort}/shop`);
    assert.ok(!connect.raw.includes(secret) && !connect.raw.includes(encodeURIComponent(secret)), 'password never appears in the response');
    console.log('✔ POST /api/connect accepts components and returns only a masked URL');

    const portAsString = await postConnect(baseUrl, { env: 'dev', components: { engine: 'postgresql', host: 'localhost', port: String(refusedPort) } });
    assert.equal(portAsString.status, 200);
    assert.equal(portAsString.body.maskedUrl, `postgresql://localhost:${refusedPort}`);

    const invalid = [
      [{ env: 'dev', components: { engine: 'mongodb', host: 'h' } }, /components\.engine/],
      [{ env: 'dev', components: { engine: 'mysql', host: '' } }, /components\.host/],
      [{ env: 'dev', components: { engine: 'mysql', host: 'evil@host/x' } }, /components\.host/],
      [{ env: 'dev', components: { engine: 'mysql', host: 'h', port: 99999 } }, /components\.port/],
      [{ env: 'dev', components: { engine: 'mysql', host: 'h', password: 5 } }, /components\.password/],
      [{ env: 'dev', engine: 'postgresql', components: { engine: 'mysql', host: 'h' } }, /"engine" is "postgresql"/],
      [{ env: 'dev', components: 'mysql://x' }, /"components" must be an object/],
      [{ env: 'dev' }, /"connectionUrl" or "components" is required/],
    ];
    for (const [body, pattern] of invalid) {
      const res = await postConnect(baseUrl, body);
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
      assert.match(res.body.error.message, pattern);
    }
    console.log('✔ POST /api/connect rejects invalid components with structured 400 errors');

    // ─── 4. Studio UI: parameter form, XAMPP preset, zero emojis ────────────
    const html = await requestJson(`${baseUrl}/`);
    assert.equal(html.status, 200);
    for (const needle of [
      '<option value="url">Connection URL',
      '<option value="form">Connection Form (XAMPP / Parameters)</option>',
      '<option value="firestore">Firebase Firestore</option>',
      'id="params-dev"',
      'id="params-prod"',
      'id="phost-dev"',
      'id="pport-dev"',
      'id="puser-dev"',
      'id="ppass-dev"',
      'id="pdb-dev"',
      'data-xampp="dev"',
      'data-xampp="prod"',
      'Use XAMPP Defaults',
      'badge-synth',
      'synthesized from ',
      'Ensure MySQL is started in XAMPP Control Panel.',
    ]) {
      assert.ok(html.raw.includes(needle), `UI must include ${needle}`);
    }
    assert.match(html.raw, /\$\('phost-' \+ env\)\.value = '127\.0\.0\.1'/, 'XAMPP preset fills host 127.0.0.1');
    assert.match(html.raw, /\$\('pport-' \+ env\)\.value = '3306'/, 'XAMPP preset fills port 3306');
    assert.match(html.raw, /\$\('puser-' \+ env\)\.value = 'root'/, 'XAMPP preset fills user root');
    assert.match(html.raw, /\$\('ppass-' \+ env\)\.value = ''/, 'XAMPP preset leaves the password empty');
    assert.match(html.raw, /\$\('pengine-' \+ env\)\.value = 'mysql'/, 'XAMPP preset selects MySQL');

    const script = html.raw.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(script, 'studio page has an inline script');
    assert.doesNotThrow(() => new Function(script[1]), 'client script parses');

    assert.equal(/\p{Extended_Pictographic}/u.test(html.raw), false, 'UI HTML must contain ZERO emojis');
    console.log('✔ Studio UI: connection mode selector, parameter grid, XAMPP preset, synthesized badge, ZERO emojis');
  } finally {
    server.close();
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('\nAll Fragmented Config & XAMPP Parameter Mode tests PASSED successfully!\n');
