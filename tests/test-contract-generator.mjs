import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

console.log('--- Starting Contract-to-Test Generator Verification ---');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'bin', 'cli.js');
const dist = (p) => pathToFileURL(path.join(repoRoot, 'dist', p)).href;

const { generateContractTests, buildEndpointSuite, TestGenError } = await import(dist('core/test-generator.js'));
const { parseFieldDescriptor } = await import(dist('core/test-generator-types.js'));
const { startStudioServer } = await import(dist('server/studio-server.js'));
const ts = (await import('typescript')).default;

const execFileAsync = promisify(execFile);
const tempDirs = [];

// ─── Fixtures ──────────────────────────────────────────────────────────────

const API_CONTRACT = {
  projectName: 'gen-fixture',
  endpoints: [
    {
      id: 'items-list',
      path: '/api/items',
      method: 'GET',
      auth: false,
      request: { headers: {}, queryParams: {}, pathParams: {}, body: null },
      responses: {
        200: {
          body: {
            items: 'array of object',
            total: 'integer',
            status: "string ('ok' | 'degraded')",
            note: 'string | null',
            cursor: 'string (optional)',
          },
        },
      },
    },
    {
      id: 'items-search',
      path: '/api/items/search',
      method: 'GET',
      auth: false,
      request: { queryParams: { q: 'string', limit: 'integer (optional, default 25)' }, body: null },
      responses: { 200: { body: { items: 'array of object' } } },
    },
    {
      id: 'items-create',
      path: '/api/items',
      method: 'POST',
      auth: true,
      request: { headers: { 'Content-Type': 'application/json' }, body: { name: 'string', price: 'number', tags: 'array of string (optional)' } },
      responses: { 200: { body: { id: 'string' } } },
    },
    {
      id: 'items-delete',
      path: '/api/items',
      method: 'DELETE',
      auth: false,
      request: { body: { id: 'string' } },
      responses: { 200: { body: { deletedCount: 'number (1)' } } },
    },
    {
      id: 'settings-update',
      path: '/api/settings',
      method: 'PUT',
      auth: false,
      request: { body: { mode: "string (optional: 'a' | 'b')" } },
      responses: { 200: { body: { mode: 'string' } } },
    },
    {
      // Needs a real id and has nothing to invalidate: produces no cases and is not covered.
      id: 'user-get',
      path: '/api/users/:id',
      method: 'GET',
      auth: false,
      request: { pathParams: { id: 'string' }, body: null },
      responses: { 200: { body: { id: 'string' } } },
    },
  ],
};

const SQL_SCHEMA = {
  projectName: 'gen-fixture',
  engine: 'postgresql',
  tables: [
    {
      name: 'items',
      columns: [
        { name: 'id', type: 'UUID', primaryKey: true, nullable: false, default: null },
        { name: 'name', type: 'VARCHAR(120)', primaryKey: false, nullable: false, default: null },
        { name: 'sku', type: 'VARCHAR(40)', primaryKey: false, nullable: false, default: null },
        { name: 'notes', type: 'TEXT', primaryKey: false, nullable: true, default: null },
      ],
      indexes: [{ name: 'idx_items_sku', columns: ['sku'], unique: true }],
      foreignKeys: [],
    },
  ],
};

const FIRESTORE_SCHEMA = {
  projectName: 'gen-fixture',
  engine: 'firestore',
  tables: [
    {
      name: 'profiles',
      entityType: 'collection',
      columns: [
        { name: 'id', type: 'DOCUMENT_ID', primaryKey: true, nullable: false, default: null },
        { name: 'email', type: 'STRING', primaryKey: false, nullable: false, default: null },
        { name: 'bio', type: 'STRING', primaryKey: false, nullable: true, default: null },
      ],
      indexes: [{ name: 'idx_profiles_email', columns: ['email'], unique: true }],
      foreignKeys: [],
    },
  ],
};

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createProject({ api = API_CONTRACT, db = SQL_SCHEMA } = {}) {
  const dir = tempDir('nativ-testgen-');
  fs.mkdirSync(path.join(dir, '.ai'), { recursive: true });
  if (api) fs.writeFileSync(path.join(dir, '.ai', 'api_contracts.json'), JSON.stringify(api, null, 2));
  if (db) fs.writeFileSync(path.join(dir, '.ai', 'db_schema.json'), JSON.stringify(db, null, 2));
  return dir;
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath ?? e.path, e.name)).split(path.sep).join('/'))
    .sort();
}

/** An API that implements API_CONTRACT; `broken` makes it violate the contract in known ways. */
function startFixtureApi({ broken = false } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = null;
    }
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /api/items') {
      return broken
        ? send(200, { items: 'not-an-array', total: 1.5, status: 'weird' })
        : send(200, { items: [{ id: 'a' }], total: 1, status: 'ok', note: null });
    }
    if (route === 'GET /api/items/search') return url.searchParams.get('q') ? send(200, { items: [] }) : send(400, { error: 'q required' });
    if (route === 'POST /api/items') {
      if (!broken && !req.headers.authorization) return send(401, { error: 'auth required' });
      if (!body || typeof body.name !== 'string' || typeof body.price !== 'number') return send(400, { error: 'invalid' });
      return send(200, { id: 'new' });
    }
    if (route === 'DELETE /api/items') return body && typeof body.id === 'string' ? send(200, { deletedCount: 1 }) : send(400, { error: 'id required' });
    if (route === 'PUT /api/settings') {
      if (broken) return send(200, { mode: 'a' });
      return body && (body.mode === undefined || ['a', 'b'].includes(body.mode)) ? send(200, { mode: body.mode ?? 'a' }) : send(400, { error: 'bad mode' });
    }
    if (url.pathname === '/api/items' || url.pathname === '/api/settings') return send(405, { error: 'method' });
    return send(404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` })));
}

/** Runs generated node:test files and returns pass/fail/skip counts from the TAP summary. */
async function runNodeTests(cwd, pattern, env = {}) {
  let stdout = '';
  try {
    ({ stdout } = await execFileAsync(process.execPath, ['--test', '--test-reporter=tap', pattern], {
      cwd,
      env: { ...process.env, ...env },
      timeout: 120000,
    }));
  } catch (err) {
    stdout = String(err.stdout ?? '');
  }
  const count = (name) => Number((stdout.match(new RegExp(`^# ${name} (\\d+)`, 'm')) ?? [])[1] ?? NaN);
  return { pass: count('pass'), fail: count('fail'), skipped: count('skipped'), stdout };
}

function writeLiveSchema(dir, tables, connected = true) {
  const file = path.join(dir, `live-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({ status: { connected, engine: 'postgresql', error: connected ? null : 'offline' }, tables }));
  return file;
}

let passed = 0;
const check = (label) => {
  passed++;
  console.log(`  ✔ ${label}`);
};

// ─── MCP client ────────────────────────────────────────────────────────────

function startMcp(projectDir) {
  const child = spawn(process.execPath, [cliPath, 'mcp', projectDir], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let buffer = '';
  let stderr = '';
  let nextId = 1;
  child.stderr.on('data', (c) => (stderr += c));
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
  return {
    notify: (method) => send({ jsonrpc: '2.0', method }),
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}. stderr:\n${stderr}`)), 20000);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
        send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
      });
    },
    close() {
      child.stdin.end();
      child.kill();
    },
  };
}

// ─── Checks ────────────────────────────────────────────────────────────────

const fixtureApi = await startFixtureApi();
const brokenApi = await startFixtureApi({ broken: true });
let studio = null;
let mcp = null;

try {
  // 1. Descriptor parsing
  assert.deepEqual(parseFieldDescriptor("string (optional: 'dev' | 'prod')"), { kind: 'enum', base: 'string', values: ['dev', 'prod'], optional: true });
  assert.deepEqual(parseFieldDescriptor("boolean (required if env === 'prod')"), { kind: 'primitive', type: 'boolean', optional: true, requiredIf: "env === 'prod'" });
  assert.equal(parseFieldDescriptor('array of TableSchema').items.name, 'TableSchema');
  assert.equal(parseFieldDescriptor('string | null').kind, 'union');
  assert.equal(parseFieldDescriptor('array of { key: string, targetEnv: \'dev\' | \'prod\' }').items.properties.targetEnv.kind, 'enum');
  check('contract descriptors parse into typed schema nodes (enums, optional, required-if, unions, arrays, refs)');

  // 2. Case synthesis rules
  const byId = Object.fromEntries(API_CONTRACT.endpoints.map((e) => [e.id, buildEndpointSuite(e)]));
  const kinds = (id) => byId[id].cases.map((c) => c.kind);
  assert.deepEqual(kinds('items-list'), ['route', 'response-schema']);
  assert.deepEqual(kinds('items-search'), ['route', 'invalid-payload']);
  assert.deepEqual(kinds('items-create'), ['route', 'auth-required', 'invalid-payload']);
  assert.deepEqual(kinds('settings-update'), ['route', 'invalid-payload']);
  assert.deepEqual(kinds('user-get'), []);
  for (const suite of Object.values(byId)) {
    for (const c of suite.cases) {
      if (c.request.method === 'GET') continue;
      // Mutating endpoints only ever receive requests the contract says must be rejected.
      assert.ok(['route', 'auth-required', 'invalid-payload'].includes(c.kind), `${c.id} must not send a valid mutating request`);
      assert.deepEqual(c.request.body, byId[suite.source.endpointId].cases.find((x) => x.kind === 'invalid-payload')?.request.body);
    }
  }
  assert.deepEqual(byId['settings-update'].cases[1].request.body, { mode: 12345 });
  check('endpoint synthesis: route/401/400 cases, happy path only for input-free GETs, never a valid mutating request');

  // 3. Dry run across frameworks + coverage counts
  const project = createProject();
  const expectedFiles = {
    vitest: ['api/items-create.contract.test.ts', 'db/items.contract.test.ts', 'nativ-contract-support.ts'],
    jest: ['api/items-list.contract.test.ts', 'db/items.contract.test.ts', 'nativ-contract-support.ts'],
    'node:test': ['api/items-search.contract.test.mjs', 'db/items.contract.test.mjs', 'nativ-contract-support.mjs'],
    pytest: ['nativ_contract_support.py', 'test_api_items_create.py', 'test_db_items.py'],
    go: ['api_items_create_test.go', 'db_items_test.go', 'nativ_support_test.go'],
  };
  for (const [framework, samples] of Object.entries(expectedFiles)) {
    const result = generateContractTests({ targetDir: project, framework, dryRun: true, baseUrl: fixtureApi.baseUrl });
    assert.equal(result.framework, framework);
    assert.equal(result.projectName, 'gen-fixture');
    assert.equal(result.outputDir, 'tests/contract');
    assert.equal(result.endpointsCovered, 5, 'user-get has no safe cases and is not covered');
    assert.equal(result.tablesCovered, 1);
    assert.equal(result.files.length, 1 + 5 + 1);
    assert.equal(typeof result.durationMs, 'number');
    const paths = result.files.map((f) => f.relativePath);
    for (const sample of samples) assert.ok(paths.includes(sample), `${framework}: missing ${sample} in ${paths.join(', ')}`);
    for (const file of result.files) {
      assert.ok(['api-contract', 'db-integrity', 'support'].includes(file.suiteType));
      assert.match(file.content, /Code generated by nativ test gen/);
    }
  }
  assert.deepEqual(listFiles(path.join(project, 'tests')), [], 'dry run must not write files');
  check('dry run synthesizes vitest/jest/node:test/pytest/go suites with correct coverage and writes nothing');

  // 4. Vitest & Jest output is valid TypeScript with the right runner imports
  for (const framework of ['vitest', 'jest']) {
    const result = generateContractTests({ targetDir: project, framework, dryRun: true });
    for (const file of result.files) {
      const out = ts.transpileModule(file.content, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
      assert.deepEqual(out.diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')), [], `${framework} ${file.relativePath} has syntax errors`);
    }
    const suite = result.files.find((f) => f.relativePath === 'api/items-list.contract.test.ts').content;
    assert.match(suite, framework === 'vitest' ? /from 'vitest'/ : /from '@jest\/globals'/);
    assert.match(suite, /from '\.\.\/nativ-contract-support'/);
  }
  const fsSchema = createProject({ db: FIRESTORE_SCHEMA });
  const fsDb = generateContractTests({ targetDir: fsSchema, framework: 'vitest', dryRun: true }).files.find((f) => f.suiteType === 'db-integrity').content;
  assert.doesNotMatch(fsDb, /unique-constraint/, 'Firestore has no unique indexes');
  assert.doesNotMatch(fsDb, /"column": "bio",\s*"nullable"/, 'optional collection fields get no nullability check');
  assert.match(generateContractTests({ targetDir: project, framework: 'vitest', dryRun: true }).files.find((f) => f.suiteType === 'db-integrity').content, /"kind": "unique-constraint"/);
  check('vitest/jest output transpiles cleanly; unique checks only where the engine supports them');

  // 5. Disk writes, overwrite protection, path containment
  const written = generateContractTests({ targetDir: project, framework: 'node:test', outputDir: 'generated/node', baseUrl: fixtureApi.baseUrl });
  const outDir = path.join(project, 'generated', 'node');
  assert.deepEqual(listFiles(outDir), written.files.map((f) => f.relativePath).sort());
  assert.equal(written.outputDir, 'generated/node');
  generateContractTests({ targetDir: project, framework: 'node:test', outputDir: 'generated/node', baseUrl: fixtureApi.baseUrl });
  fs.writeFileSync(path.join(outDir, 'nativ-contract-support.mjs'), '// my own helpers\n');
  assert.throws(
    () => generateContractTests({ targetDir: project, framework: 'node:test', outputDir: 'generated/node' }),
    (err) => err instanceof TestGenError && err.code === 'OUTPUT_CONFLICT',
  );
  assert.equal(fs.readFileSync(path.join(outDir, 'nativ-contract-support.mjs'), 'utf8'), '// my own helpers\n', 'hand-written file untouched');
  fs.rmSync(path.join(outDir, 'nativ-contract-support.mjs'));
  generateContractTests({ targetDir: project, framework: 'node:test', outputDir: 'generated/node', baseUrl: fixtureApi.baseUrl });
  assert.throws(() => generateContractTests({ targetDir: project, framework: 'mocha' }), (e) => e.code === 'INVALID_FRAMEWORK');
  assert.throws(() => generateContractTests({ targetDir: project, baseUrl: 'ftp://x' }), (e) => e.code === 'INVALID_BASE_URL');
  assert.throws(() => generateContractTests({ targetDir: tempDir('nativ-empty-') }), (e) => e.code === 'NO_CONTRACTS');
  check('writes to disk, regenerates in place, refuses to overwrite hand-written files, validates options');

  // 6. Generated API suites pass against a conforming API and catch a broken one
  const good = await runNodeTests(outDir, 'api/*.test.mjs', { NATIV_TEST_AUTH_HEADER: 'Bearer fixture' });
  assert.equal(good.fail, 0, `conforming API should pass:\n${good.stdout}`);
  assert.equal(good.pass, 11);
  const bad = await runNodeTests(outDir, 'api/*.test.mjs', { NATIV_TEST_BASE_URL: brokenApi.baseUrl, NATIV_TEST_AUTH_HEADER: 'Bearer fixture' });
  assert.equal(bad.fail, 3, `expected shape, 401 and enum-validation failures:\n${bad.stdout}`);
  assert.match(bad.stdout, /\$\.items: expected array/);
  assert.match(bad.stdout, /\$\.note: missing required field/);
  check(`generated API suites: ${good.pass}/${good.pass} pass on a conforming API, ${bad.fail} contract violations caught on a broken one`);

  // 7. Generated DB suites against matching, drifted and unreachable schemas
  const liveItems = (overrides = {}) => [
    {
      name: 'items',
      columns: [
        { name: 'id', type: 'uuid', primaryKey: true, nullable: false },
        { name: 'name', type: 'varchar', primaryKey: false, nullable: false },
        { name: 'sku', type: 'varchar', primaryKey: false, nullable: false },
        { name: 'notes', type: 'text', primaryKey: false, nullable: true },
      ],
      indexes: [{ name: 'items_sku_key', columns: ['sku'], unique: true }],
      ...overrides,
    },
  ];
  const dbOk = await runNodeTests(outDir, 'db/*.test.mjs', { NATIV_DB_SCHEMA_JSON: writeLiveSchema(project, liveItems()) });
  assert.equal(dbOk.fail, 0, dbOk.stdout);
  assert.equal(dbOk.pass, 10);
  const drifted = liveItems({
    columns: [
      { name: 'id', type: 'uuid', primaryKey: true, nullable: false },
      { name: 'name', type: 'varchar', primaryKey: false, nullable: true },
      { name: 'notes', type: 'text', primaryKey: false, nullable: true },
    ],
    indexes: [],
  });
  const dbBad = await runNodeTests(outDir, 'db/*.test.mjs', { NATIV_DB_SCHEMA_JSON: writeLiveSchema(project, drifted) });
  assert.equal(dbBad.fail, 4, `missing sku (column + nullability + unique) and nullable name:\n${dbBad.stdout}`);
  assert.match(dbBad.stdout, /"items\.name" is nullable in the live database, contract says NOT NULL/);
  // A failing inspect command that still prints its JSON status, exactly like `nativ db inspect --json`.
  const offlineScript = path.join(project, 'offline-inspect.mjs');
  fs.writeFileSync(offlineScript, "console.log(JSON.stringify({ status: { connected: false, error: 'offline fixture' }, tables: [] })); process.exitCode = 1;\n");
  const dbOff = await runNodeTests(outDir, 'db/*.test.mjs', { NATIV_DB_INSPECT_CMD: `"${process.execPath}" "${offlineScript}"` });
  assert.equal(dbOff.fail, 0, dbOff.stdout);
  assert.equal(dbOff.pass, 0);
  assert.match(dbOff.stdout, /live database unavailable: offline fixture/);
  check('generated DB suites: pass on a matching schema, catch drift, skip with a reason when the database is unreachable');

  // 8. CLI
  const cli = await execFileAsync(process.execPath, [cliPath, 'test', 'gen', project, '--dry-run', '--json', '--framework', 'jest']);
  const cliJson = JSON.parse(cli.stdout);
  assert.equal(cliJson.framework, 'jest');
  assert.equal(cliJson.endpointsCovered, 5);
  const cliBad = await execFileAsync(process.execPath, [cliPath, 'test', 'gen', project, '--framework', 'mocha', '--json']).catch((e) => e);
  assert.equal(cliBad.code, 1);
  assert.equal(JSON.parse(cliBad.stdout).error.code, 'INVALID_FRAMEWORK');
  check('nativ test gen: --dry-run --json returns the contract shape; invalid framework exits 1 with a JSON error');

  // 9. Studio endpoint
  studio = await startStudioServer({ port: 0, cwd: project, connections: { dev: null, prod: null } });
  const studioUrl = `http://localhost:${studio.server.address().port}/api/tests/generate`;
  const post = async (body) => {
    const res = await fetch(studioUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const dry = await post({ dryRun: true, framework: 'pytest' });
  assert.equal(dry.status, 200);
  assert.deepEqual(Object.keys(dry.body).sort(), ['durationMs', 'endpointsCovered', 'files', 'framework', 'outputDir', 'projectName', 'tablesCovered']);
  assert.deepEqual(Object.keys(dry.body.files[0]).sort(), ['content', 'relativePath', 'suiteType']);
  assert.equal((await post({ outputDir: '../escape' })).status, 400);
  assert.equal((await post({ framework: 'mocha' })).status, 400);
  assert.equal((await post({ dryRun: 'yes' })).status, 400);
  assert.equal((await fetch(studioUrl)).status, 405);
  const viaStudio = await post({ outputDir: 'generated/studio', framework: 'go' });
  assert.equal(viaStudio.status, 200);
  assert.ok(fs.existsSync(path.join(project, 'generated', 'studio', 'nativ_support_test.go')));
  check('POST /api/tests/generate: contract response shape, input validation, output confined to the project');

  // 10. MCP tool
  mcp = startMcp(project);
  await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'nativ-test', version: '0.0.0' } });
  mcp.notify('notifications/initialized');
  const tools = (await mcp.request('tools/list')).result.tools;
  for (const name of ['nativ_test_gen']) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `missing ${name}`);
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['baseUrl', 'dryRun', 'framework', 'output']);
  }
  assert.ok(!tools.some((t) => t.name === 'agentj_test_gen'), 'the retired agentj_ alias is gone');
  const mcpDry = await mcp.request('tools/call', { name: 'nativ_test_gen', arguments: { dryRun: true, framework: 'vitest' } });
  assert.notEqual(mcpDry.result.isError, true);
  const mcpJson = JSON.parse(mcpDry.result.content[0].text);
  assert.equal(mcpJson.endpointsCovered, 5);
  assert.equal(mcpJson.tablesCovered, 1);
  const mcpEscape = await mcp.request('tools/call', { name: 'nativ_test_gen', arguments: { output: '../escape' } });
  assert.equal(mcpEscape.result.isError, true);
  const mcpBadFw = await mcp.request('tools/call', { name: 'nativ_test_gen', arguments: { framework: 'mocha' } });
  assert.ok(mcpBadFw.error || mcpBadFw.result?.isError, 'framework enum must be enforced');
  const mcpWrite = await mcp.request('tools/call', { name: 'nativ_test_gen', arguments: { output: 'generated/mcp', framework: 'node:test' } });
  assert.notEqual(mcpWrite.result.isError, true);
  assert.ok(fs.existsSync(path.join(project, 'generated', 'mcp', 'nativ-contract-support.mjs')));
  check('nativ_test_gen over MCP: schema, dry run, writes, and output containment');

  console.log(`\n✔ All ${passed} contract generator checks passed.`);
} catch (err) {
  console.error('\n✖ Contract generator verification failed:', err);
  process.exitCode = 1;
} finally {
  mcp?.close();
  studio?.server.close();
  fixtureApi.server.close();
  brokenApi.server.close();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
}
