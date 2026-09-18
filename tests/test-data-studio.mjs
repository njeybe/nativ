import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startStudioServer } from '../dist/server/studio-server.js';
import { renderStudioHtml } from '../dist/server/studio-ui.js';

console.log('--- Starting Live Data Studio & Production Safeguard Verification ---');

// 1. Create temporary SQLite databases for Dev and Prod
const tmpDir = path.join(process.cwd(), '.agentj', 'test_tmp');
fs.mkdirSync(tmpDir, { recursive: true });
const devDbPath = path.join(tmpDir, 'dev.sqlite');
const prodDbPath = path.join(tmpDir, 'prod.sqlite');

try { fs.unlinkSync(devDbPath); } catch {}
try { fs.unlinkSync(prodDbPath); } catch {}

const devDb = new DatabaseSync(devDbPath);
devDb.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    email TEXT,
    avatar_url TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  INSERT INTO users (username, email, avatar_url) VALUES ('alice', 'alice@test.com', 'https://example.com/alice.png');
  INSERT INTO users (username, email, avatar_url) VALUES ('bob', 'bob@test.com', 'https://example.com/bob.png');
  INSERT INTO users (username, email, avatar_url) VALUES ('charlie', 'charlie@test.com', 'https://example.com/charlie.png');
`);
devDb.close();

const prodDb = new DatabaseSync(prodDbPath);
prodDb.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    email TEXT,
    avatar_url TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  INSERT INTO users (username, email, avatar_url) VALUES ('prod_alice', 'prod_alice@company.com', 'https://company.com/alice.png');
`);
prodDb.close();

const devUrl = `sqlite:${devDbPath}`;
const prodUrl = `sqlite:${prodDbPath}`;

// 2. Start Studio Server on dynamic loopback port
const studio = await startStudioServer({
  port: 0,
  connections: { dev: devUrl, prod: prodUrl },
  cwd: process.cwd(),
});
console.log('✔ Studio server started at:', studio.url);

try {
  // Test A: GET /api/data on Dev
  const getRes = await fetch(`${studio.url}/api/data?env=dev&entity=users&limit=10`);
  assert.strictEqual(getRes.status, 200, 'GET /api/data returned 200');
  const data = await getRes.json();
  assert.strictEqual(data.entity, 'users');
  assert.strictEqual(data.totalCount, 3);
  assert.strictEqual(data.rows.length, 3);
  assert.strictEqual(data.rows[0].username, 'alice');
  console.log('✔ GET /api/data retrieved paginated records successfully');

  // Test B: Sorting & Searching
  const sortRes = await fetch(`${studio.url}/api/data?env=dev&entity=users&sort=username&order=desc`);
  const sortData = await sortRes.json();
  assert.strictEqual(sortData.rows[0].username, 'charlie');
  console.log('✔ GET /api/data with sort=username&order=desc verified');

  const searchRes = await fetch(`${studio.url}/api/data?env=dev&entity=users&search=alice`);
  const searchData = await searchRes.json();
  assert.strictEqual(searchData.totalCount, 1);
  assert.strictEqual(searchData.rows[0].username, 'alice');
  console.log('✔ GET /api/data with search filter verified');

  // Test C: POST /api/data on Dev (Insert)
  const insertRes = await fetch(`${studio.url}/api/data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      env: 'dev',
      entity: 'users',
      record: { username: 'david', email: 'david@test.com', avatar_url: 'https://example.com/david.png' },
    }),
  });
  assert.strictEqual(insertRes.status, 200);
  const insertResult = await insertRes.json();
  assert.strictEqual(insertResult.success, true);
  assert.strictEqual(insertResult.insertedId, 4);
  console.log('✔ POST /api/data inserted record into Dev');

  // Test D: PUT /api/data on Dev (Update)
  const updateRes = await fetch(`${studio.url}/api/data`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      env: 'dev',
      entity: 'users',
      primaryKey: 4,
      updates: { email: 'david_updated@test.com' },
    }),
  });
  assert.strictEqual(updateRes.status, 200);
  const updateResult = await updateRes.json();
  assert.strictEqual(updateResult.success, true);
  assert.strictEqual(updateResult.record.email, 'david_updated@test.com');
  console.log('✔ PUT /api/data updated record in Dev');

  // Test E: DELETE /api/data on Dev (Delete)
  const deleteRes = await fetch(`${studio.url}/api/data`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      env: 'dev',
      entity: 'users',
      primaryKey: 4,
    }),
  });
  assert.strictEqual(deleteRes.status, 200);
  const deleteResult = await deleteRes.json();
  assert.strictEqual(deleteResult.success, true);
  assert.strictEqual(deleteResult.deletedCount, 1);
  console.log('✔ DELETE /api/data deleted record from Dev');

  // Test F: Production Guardrail - Rejection without Challenge
  const prodRejectRes = await fetch(`${studio.url}/api/data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      env: 'prod',
      entity: 'users',
      record: { username: 'intruder', email: 'hacker@prod.com' },
    }),
  });
  assert.strictEqual(prodRejectRes.status, 403, 'Prod write without challenge phrase must be 403');
  const rejectBody = await prodRejectRes.json();
  assert.strictEqual(rejectBody.error.code, 'PROD_CHALLENGE_REQUIRED');
  console.log('✔ Production write correctly rejected with 403 PROD_CHALLENGE_REQUIRED');

  // Test G: Production Guardrail - Success with Challenge Phrase & Audit Log
  const prodAuditFile = path.join(process.cwd(), '.agentj', 'prod_audit.log');
  try { fs.unlinkSync(prodAuditFile); } catch {}

  const prodAllowRes = await fetch(`${studio.url}/api/data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      env: 'prod',
      entity: 'users',
      record: { username: 'prod_authorized', email: 'auth@prod.com' },
      confirmProd: true,
      challengePhrase: 'users',
    }),
  });
  assert.strictEqual(prodAllowRes.status, 200);
  const prodAllowData = await prodAllowRes.json();
  assert.strictEqual(prodAllowData.success, true);
  console.log('✔ Production write authorized with challenge phrase');

  // Verify Audit Log
  assert.strictEqual(fs.existsSync(prodAuditFile), true, 'prod_audit.log must exist');
  const auditContent = fs.readFileSync(prodAuditFile, 'utf8');
  assert.strictEqual(auditContent.includes('"action":"INSERT"'), true);
  assert.strictEqual(auditContent.includes('"entity":"users"'), true);
  assert.strictEqual(auditContent.includes('prod_authorized'), true);
  console.log('✔ Audit log entry written to .agentj/prod_audit.log');

  // Test H: Verify UI HTML contains Environment Toggle, Data Tab, Dialogs, and Zero Emojis
  const html = renderStudioHtml({ version: '1.0.0' });
  assert.strictEqual(html.includes('data-env-mode="dev"'), true, 'UI must contain Dev toggle button');
  assert.strictEqual(html.includes('data-env-mode="prod"'), true, 'UI must contain Prod toggle button');
  assert.strictEqual(html.includes('data-env-mode="split"'), true, 'UI must contain Split toggle button');
  assert.strictEqual(html.includes('data-tab="data"'), true, 'UI must contain Live Data Browser tab');
  assert.strictEqual(html.includes('id="record-dialog"'), true, 'UI must contain record dialog');
  assert.strictEqual(html.includes('id="challenge-dialog"'), true, 'UI must contain challenge dialog');
  assert.strictEqual(html.includes('PRODUCTION MUTATION SAFEGUARD'), true, 'UI must contain production safeguard badge');

  // Check for emojis
  const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}]/u;
  assert.strictEqual(emojiRegex.test(html), false, 'Strict directive: ZERO emojis allowed in UI HTML');
  console.log('✔ UI HTML verified: Environment Toggle, Data Tab, Modals present, ZERO emojis');

  console.log('\nAll Live Data Studio & Environment Focus tests PASSED successfully!');
} finally {
  await studio.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}
