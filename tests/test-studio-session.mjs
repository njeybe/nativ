// Studio session key: cookie handshake, constant-time check, and the guard on human decisions.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startStudioServer } from '../dist/server/studio-server.js';
import {
  STUDIO_KEY_COOKIE,
  createStudioSession,
  parseCookies,
} from '../dist/server/studio-session.js';

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}\n${err.stack ?? err}`);
  }
}

function request(baseUrl, method, pathname, { body, cookie } = {}) {
  const url = new URL(pathname, baseUrl);
  const data = body === undefined ? null : JSON.stringify(body);
  const headers = {};
  if (data) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(data ?? undefined);
  });
}

const json = (r) => JSON.parse(r.text);
const keyOf = (session) => new URL(session.launchUrl('http://127.0.0.1:1/')).searchParams.get('key');

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-studio-session-'));
  fs.mkdirSync(path.join(dir, '.ai'));
  const escalation = {
    lastUpdated: '2026-01-01T00:00:00.000Z',
    escalations: [{
      id: 'esc-01', taskId: 'task-1', type: 'schema_flaw', details: 'gap',
      status: 'pending_review', timestamp: '2026-01-01T00:00:00.000Z',
    }],
  };
  fs.writeFileSync(path.join(dir, '.ai', 'escalation.json'), JSON.stringify(escalation, null, 2));
  return dir;
}

async function withStudio(human, fn) {
  const cwd = makeProject();
  const studio = await startStudioServer({ port: 0, cwd, connections: { dev: null, prod: null }, human });
  try {
    await fn(studio, cwd);
  } finally {
    await studio.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const escFile = (cwd) => fs.readFileSync(path.join(cwd, '.ai', 'escalation.json'), 'utf8');
const resolveBody = { escalationId: 'esc-01', decision: 'reject' };

console.log('studio session key');

await test('key is 32 random bytes in hex, distinct per session, absent from JSON', () => {
  const a = createStudioSession();
  const b = createStudioSession();
  assert.match(keyOf(a), /^[0-9a-f]{64}$/);
  assert.notEqual(keyOf(a), keyOf(b));
  assert.ok(!JSON.stringify(a).includes(keyOf(a)));
  assert.ok(!Object.values(a).some((v) => typeof v === 'string' && v.includes(keyOf(a))));
});

await test('matches uses the exact key and rejects wrong lengths without throwing', () => {
  const s = createStudioSession();
  const key = keyOf(s);
  assert.equal(s.matches(key), true);
  assert.equal(s.matches(key.slice(0, -1) + (key.endsWith('0') ? '1' : '0')), false);
  assert.equal(s.matches(key.slice(1)), false);
  assert.equal(s.matches(key + 'a'), false);
  assert.equal(s.matches(''), false);
  assert.equal(s.matches(undefined), false);
  assert.equal(s.matches('é'.repeat(32)), false);
});

await test('headless session has no key and matches nothing', () => {
  const s = createStudioSession({ headless: true });
  assert.equal(s.keyed, false);
  assert.equal(s.cookie(), null);
  assert.equal(s.launchUrl('http://127.0.0.1:9/'), 'http://127.0.0.1:9/');
  assert.equal(s.matches(''), false);
  assert.equal(s.matches('0'.repeat(64)), false);
});

await test('parseCookies handles several cookies, spaces and a duplicate name', () => {
  const c = parseCookies(' a=1;b = 2 ;  nativ_studio_key=first; nativ_studio_key=second; junk; =x');
  assert.equal(c.get('a'), '1');
  assert.equal(c.get('b'), '2');
  assert.equal(c.get(STUDIO_KEY_COOKIE), 'first');
  assert.equal(parseCookies(undefined).size, 0);
});

await test('GET /?key= with the right key sets the cookie and redirects 303 to /', async () => {
  const human = createStudioSession();
  await withStudio(human, async (studio) => {
    const r = await request(studio.url, 'GET', `/?key=${keyOf(human)}`);
    assert.equal(r.status, 303);
    assert.equal(r.headers.location, '/');
    const cookie = r.headers['set-cookie'][0];
    assert.equal(cookie, `${STUDIO_KEY_COOKIE}=${keyOf(human)}; HttpOnly; SameSite=Strict; Path=/`);
    assert.equal(r.text, '');
  });
});

await test('GET /?key= with a wrong key serves the page with no cookie and no hint', async () => {
  const human = createStudioSession();
  await withStudio(human, async (studio) => {
    const plain = await request(studio.url, 'GET', '/');
    const wrong = await request(studio.url, 'GET', `/?key=${'0'.repeat(64)}`);
    assert.equal(wrong.status, 200);
    assert.equal(wrong.headers['set-cookie'], undefined);
    assert.equal(wrong.text, plain.text);
    assert.ok(!wrong.text.includes(keyOf(human)));
  });
});

await test('GET /api/pipeline/session reports human true only with the cookie', async () => {
  const human = createStudioSession();
  await withStudio(human, async (studio) => {
    const anon = await request(studio.url, 'GET', '/api/pipeline/session');
    assert.deepEqual(json(anon), { ok: true, human: false });
    const cookie = `x=1; ${STUDIO_KEY_COOKIE}=${keyOf(human)}`;
    const signed = await request(studio.url, 'GET', '/api/pipeline/session', { cookie });
    assert.deepEqual(json(signed), { ok: true, human: true });
    assert.ok(!signed.text.includes(keyOf(human)));
    const wrongMethod = await request(studio.url, 'POST', '/api/pipeline/session', { body: {} });
    assert.equal(wrongMethod.status, 405);
  });
});

await test('resolve without a valid cookie is 403 HUMAN_KEY_REQUIRED and changes nothing', async () => {
  const human = createStudioSession();
  await withStudio(human, async (studio, cwd) => {
    const before = escFile(cwd);
    const cookies = [undefined, `${STUDIO_KEY_COOKIE}=${'0'.repeat(64)}`, `${STUDIO_KEY_COOKIE}=short`];
    for (const cookie of cookies) {
      const r = await request(studio.url, 'POST', '/api/pipeline/escalations/resolve', { body: resolveBody, cookie });
      assert.equal(r.status, 403);
      assert.equal(json(r).ok, false);
      assert.equal(json(r).code, 'HUMAN_KEY_REQUIRED');
      assert.ok(!r.text.includes(keyOf(human)));
    }
    assert.equal(escFile(cwd), before);
  });
});

await test('resolve with the cookie goes through', async () => {
  const human = createStudioSession();
  await withStudio(human, async (studio, cwd) => {
    const cookie = `${STUDIO_KEY_COOKIE}=${keyOf(human)}`;
    const r = await request(studio.url, 'POST', '/api/pipeline/escalations/resolve', { body: resolveBody, cookie });
    assert.equal(r.status, 200, r.text);
    assert.equal(json(r).ok, true);
    assert.ok(!escFile(cwd).includes(keyOf(human)));
  });
});

await test('a headless start refuses every decision for the whole run', async () => {
  await withStudio(createStudioSession({ headless: true }), async (studio, cwd) => {
    const before = escFile(cwd);
    const landing = await request(studio.url, 'GET', `/?key=${'0'.repeat(64)}`);
    assert.equal(landing.status, 200);
    assert.equal(landing.headers['set-cookie'], undefined);
    for (const cookie of [undefined, `${STUDIO_KEY_COOKIE}=`, `${STUDIO_KEY_COOKIE}=${'0'.repeat(64)}`]) {
      const r = await request(studio.url, 'POST', '/api/pipeline/escalations/resolve', { body: resolveBody, cookie });
      assert.equal(r.status, 403);
      assert.equal(json(r).code, 'HUMAN_KEY_REQUIRED');
    }
    assert.equal(escFile(cwd), before);
  });
});

await test('a server without a session option defaults to headless; two servers keep separate keys', async () => {
  await withStudio(undefined, async (studio) => {
    const r = await request(studio.url, 'POST', '/api/pipeline/escalations/resolve', { body: resolveBody });
    assert.equal(json(r).code, 'HUMAN_KEY_REQUIRED');
  });
  const a = createStudioSession();
  const b = createStudioSession();
  await withStudio(a, async (studio) => {
    const cookie = `${STUDIO_KEY_COOKIE}=${keyOf(b)}`;
    const r = await request(studio.url, 'GET', '/api/pipeline/session', { cookie });
    assert.equal(json(r).human, false);
  });
});

await test('Host and Origin checks still apply before the key', async () => {
  const human = createStudioSession();
  await withStudio(human, async (studio) => {
    const r = await new Promise((resolve, reject) => {
      const req = http.request(new URL('/api/pipeline/session', studio.url), {
        headers: { Origin: 'https://evil.example', Cookie: `${STUDIO_KEY_COOKIE}=${keyOf(human)}` },
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(r, 403);
  });
});

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nall studio session tests passed');
