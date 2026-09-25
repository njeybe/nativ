import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveGeminiApiKey,
  hasGeminiApiKey,
  evaluateEscalation,
  redactSecrets,
  Tier1Liaison,
  DEFAULT_MODEL,
} from '../dist/core/tier1-liaison.js';

console.log('--- Starting Tier 1 AI Strategist (Gemini 3.8 Flash) Liaison Tests ---');

// Evaluations fall back to process.env for a key; keep them offline so results are deterministic.
delete process.env.GEMINI_API_KEY;
delete process.env.GOOGLE_API_KEY;

function createFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-tier1-test-'));
  const aiDir = path.join(dir, '.ai');
  fs.mkdirSync(aiDir, { recursive: true });

  fs.writeFileSync(path.join(aiDir, 'context.md'), '# Context\n', 'utf8');
  fs.writeFileSync(path.join(aiDir, 'db_schema.json'), JSON.stringify({ tables: [] }), 'utf8');
  fs.writeFileSync(path.join(aiDir, 'api_contracts.json'), JSON.stringify({ endpoints: [] }), 'utf8');
  fs.writeFileSync(path.join(aiDir, 'master_plan.json'), JSON.stringify({ version: '1.0.0', milestones: [] }), 'utf8');

  return dir;
}

// Test 1: API Key resolution
{
  const dir = createFixture();
  fs.writeFileSync(path.join(dir, '.env'), 'GEMINI_API_KEY="test-mock-gemini-key"\n', 'utf8');
  assert.equal(resolveGeminiApiKey(dir), 'test-mock-gemini-key', 'resolveGeminiApiKey must parse GEMINI_API_KEY from .env');
  assert.equal(hasGeminiApiKey(dir), true, 'hasGeminiApiKey must return true when key exists');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✔ Test 1: resolveGeminiApiKey correctly extracts GEMINI_API_KEY from .env');
}

// Test 2: GOOGLE_API_KEY alias resolution
{
  const dir = createFixture();
  fs.writeFileSync(path.join(dir, '.env'), 'GOOGLE_API_KEY="test-mock-google-key"\n', 'utf8');
  assert.equal(resolveGeminiApiKey(dir), 'test-mock-google-key', 'resolveGeminiApiKey must support GOOGLE_API_KEY alias');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✔ Test 2: resolveGeminiApiKey recognizes GOOGLE_API_KEY alias');
}

// Test 3: Safe contract issue classification (AUTO_RESOLVE)
{
  const dir = createFixture();
  const escalations = {
    version: '1.0.0',
    escalations: [
      {
        id: 'esc-01',
        taskId: 'task-auth-api',
        status: 'pending_review',
        summary: 'Contract mismatch: missing query parameter in API contract',
        details: 'API contracts schema drift: expected optional sort query param.',
      },
    ],
  };
  fs.writeFileSync(path.join(dir, '.ai', 'escalation.json'), JSON.stringify(escalations, null, 2), 'utf8');

  const result = await evaluateEscalation(dir, 'esc-01');
  assert.equal(result.ok, true, 'evaluation must succeed');
  assert.equal(result.escalationId, 'esc-01');
  assert.equal(result.classification, 'AUTO_RESOLVE', 'safe contract alignment must be classified as AUTO_RESOLVE');
  assert.equal(result.riskLevel, 'low', 'contract drift should be low risk');
  assert.ok(result.latencyMs >= 0, 'latency must be measured');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✔ Test 3: Safe contract drift is autonomously classified as AUTO_RESOLVE');
}

// Test 4: Destructive operation classification (REQUIRE_HUMAN_DECISION)
{
  const dir = createFixture();
  const escalations = {
    version: '1.0.0',
    escalations: [
      {
        id: 'esc-02',
        taskId: 'task-db-migration',
        status: 'pending_review',
        summary: 'Destructive migration: DROP COLUMN requested',
        details: 'DROP COLUMN customer_notes will permanently delete user records in production.',
      },
    ],
  };
  fs.writeFileSync(path.join(dir, '.ai', 'escalation.json'), JSON.stringify(escalations, null, 2), 'utf8');

  const result = await evaluateEscalation(dir, 'esc-02');
  assert.equal(result.ok, true, 'evaluation must succeed');
  assert.equal(result.classification, 'REQUIRE_HUMAN_DECISION', 'destructive operation must require human decision');
  assert.equal(result.riskLevel, 'high', 'destructive operation must be high risk');
  assert.ok(result.humanCard, 'must generate human decision card');
  assert.ok(result.humanCard.symptom.length > 0, 'symptom must not be empty');
  assert.ok(result.humanCard.rootCause.length > 0, 'root cause must not be empty');
  assert.ok(result.humanCard.blastRadius.length > 0, 'blast radius must not be empty');
  assert.ok(result.humanCard.options.length >= 2, 'must provide at least 2 actionable options');

  const rec = result.humanCard.options.find((o) => o.recommended);
  assert.ok(rec, 'must include a recommended option');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✔ Test 4: Destructive operation triggers zero-jargon Human Decision Card');
}

// Test 5: Missing escalation returns error
{
  const dir = createFixture();
  fs.writeFileSync(path.join(dir, '.ai', 'escalation.json'), JSON.stringify({ escalations: [] }), 'utf8');

  const result = await evaluateEscalation(dir, 'esc-missing');
  assert.equal(result.ok, false);
  assert.match(result.error, /not found/i);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✔ Test 5: Missing escalation ID is handled cleanly');
}

const API_KEY = 'test-gemini-key-123456';
const DB_PASSWORD = 'hunter2secret';
const INLINE_KEY = 'abc123inlinesecretvalue';
const GOOGLE_KEY = `AIza${'x'.repeat(35)}`;

// Test 6: secret masking keeps contract structure readable
{
  const out = redactSecrets(
    `postgres://admin:${DB_PASSWORD}@db:5432/app api_key=${INLINE_KEY} "password": "pw-value-1" "token": "string" ` +
      `Authorization: Bearer abc.def.ghi ${GOOGLE_KEY} -----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY----- raw-${API_KEY} ` +
      `DB_PASSWORD=envpass-777 redis://:redispass-888@cache:6379 "dbPassword": "camelpass-999" mysql://root:sl/ash-pw@mysql:3306/app ` +
      `session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXRlc3Q`,
    [API_KEY],
  );
  for (const secret of [DB_PASSWORD, INLINE_KEY, 'pw-value-1', 'abc.def.ghi', GOOGLE_KEY, 'MIIE', API_KEY,
    'envpass-777', 'redispass-888', 'camelpass-999', 'sl/ash-pw', 'c2lnbmF0dXJlLXRlc3Q']) {
    assert.ok(!out.includes(secret), `redactSecrets leaked ${secret}`);
  }
  assert.ok(out.includes('postgres://admin:'), 'non-secret connection string parts stay readable');
  assert.ok(out.includes('@cache:6379') && out.includes('@mysql:3306/app'), 'hosts stay readable once the password is masked');
  assert.ok(out.includes('"token": "string"'), 'contract field types are not masked');
  console.log('✔ Test 6: Connection strings, credential assignments and key formats are masked');
}

// Test 7: Gemini request carries the key in a header and a masked escalation
{
  const dir = createFixture();
  fs.writeFileSync(
    path.join(dir, '.ai', 'escalation.json'),
    JSON.stringify({
      version: '1.0.0',
      escalations: [
        {
          id: 'esc-07',
          taskId: 'task-sync',
          status: 'pending_review',
          summary: 'Sync job cannot reach the reporting database',
          details: `Connected with postgres://admin:${DB_PASSWORD}@db.local:5432/app using api_key=${INLINE_KEY}; key ${API_KEY} and ${GOOGLE_KEY} were in the logs.`,
        },
      ],
    }, null, 2),
    'utf8',
  );

  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const verdict = {
      classification: 'REQUIRE_HUMAN_DECISION',
      riskLevel: 'medium',
      reasoning: 'Credentials need a human.',
      humanCard: {
        symptom: 'The sync job cannot log in.',
        rootCause: 'The reporting database login is not set up here.',
        blastRadius: 'Only the reporting sync is paused.',
        options: [
          { id: 'opt-a', label: 'Add the login locally', outcome: 'The sync resumes.', recommended: true },
          { id: 'opt-b', label: 'Skip reporting for now', outcome: 'Reports stay stale.', recommended: false },
        ],
      },
    };
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(verdict) }] } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const result = await evaluateEscalation(dir, 'esc-07', { apiKey: API_KEY });
    assert.equal(calls.length, 1, 'exactly one Gemini request');
    const { url, init } = calls[0];
    assert.match(url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/[^/?]+:generateContent$/, 'URL carries no query string');
    assert.ok(!url.includes(API_KEY) && !/[?&]key=/.test(url), 'the API key must never appear in the URL');
    assert.equal(init.headers['x-goog-api-key'], API_KEY, 'the API key travels in the x-goog-api-key header');
    for (const secret of [DB_PASSWORD, INLINE_KEY, API_KEY, GOOGLE_KEY]) {
      assert.ok(!init.body.includes(secret), `request body leaked ${secret}`);
    }
    assert.ok(init.body.includes('esc-07') && init.body.includes('postgres://admin:'), 'escalation context is still sent, minus secrets');
    assert.equal(result.ok, true);
    assert.equal(result.source, 'gemini');
    assert.equal(result.classification, 'REQUIRE_HUMAN_DECISION');
    assert.equal(result.model, DEFAULT_MODEL, 'reports the default model');
    assert.ok(url.endsWith(`/models/${result.model}:generateContent`), 'the model called is the model reported');
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('✔ Test 7: Gemini key sent via x-goog-api-key header; escalation secrets masked before the request');
}

// Test 8: auto-triage is off by default, so safe fixes wait for confirmation
{
  const dir = createFixture();
  const schemaPath = path.join(dir, '.ai', 'db_schema.json');
  fs.writeFileSync(
    schemaPath,
    JSON.stringify({ tables: [{ name: 'users', columns: [{ name: 'id', type: 'UUID', nullable: false }], indexes: [], foreignKeys: [] }] }, null, 2),
    'utf8',
  );
  const candidate = { target: 'db_schema', operation: 'ADD', path: 'tables.users.columns.bio', value: { name: 'bio', type: 'TEXT', nullable: true }, reason: 'Profiles need a bio' };
  const writeEscalation = () =>
    fs.writeFileSync(
      path.join(dir, '.ai', 'escalation.json'),
      JSON.stringify({
        version: '1.0.0',
        escalations: [
          {
            id: 'esc-08',
            taskId: 'task-profile',
            status: 'pending_review',
            summary: 'users table has no bio column',
            details: '',
            proposedPatch: {
              kind: 'contract_patch',
              proposalId: 'heal-test',
              strategy: 'add_missing_target',
              rationale: 'Add the missing column',
              requiresHumanApproval: true,
              candidatesEvaluated: 1,
              verificationProof: { isolated: true, method: 'sandbox_governor_replay', passed: true, checks: [], verifiedAt: new Date().toISOString(), durationMs: 1 },
              generatedAt: new Date().toISOString(),
              candidate,
              original: candidate,
            },
          },
        ],
      }, null, 2),
      'utf8',
    );
  writeEscalation();
  const schemaBefore = fs.readFileSync(schemaPath, 'utf8');

  const liaison = new Tier1Liaison(dir);
  assert.equal(liaison.getStatus().autoTriageEnabled, false, 'auto-triage must default to off');
  const held = await liaison.evaluate('esc-08');
  assert.equal(held.classification, 'AUTO_RESOLVE', 'the fix is still classified as safe');
  assert.equal(held.autoPatchApplied, false, 'a safe fix is not applied without confirmation');
  assert.equal(fs.readFileSync(schemaPath, 'utf8'), schemaBefore, 'the contract is untouched by default');

  const optedIn = new Tier1Liaison(dir, { config: { autoTriageEnabled: true } });
  const applied = await optedIn.evaluate('esc-08');
  assert.equal(applied.autoPatchApplied, true, 'enabling auto-triage still applies safe fixes');
  assert.ok(JSON.parse(fs.readFileSync(schemaPath, 'utf8')).tables[0].columns.some((c) => c.name === 'bio'));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✔ Test 8: Auto-triage defaults to off; safe fixes apply only after opting in');
}

// Test 9: one model identifier — the contract's Gemini 3.8 Flash, or an override — is both called and reported
{
  assert.equal(DEFAULT_MODEL, 'gemini-3.8-flash', 'default model matches the contract');
  const dir = createFixture();
  fs.writeFileSync(
    path.join(dir, '.ai', 'escalation.json'),
    JSON.stringify({ version: '1.0.0', escalations: [{ id: 'esc-09', taskId: 'task-x', status: 'pending_review', summary: 'API contracts drift', details: '' }] }),
    'utf8',
  );
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response('{}', { status: 503 });
  };
  try {
    const liaison = new Tier1Liaison(dir, { apiKey: API_KEY, model: 'gemini-custom-flash' });
    assert.equal(liaison.getStatus().model, 'gemini-custom-flash');
    const result = await liaison.evaluate('esc-09');
    assert.equal(result.model, 'gemini-custom-flash');
    assert.ok(urls[0].endsWith('/models/gemini-custom-flash:generateContent'), 'the overridden model is the one called');
    assert.equal(result.source, 'deterministic', 'a failed Gemini call is reported as a deterministic fallback');
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('✔ Test 9: The model called matches the model reported, including overrides');
}

console.log('\n🎉 ALL TIER 1 LIAISON TESTS PASSED!');
