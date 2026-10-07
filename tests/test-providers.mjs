import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ProviderError,
  stripJsonFence,
  createClaudeCliProvider,
  createClaudeApiProvider,
  createGeminiProvider,
  parseLimitRetryAfter,
  resolveProviderChain,
  resolveProvider,
  completeWithChain,
  MAX_TRANSIENT_RETRIES,
  transientBackoffMs,
  providerCooldownRemaining,
  setProviderCooldown,
  DEFAULT_LIMIT_COOLDOWN_MS,
  PROVIDER_CHILD_ENV,
} from '../dist/providers/index.js';

console.log('--- Starting Provider Adapter Tests ---');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-providers-test-'));
}

const cliJson = (over = {}) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: '{"ok":true}', ...over });

const okSpawn = (stdout = cliJson(), extra = {}) => {
  const calls = [];
  const spawn = async (command, args, request) => {
    calls.push({ command, args, request });
    return { code: 0, stdout, stderr: '', timedOut: false, ...extra };
  };
  return { spawn, calls };
};

const REJECTS = async (promise, code) => {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof ProviderError, `expected ProviderError, got ${err}`);
    assert.equal(err.code, code);
    return true;
  });
};

// Test 1: code fences are stripped from JSON replies
{
  assert.equal(stripJsonFence('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripJsonFence('```\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripJsonFence(' {"a":1} '), '{"a":1}');
  console.log('✔ Test 1: stripJsonFence removes code fences and leaves plain JSON alone');
}

// Test 2: claude-cli launches a sandboxed headless call
{
  const root = tempRoot();
  const { spawn, calls } = okSpawn(cliJson({ result: '```json\n{"ok":true}\n```' }));
  const provider = createClaudeCliProvider({ spawn, hasBinary: () => true, env: { PATH: 'x' } });
  const text = await provider.complete({ system: 'JSON only.', prompt: 'hello', json: true }, root);

  assert.equal(text, '{"ok":true}', 'fence stripped when json requested');
  assert.equal(calls.length, 1);
  const { command, args, request } = calls[0];
  assert.equal(command, 'claude');
  assert.ok(args.includes('-p') && args.includes('--output-format') && args[args.indexOf('--output-format') + 1] === 'json');
  assert.equal(args[args.indexOf('--model') + 1], 'haiku', 'defaults to the cheap model');
  assert.equal(args[args.indexOf('--tools') + 1], '', 'all tools disabled');
  assert.ok(args.includes('--strict-mcp-config') && args.includes('--no-session-persistence'));
  assert.equal(args[args.indexOf('--system-prompt') + 1], 'JSON only.');
  assert.ok(!args.includes('--bare'), 'never --bare (needs an API key)');
  assert.ok(!args.some((a) => /dangerously|bypassPermissions/i.test(a)), 'never bypasses permissions');
  assert.ok(!args.includes('hello'), 'the prompt is not an argument (no shell quoting risk)');
  assert.equal(request.input, 'hello', 'the prompt travels on stdin');
  assert.equal(request.env[PROVIDER_CHILD_ENV], '1', 'children are marked so nothing recurses');
  assert.notEqual(path.resolve(request.cwd), path.resolve(root), 'runs from a neutral directory, not the project');
  assert.deepEqual(fs.readdirSync(request.cwd), [], 'the neutral directory holds no project files');

  const plain = await createClaudeCliProvider({ spawn: okSpawn(cliJson({ result: 'plain text' })).spawn, hasBinary: () => true }).complete({ prompt: 'x', model: 'sonnet' }, root);
  assert.equal(plain, 'plain text');
  fs.rmSync(root, { recursive: true, force: true });
  console.log('✔ Test 2: claude-cli is headless, tool-less, off-project, and never bypasses permissions');
}

// Test 3: claude-cli failure mapping
const NOW_MS = 1_760_000_000_000;
{
  const root = tempRoot();
  const make = (spawnResult) =>
    createClaudeCliProvider({ spawn: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...spawnResult }), hasBinary: () => true, now: () => NOW_MS });

  await REJECTS(make({ notFound: true, code: null }).complete({ prompt: 'x' }, root), 'NO_CREDENTIALS');
  await REJECTS(make({ timedOut: true, code: null }).complete({ prompt: 'x', timeoutMs: 5 }, root), 'TIMEOUT');
  await REJECTS(make({ stdout: cliJson({ is_error: true, result: 'Please run /login to sign in' }), code: 1 }).complete({ prompt: 'x' }, root), 'NO_CREDENTIALS');
  await REJECTS(make({ stdout: cliJson({ is_error: true, result: 'boom' }), code: 1 }).complete({ prompt: 'x' }, root), 'BAD_RESPONSE');
  await REJECTS(make({ stdout: 'not json at all', code: 0 }).complete({ prompt: 'x' }, root), 'BAD_RESPONSE');
  await REJECTS(make({ stdout: cliJson({ result: '   ' }) }).complete({ prompt: 'x' }, root), 'BAD_RESPONSE');

  // A subscription usage limit becomes RATE_LIMITED with the reset time when the CLI gives one
  const resetEpoch = NOW_MS / 1000 + 3600; // one hour after the injected clock (10-digit epoch seconds, as the CLI emits)
  const limited = make({ stdout: cliJson({ is_error: true, result: `Claude usage limit reached|${Math.floor(resetEpoch)}` }), code: 1 });
  await assert.rejects(limited.complete({ prompt: 'x' }, root), (err) => {
    assert.equal(err.code, 'RATE_LIMITED');
    assert.ok(err.retryAfterMs > 3_500_000 && err.retryAfterMs <= 3_600_000, `retryAfterMs was ${err.retryAfterMs}`);
    return true;
  });
  // ...and a default cooldown when it does not
  await assert.rejects(make({ stdout: cliJson({ is_error: true, result: 'You have hit your usage limit.' }), code: 1 }).complete({ prompt: 'x' }, root), (err) => {
    assert.equal(err.code, 'RATE_LIMITED');
    assert.equal(err.retryAfterMs, DEFAULT_LIMIT_COOLDOWN_MS);
    return true;
  });
  await assert.rejects(make({ stdout: cliJson({ is_error: true, api_error_status: 429, result: 'slow down' }), code: 1 }).complete({ prompt: 'x' }, root), (err) => err.code === 'RATE_LIMITED');
  assert.equal(parseLimitRetryAfter('no epoch here', 0), undefined);

  fs.rmSync(root, { recursive: true, force: true });
  console.log('✔ Test 3: claude-cli maps missing binary, timeout, login, limit and garbage to typed errors');
}

// Test 4: claude-cli never recurses and needs the binary
{
  const root = tempRoot();
  const guarded = createClaudeCliProvider({ spawn: okSpawn().spawn, hasBinary: () => true, env: { [PROVIDER_CHILD_ENV]: '1' } });
  assert.equal(guarded.hasCredentials(root), false, 'unavailable inside a provider child');
  await REJECTS(guarded.complete({ prompt: 'x' }, root), 'NO_CREDENTIALS');
  assert.equal(createClaudeCliProvider({ hasBinary: () => false }).hasCredentials(root), false, 'no binary, no provider');
  assert.equal(createClaudeCliProvider({ hasBinary: () => true }).hasCredentials(root), true);
  fs.rmSync(root, { recursive: true, force: true });
  console.log('✔ Test 4: claude-cli refuses to nest and reports availability from the binary');
}

// Test 5: claude-api through a fake SDK client
{
  const root = tempRoot();
  const seen = [];
  const client = (behavior) => () => ({
    messages: {
      create: async (body, options) => {
        seen.push({ body, options });
        return behavior();
      },
    },
  });

  const ok = createClaudeApiProvider({ anthropicClient: client(() => ({ content: [{ type: 'text', text: '```json\n{"a":1}\n```' }] })), env: {} });
  assert.equal(ok.hasCredentials(root), true);
  assert.equal(await ok.complete({ system: 'sys', prompt: 'hi', json: true }, root), '{"a":1}');
  assert.equal(seen[0].body.model, 'claude-haiku-4-5-20251001');
  assert.equal(seen[0].body.system, 'sys');
  assert.deepEqual(seen[0].body.messages, [{ role: 'user', content: 'hi' }]);
  assert.ok(seen[0].options.timeout > 0);

  const limited = createClaudeApiProvider({
    anthropicClient: client(() => {
      throw Object.assign(new Error('rate limited'), { status: 429, headers: { 'retry-after': '30' } });
    }),
  });
  await assert.rejects(limited.complete({ prompt: 'x' }, root), (err) => err.code === 'RATE_LIMITED' && err.retryAfterMs === 30_000);
  await REJECTS(createClaudeApiProvider({ anthropicClient: client(() => { throw Object.assign(new Error('nope'), { status: 401 }); }) }).complete({ prompt: 'x' }, root), 'NO_CREDENTIALS');
  await REJECTS(createClaudeApiProvider({ anthropicClient: client(() => { throw Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }); }) }).complete({ prompt: 'x' }, root), 'TIMEOUT');
  await REJECTS(createClaudeApiProvider({ anthropicClient: client(() => ({ content: [] })) }).complete({ prompt: 'x' }, root), 'BAD_RESPONSE');
  await REJECTS(createClaudeApiProvider({ anthropicClient: client(() => { throw Object.assign(new Error('overloaded'), { status: 500 }); }) }).complete({ prompt: 'x' }, root), 'TRANSIENT');
  await REJECTS(createClaudeApiProvider({ anthropicClient: client(() => { throw Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' }); }) }).complete({ prompt: 'x' }, root), 'TRANSIENT');
  await REJECTS(createClaudeApiProvider({ anthropicClient: client(() => { throw Object.assign(new Error('bad request'), { status: 400 }); }) }).complete({ prompt: 'x' }, root), 'BAD_RESPONSE');

  // Without an injected client the key comes from .env / env, and its absence is NO_CREDENTIALS
  assert.equal(createClaudeApiProvider({ env: {} }).hasCredentials(root), false);
  await REJECTS(createClaudeApiProvider({ env: {} }).complete({ prompt: 'x' }, root), 'NO_CREDENTIALS');
  fs.writeFileSync(path.join(root, '.env'), 'ANTHROPIC_API_KEY="sk-ant-test-key-1234567890"\n', 'utf8');
  assert.equal(createClaudeApiProvider({ env: {} }).hasCredentials(root), true, 'key read from .env');
  fs.rmSync(root, { recursive: true, force: true });
  console.log('✔ Test 5: claude-api builds the request, maps errors, and finds its key');
}

// Test 6: gemini keeps the header-only key and typed errors
{
  const root = tempRoot();
  const KEY = 'test-gemini-key-123456';
  const calls = [];
  const fetchWith = (make) => async (url, init) => {
    calls.push({ url: String(url), init });
    return make();
  };
  const okBody = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '```json\n{"g":1}\n```' }] } }] }), { status: 200 });

  const provider = createGeminiProvider({ fetch: fetchWith(okBody), env: { GEMINI_API_KEY: KEY } });
  assert.equal(provider.hasCredentials(root), true);
  assert.equal(await provider.complete({ prompt: 'hi', json: true, model: 'gemini-custom' }, root), '{"g":1}');
  const { url, init } = calls[0];
  assert.match(url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-custom:generateContent$/, 'no query string');
  assert.equal(init.headers['x-goog-api-key'], KEY);
  assert.ok(!url.includes(KEY) && !init.body.includes(KEY), 'the key is only ever in the header');
  assert.ok(init.signal, 'a timeout signal is attached');
  assert.equal(JSON.parse(init.body).generationConfig.responseMimeType, 'application/json');

  await assert.rejects(createGeminiProvider({ fetch: fetchWith(() => new Response('{}', { status: 429, headers: { 'retry-after': '12' } })), env: { GEMINI_API_KEY: KEY } }).complete({ prompt: 'x' }, root), (err) => err.code === 'RATE_LIMITED' && err.retryAfterMs === 12_000);
  await REJECTS(createGeminiProvider({ fetch: fetchWith(() => new Response('{}', { status: 403 })), env: { GEMINI_API_KEY: KEY } }).complete({ prompt: 'x' }, root), 'NO_CREDENTIALS');
  await REJECTS(createGeminiProvider({ fetch: fetchWith(() => new Response('{}', { status: 503 })), env: { GEMINI_API_KEY: KEY } }).complete({ prompt: 'x' }, root), 'TRANSIENT');
  await REJECTS(createGeminiProvider({ fetch: fetchWith(() => new Response('{}', { status: 400 })), env: { GEMINI_API_KEY: KEY } }).complete({ prompt: 'x' }, root), 'BAD_RESPONSE');
  await REJECTS(createGeminiProvider({ fetch: fetchWith(() => { throw new TypeError('fetch failed'); }), env: { GEMINI_API_KEY: KEY } }).complete({ prompt: 'x' }, root), 'TRANSIENT');
  await REJECTS(createGeminiProvider({ fetch: fetchWith(() => new Response('{}', { status: 200 })), env: { GEMINI_API_KEY: KEY } }).complete({ prompt: 'x' }, root), 'BAD_RESPONSE');
  await REJECTS(
    createGeminiProvider({ fetch: async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); }, env: { GEMINI_API_KEY: KEY } }).complete({ prompt: 'x' }, root),
    'TIMEOUT',
  );
  await REJECTS(createGeminiProvider({ fetch: fetchWith(okBody), env: {} }).complete({ prompt: 'x' }, root), 'NO_CREDENTIALS');

  fs.writeFileSync(path.join(root, '.env'), 'GOOGLE_API_KEY="alias-key-1"\n', 'utf8');
  assert.equal(createGeminiProvider({ env: {} }).hasCredentials(root), true, 'GOOGLE_API_KEY alias works');
  fs.rmSync(root, { recursive: true, force: true });
  console.log('✔ Test 6: gemini sends its key in a header and maps its failures');
}

// Shared registry deps: claude-cli available via a scripted spawn, no API keys anywhere
const registryDeps = (over = {}) => ({
  hasBinary: () => true,
  env: {},
  spawn: okSpawn().spawn,
  fetch: async () => new Response('{}', { status: 500 }),
  ...over,
});

// Test 7: default chain, explicit choice and config
{
  const root = tempRoot();
  const only = resolveProviderChain('triage', root, { deps: registryDeps() });
  assert.deepEqual(only.map((p) => p.id), ['claude-cli'], 'with just a Claude login, only claude-cli is available');

  fs.writeFileSync(path.join(root, '.env'), 'ANTHROPIC_API_KEY="sk-ant-x-1234567890"\nGEMINI_API_KEY="g-key-1234"\n', 'utf8');
  assert.deepEqual(resolveProviderChain('triage', root, { deps: registryDeps() }).map((p) => p.id), ['claude-cli', 'claude-api', 'gemini'], 'default order is Claude first');
  assert.equal(resolveProvider('architect', root, { deps: registryDeps() }).id, 'claude-cli');
  assert.deepEqual(resolveProviderChain('triage', root, { provider: 'gemini', deps: registryDeps() }).map((p) => p.id), ['gemini'], 'explicit choice wins');

  fs.mkdirSync(path.join(root, '.nativ'), { recursive: true });
  fs.writeFileSync(path.join(root, '.nativ', 'config.json'), JSON.stringify({ providers: { triage: ['gemini', 'claude-cli'], worker: 'claude-api', pm: ['nope'] } }), 'utf8');
  assert.deepEqual(resolveProviderChain('triage', root, { deps: registryDeps() }).map((p) => p.id), ['gemini', 'claude-cli'], 'per-role config order');
  assert.deepEqual(resolveProviderChain('worker', root, { deps: registryDeps() }).map((p) => p.id), ['claude-api']);
  assert.deepEqual(resolveProviderChain('pm', root, { deps: registryDeps() }).map((p) => p.id), ['claude-cli', 'claude-api', 'gemini'], 'unknown ids fall back to the default chain');

  fs.writeFileSync(path.join(root, '.nativ', 'config.json'), '{not json', 'utf8');
  assert.equal(resolveProviderChain('triage', root, { deps: registryDeps() }).length, 3, 'a corrupt config never breaks resolution');

  assert.equal(resolveProvider('triage', tempRoot(), { deps: registryDeps({ hasBinary: () => false }) }), null, 'nothing available resolves to null');
  fs.rmSync(root, { recursive: true, force: true });
  console.log('✔ Test 7: chain order, explicit override, per-role config and bad config');
}

// Test 8: cooldown skips a limited provider and expires
{
  const root = tempRoot();
  let clock = 5_000_000;
  const deps = registryDeps({ now: () => clock });
  fs.writeFileSync(path.join(root, '.env'), 'GEMINI_API_KEY="g-key-1234"\n', 'utf8');

  assert.equal(providerCooldownRemaining(root, 'claude-cli', clock), 0);
  setProviderCooldown(root, 'claude-cli', 60_000, clock);
  assert.equal(providerCooldownRemaining(root, 'claude-cli', clock), 60_000);
  assert.deepEqual(resolveProviderChain('triage', root, { deps }).map((p) => p.id), ['gemini'], 'a cooling provider is skipped');
  assert.ok(fs.existsSync(path.join(root, '.nativ', 'provider-state.json')), 'cooldown is persisted');

  clock += 59_000;
  assert.deepEqual(resolveProviderChain('triage', root, { deps }).map((p) => p.id), ['gemini'], 'still cooling at 59s');
  clock += 2_000;
  assert.deepEqual(resolveProviderChain('triage', root, { deps }).map((p) => p.id), ['claude-cli', 'gemini'], 'available again after expiry');
  assert.equal(providerCooldownRemaining(root, 'claude-cli', clock), 0);
  fs.rmSync(root, { recursive: true, force: true });
  console.log('✔ Test 8: cooldown skips a limited provider and clears on expiry');
}

// Test 9: completeWithChain falls through, records limits, and reports what answered
{
  const root = tempRoot();
  let clock = 9_000_000;
  fs.writeFileSync(path.join(root, '.env'), 'GEMINI_API_KEY="g-key-1234"\n', 'utf8');
  const limitedSpawn = okSpawn(cliJson({ is_error: true, result: 'usage limit reached' })).spawn;
  const geminiOk = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"from":"gemini"}' }] } }] }), { status: 200 });
  let cliCalls = 0;
  const spawn = async (...a) => {
    cliCalls++;
    const r = await limitedSpawn(...a);
    return { ...r, code: 1 };
  };
  const deps = registryDeps({ spawn, fetch: geminiOk, now: () => clock });

  const first = await completeWithChain('triage', root, { prompt: 'p', json: true }, { deps });
  assert.equal(first.provider, 'gemini', 'falls through to the next provider on a limit');
  assert.equal(first.model, 'gemini-3.8-flash', 'reports the model actually called');
  assert.equal(first.text, '{"from":"gemini"}');
  assert.equal(cliCalls, 1);
  assert.ok(providerCooldownRemaining(root, 'claude-cli', clock) > 0, 'the limit put claude-cli on cooldown');

  const second = await completeWithChain('triage', root, { prompt: 'p' }, { deps });
  assert.equal(second.provider, 'gemini');
  assert.equal(cliCalls, 1, 'the second call does not retry the limited provider');

  // Per-provider model override from config
  const seenModels = [];
  const model = await completeWithChain('triage', root, { prompt: 'p' }, {
    config: { models: { gemini: 'gemini-pinned' } },
    deps: { ...deps, fetch: async (url) => { seenModels.push(String(url)); return geminiOk(); } },
  });
  assert.equal(model.model, 'gemini-pinned');
  assert.ok(seenModels[0].includes('/models/gemini-pinned:'));

  // Everything failing surfaces the last typed error; nothing available says NO_CREDENTIALS
  const failing = registryDeps({ fetch: async () => new Response('{}', { status: 400 }), spawn: async () => ({ code: 1, stdout: cliJson({ is_error: true, result: 'boom' }), stderr: '', timedOut: false }) });
  await REJECTS(completeWithChain('triage', root, { prompt: 'p' }, { deps: { ...failing, now: () => clock + 10 * 3_600_000 } }), 'BAD_RESPONSE');
  await REJECTS(completeWithChain('triage', tempRoot(), { prompt: 'p' }, { deps: registryDeps({ hasBinary: () => false }) }), 'NO_CREDENTIALS');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('✔ Test 9: completeWithChain falls through, remembers limits, honors model config and reports failure');
}

// Test 10: transient failures are retried on the same provider with backoff, then fall through
{
  const root = tempRoot();
  fs.writeFileSync(path.join(root, '.env'), 'GEMINI_API_KEY="g-key-1234"\n', 'utf8');
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  const ok = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'fine' }] } }] }), { status: 200 });
  let calls = 0;
  const flaky = async () => (++calls < 3 ? new Response('{}', { status: 502 }) : ok());
  const deps = { ...registryDeps({ hasBinary: () => false, fetch: flaky }), sleep };
  const recovered = await completeWithChain('triage', root, { prompt: 'p' }, { deps });
  assert.equal(recovered.text, 'fine', 'two 502s then success: the call recovers');
  assert.equal(calls, 3);
  assert.equal(waits.length, 2, 'it waited before each retry');
  assert.ok(waits[0] >= 500 && waits[0] <= 750 && waits[1] >= 1000 && waits[1] <= 1500, `backoff grows with jitter: ${waits}`);

  calls = 0;
  const down = { ...registryDeps({ hasBinary: () => false, fetch: async () => { calls++; return new Response('{}', { status: 503 }); } }), sleep };
  await REJECTS(completeWithChain('triage', root, { prompt: 'p' }, { deps: down }), 'TRANSIENT');
  assert.equal(calls, 1 + MAX_TRANSIENT_RETRIES, 'retries are bounded');

  calls = 0;
  const fatal = { ...registryDeps({ hasBinary: () => false, fetch: async () => { calls++; return new Response('{}', { status: 400 }); } }), sleep };
  await REJECTS(completeWithChain('triage', root, { prompt: 'p' }, { deps: fatal }), 'BAD_RESPONSE');
  assert.equal(calls, 1, 'a request the provider rejected is not retried');
  assert.equal(transientBackoffMs(0, () => 0), 500);
  assert.equal(transientBackoffMs(1, () => 1), 1500);
  fs.rmSync(root, { recursive: true, force: true });
  console.log('✔ Test 10: network errors and 5xx are retried twice with jittered backoff; other failures are not');
}

console.log('\n🎉 ALL PROVIDER ADAPTER TESTS PASSED!');
