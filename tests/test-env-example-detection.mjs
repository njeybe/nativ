import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import { detectExampleDbKeys, resolveConnections } from '../dist/db/env-parser.js';
import { createStudioServer } from '../dist/server/studio-server.js';
import { renderStudioHtml } from '../dist/server/studio-ui.js';

console.log('--- Starting Template Auto-Detection (.env.example) Verification ---');

// Helper to make HTTP requests
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

// 1. Create a sandbox directory
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-test-env-'));

try {
  // Write a multi-engine .env.example file
  const exampleContent = `
# MongoDB database connection
MONGO_URI=mongodb://localhost:27017/my_app

# PostgreSQL Production Database
PROD_DATABASE_URL=postgres://prod_user:secret@db.prod.com:5432/proddb

# Local SQLite Cache
SQLITE_DB=./cache.db

# MySQL Store
MYSQL_URL=mysql://root:pass@127.0.0.1:3306/shop

# Firebase Firestore project
FIRESTORE_URL=firestore://my-firebase-app
`;

  fs.writeFileSync(path.join(tempDir, '.env.example'), exampleContent, 'utf8');

  // Test detectExampleDbKeys
  const detected = detectExampleDbKeys(tempDir);
  assert.equal(detected.templateFound, true, 'templateFound must be true');
  assert.equal(detected.templateFile, '.env.example', 'templateFile must match .env.example');
  assert.equal(detected.detectedKeys.length, 5, 'Should detect 5 database keys');

  const keyMap = Object.fromEntries(detected.detectedKeys.map((k) => [k.key, k]));
  assert.equal(keyMap.MONGO_URI.engine, 'mongodb');
  assert.equal(keyMap.MONGO_URI.targetEnv, 'dev');
  assert.equal(keyMap.MONGO_URI.isConfiguredInEnv, false);

  assert.equal(keyMap.PROD_DATABASE_URL.engine, 'postgresql');
  assert.equal(keyMap.PROD_DATABASE_URL.targetEnv, 'prod');
  assert.equal(keyMap.PROD_DATABASE_URL.isConfiguredInEnv, false);

  assert.equal(keyMap.SQLITE_DB.engine, 'sqlite');
  assert.equal(keyMap.MYSQL_URL.engine, 'mysql');
  assert.equal(keyMap.FIRESTORE_URL.engine, 'firestore');

  console.log('✔ detectExampleDbKeys accurately detected all 5 database engines and environment targets');

  // Test 2: Write actual .env containing MONGO_URI
  fs.writeFileSync(path.join(tempDir, '.env'), 'MONGO_URI=mongodb://localhost:27017/actual_dev_db\n', 'utf8');

  const conns = resolveConnections(tempDir);
  assert.ok(conns.dev, 'Dev connection should be resolved from MONGO_URI');
  assert.equal(conns.dev.engine, 'mongodb');
  assert.equal(conns.dev.sourceKey, 'MONGO_URI');
  assert.equal(conns.dev.detectedFromExample, true);
  assert.equal(conns.dev.exampleFile, '.env.example');
  assert.ok(conns.dev.maskedUrl.includes('localhost:27017/actual_dev_db'));

  assert.equal(conns.prod, null, 'Prod connection should be null (not configured in .env)');
  assert.ok(conns.templateInfo, 'templateInfo should be returned in resolveConnections');

  const missingProd = conns.templateInfo.missingKeys.find((k) => k.targetEnv === 'prod');
  assert.ok(missingProd, 'Should report PROD_DATABASE_URL as missing');
  assert.equal(missingProd.key, 'PROD_DATABASE_URL');

  console.log('✔ resolveConnections dynamically prioritized MONGO_URI from .env.example');

  // Test 3: Embedded Studio Server verification
  const server = createStudioServer({
    cwd: tempDir,
    html: () => renderStudioHtml({ version: '1.0.0-test' }),
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`✔ Studio server started at: ${baseUrl}`);

  try {
    // Check GET /api/env-info
    const envInfoRes = await requestJson(`${baseUrl}/api/env-info`);
    assert.equal(envInfoRes.status, 200, 'GET /api/env-info should return 200');
    assert.equal(envInfoRes.body.templateFound, true);
    assert.equal(envInfoRes.body.templateFile, '.env.example');
    assert.equal(envInfoRes.body.detectedKeys.length, 5);
    console.log('✔ GET /api/env-info successfully returns template inspection metadata');

    // Check GET /api/status telemetry
    const statusRes = await requestJson(`${baseUrl}/api/status`);
    assert.equal(statusRes.status, 200, 'GET /api/status should return 200');
    assert.equal(statusRes.body.dev.sourceKey, 'MONGO_URI');
    assert.equal(statusRes.body.dev.detectedFromExample, true);
    assert.equal(statusRes.body.dev.exampleFile, '.env.example');

    assert.equal(statusRes.body.prod.connected, false);
    assert.ok(statusRes.body.prod.suggestion.includes('PROD_DATABASE_URL'));
    assert.ok(statusRes.body.prod.suggestion.includes('.env.example'));
    console.log('✔ GET /api/status enriched with template discovery and diagnostic suggestions');

    // Check HTML & Zero-Emoji compliance
    const htmlRes = await requestJson(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    assert.ok(htmlRes.raw.includes('id="diagnostic-banner"'), 'HTML must include diagnostic-banner');
    assert.ok(htmlRes.raw.includes('id="conn-template-chips"'), 'HTML must include conn-template-chips');
    assert.ok(htmlRes.raw.includes('badge-source'), 'HTML must include badge-source class');

    const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}]/u;
    assert.equal(emojiRegex.test(htmlRes.raw), false, 'UI HTML must contain ZERO emojis');
    console.log('✔ UI HTML verified: diagnostic banner, template chips, and ZERO emojis confirmed');
  } finally {
    server.close();
  }
} finally {
  // Cleanup tempDir
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('\nAll Template Auto-Detection (.env.example) tests PASSED successfully!\n');
