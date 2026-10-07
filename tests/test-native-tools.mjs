import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ToolInputError,
  buildToolEnv,
  clipToolOutput,
  resolveEditorPath,
  runEditorCommand,
} from '../dist/runner/native-tools.js';
import { NATIVE_TOOL_OUTPUT_LIMIT } from '../dist/runner/types.js';
import { applyApiPatch, applyDbPatch, applyPatch, atomicWriteJson, contractFileFor, getContractHash } from '../dist/governor/patch-applier.js';

console.log('--- Starting Native Tool & Patch Applier Tests ---');

const dirs = [];
const tmp = (prefix) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
};
const refused = (fn, pattern) => assert.throws(fn, (err) => err instanceof ToolInputError && pattern.test(err.message));

try {
  // Test 1: editor paths stay inside the workspace, away from secrets and read-only folders
  {
    const project = tmp('nativ-tools-project-');
    const workspace = path.join(project, '.worktrees', 'task-1');
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    fs.mkdirSync(path.join(project, '.ai'), { recursive: true });

    assert.equal(resolveEditorPath(workspace, project, 'src/a.ts', 'write'), path.join(workspace, 'src', 'a.ts'));
    refused(() => resolveEditorPath(workspace, project, '../../outside.txt', 'read'), /outside the workspace/);
    refused(() => resolveEditorPath(workspace, project, path.join(os.tmpdir(), 'x.txt'), 'read'), /outside the workspace/);
    refused(() => resolveEditorPath(workspace, project, 'src/%2e%2e/x', 'read'), /URL-encoded/);
    refused(() => resolveEditorPath(workspace, project, '', 'read'), /"path" is required/);
    for (const secret of ['.env', '.env.local', 'config/server.pem', 'certs/site.key', '.nativ/keys.local.json']) {
      refused(() => resolveEditorPath(workspace, project, secret, 'read'), /Secret files/);
    }
    assert.equal(resolveEditorPath(workspace, project, '.env.example', 'read'), path.join(workspace, '.env.example'), '.env.example is readable');
    for (const ro of ['.ai/db_schema.json', '.nativ/config.json', 'node_modules/x/index.js', '.git/config']) {
      refused(() => resolveEditorPath(workspace, project, ro, 'write'), /read-only/);
    }

    // A link inside the workspace must not carry a write outside it
    const outside = tmp('nativ-tools-outside-');
    let linked = false;
    try {
      fs.symlinkSync(outside, path.join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
      linked = true;
    } catch {
      // Creating links needs extra rights on some Windows machines; the lexical checks above still ran.
    }
    if (linked) refused(() => resolveEditorPath(workspace, project, 'escape/evil.txt', 'write'), /resolves outside the workspace/);
    console.log(`✔ Test 1: paths are confined; secrets, .ai/, .nativ/, node_modules/ and .git/ are protected${linked ? '; links cannot escape' : ''}`);
  }

  // Test 2: view lists folders, numbers lines and honours view_range
  {
    const ws = tmp('nativ-tools-view-');
    fs.mkdirSync(path.join(ws, 'src'));
    fs.mkdirSync(path.join(ws, '.git'));
    fs.writeFileSync(path.join(ws, 'src', 'a.txt'), 'one\ntwo\nthree\nfour');
    assert.equal(runEditorCommand(ws, ws, { command: 'view', path: '.' }), 'src/', '.git is hidden from listings');
    assert.equal(runEditorCommand(ws, ws, { command: 'view', path: 'src/a.txt' }), '1\tone\n2\ttwo\n3\tthree\n4\tfour');
    assert.equal(runEditorCommand(ws, ws, { command: 'view', path: 'src/a.txt', view_range: [2, 3] }), '2\ttwo\n3\tthree');
    assert.equal(runEditorCommand(ws, ws, { command: 'view', path: 'src/a.txt', view_range: [3, -1] }), '3\tthree\n4\tfour');
    refused(() => runEditorCommand(ws, ws, { command: 'view', path: 'src/a.txt', view_range: [4, 2] }), /Invalid view_range/);
    refused(() => runEditorCommand(ws, ws, { command: 'view', path: 'src/a.txt', view_range: 'all' }), /must be \[startLine, endLine\]/);
    refused(() => runEditorCommand(ws, ws, { command: 'view', path: 'nope.txt' }), /does not exist/);
    refused(() => runEditorCommand(ws, ws, { command: 'delete', path: 'src/a.txt' }), /Unsupported editor command/);
    console.log('✔ Test 2: view lists folders, numbers lines and validates ranges');
  }

  // Test 3: create, str_replace and insert edit exactly what was asked
  {
    const ws = tmp('nativ-tools-edit-');
    const file = path.join(ws, 'lib', 'm.js');
    assert.match(runEditorCommand(ws, ws, { command: 'create', path: 'lib/m.js', file_text: 'a = 1\nb = 2\nb = 2\n' }), /created/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'a = 1\nb = 2\nb = 2\n', 'create makes missing folders');

    refused(() => runEditorCommand(ws, ws, { command: 'str_replace', path: 'lib/m.js', old_str: 'b = 2', new_str: 'b = 3' }), /Found 2 matches/);
    refused(() => runEditorCommand(ws, ws, { command: 'str_replace', path: 'lib/m.js', old_str: 'zzz', new_str: '' }), /No match/);
    refused(() => runEditorCommand(ws, ws, { command: 'str_replace', path: 'lib/m.js', old_str: '' }), /"old_str" must be a non-empty string/);
    runEditorCommand(ws, ws, { command: 'str_replace', path: 'lib/m.js', old_str: 'a = 1', new_str: 'a = $& $1' });
    assert.equal(fs.readFileSync(file, 'utf8').split('\n')[0], 'a = $& $1', 'replacement text is literal, not a regex pattern');

    fs.writeFileSync(file, 'x\r\ny\r\n');
    runEditorCommand(ws, ws, { command: 'str_replace', path: 'lib/m.js', old_str: 'x\ny', new_str: 'x\nz' });
    assert.equal(fs.readFileSync(file, 'utf8'), 'x\r\nz\r\n', 'LF edits apply to CRLF files and keep CRLF');

    runEditorCommand(ws, ws, { command: 'insert', path: 'lib/m.js', insert_line: 1, insert_text: 'mid' });
    assert.equal(fs.readFileSync(file, 'utf8'), 'x\r\nmid\r\nz\r\n', 'insert keeps the file line endings');
    runEditorCommand(ws, ws, { command: 'insert', path: 'lib/m.js', insert_line: 0, insert_text: 'top' });
    assert.ok(fs.readFileSync(file, 'utf8').startsWith('top\r\n'));
    refused(() => runEditorCommand(ws, ws, { command: 'insert', path: 'lib/m.js', insert_line: 99, insert_text: 'x' }), /between 0 and 4/);
    refused(() => runEditorCommand(ws, ws, { command: 'insert', path: 'missing.js', insert_line: 0, insert_text: 'x' }), /does not exist/);
    console.log('✔ Test 3: create, str_replace (unique, literal, CRLF-aware) and insert (bounded) behave exactly');
  }

  // Test 4: output clipping and the tool environment
  {
    const long = 'a'.repeat(NATIVE_TOOL_OUTPUT_LIMIT + 1000);
    const clipped = clipToolOutput(long);
    assert.match(clipped, /\[\.\.\. 1000 characters omitted \.\.\.\]/);
    assert.ok(clipped.length < long.length);
    assert.equal(clipToolOutput('short'), 'short');
    const env = buildToolEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk-x', HOME: '/h' }, { GITHUB_TOKEN: 'ghp', LANG: undefined });
    assert.equal(env.PATH, '/bin');
    assert.equal(env.ANTHROPIC_API_KEY, undefined, 'API keys never reach model-run commands');
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.ok(!('LANG' in env), 'undefined values are dropped');
    console.log('✔ Test 4: long output is clipped in the middle; secrets are stripped from the tool environment');
  }

  // Test 5: contract patches
  {
    const schema = { tables: [{ name: 'users', columns: [{ name: 'id', type: 'INT', nullable: false }] }] };
    applyDbPatch(schema, { taskId: 't', target: 'db_schema', operation: 'ADD', path: 'tables.users.columns.nickname', reason: 'r' });
    assert.deepEqual(schema.tables[0].columns[1], { name: 'nickname', type: 'TEXT', nullable: true }, 'a bare column add is a nullable TEXT');
    applyDbPatch(schema, { taskId: 't', target: 'db_schema', operation: 'ALTER', path: 'users.columns.nickname', value: { type: 'VARCHAR(40)' }, reason: 'r' });
    assert.equal(schema.tables[0].columns[1].type, 'VARCHAR(40)', 'ALTER merges into the column');
    assert.equal(schema.tables[0].columns[1].nullable, true);
    applyDbPatch(schema, { taskId: 't', target: 'db_schema', operation: 'ADD', path: 'tables.orders', reason: 'r' });
    assert.deepEqual(schema.tables[1], { name: 'orders', columns: [], indexes: [], foreignKeys: [] });
    applyDbPatch(schema, { taskId: 't', target: 'db_schema', operation: 'ADD', path: 'users.indexes.by_nick', value: { name: 'by_nick', columns: ['nickname'] }, reason: 'r' });
    assert.deepEqual(schema.tables[0].indexes, [{ name: 'by_nick', columns: ['nickname'] }]);
    const before = JSON.stringify(schema.tables);
    applyDbPatch(schema, { taskId: 't', target: 'db_schema', operation: 'ADD', path: 'ghosts.columns.x', reason: 'r' });
    assert.equal(JSON.stringify(schema.tables), before, 'a column on an unknown table changes nothing');
    assert.ok(schema.updatedAt);

    const api = { endpoints: [{ id: 'list-users', path: '/users', method: 'GET' }] };
    applyApiPatch(api, { taskId: 't', target: 'api_contracts', operation: 'ADD', path: 'endpoints.new', value: { path: '/orders', method: 'POST' }, reason: 'r' });
    assert.equal(api.endpoints[1].path, '/orders');
    applyApiPatch(api, { taskId: 't', target: 'api_contracts', operation: 'ADD', path: 'endpoints.list-users.request.queryParams.sort', value: { type: 'string' }, reason: 'r' });
    assert.deepEqual(api.endpoints[0].request.queryParams.sort, { type: 'string' });
    applyApiPatch(api, { taskId: 't', target: 'api_contracts', operation: 'ADD', path: 'list-users.responses.201', value: { id: 'number' }, reason: 'r' });
    assert.deepEqual(api.endpoints[0].responses['201'], { description: 'Success', body: { id: 'number' } });
    assert.equal(applyPatch({ tables: [] }, { taskId: 't', target: 'db_schema', operation: 'ADD', path: 'tables.x', reason: 'r' }).tables[0].name, 'x');
    assert.equal(contractFileFor('db_schema'), 'db_schema.json');
    assert.equal(contractFileFor('api_contracts'), 'api_contracts.json');

    const dir = tmp('nativ-patch-');
    const file = path.join(dir, 'nested', 'c.json');
    assert.equal(atomicWriteJson(file, { a: 1 }), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 });
    assert.match(getContractHash(file), /^[0-9a-f]{64}$/);
    assert.equal(getContractHash(path.join(dir, 'missing.json')), null);
    fs.writeFileSync(path.join(dir, 'blocker'), 'a file, not a folder');
    assert.equal(atomicWriteJson(path.join(dir, 'blocker', 'c.json'), { a: 1 }), false, 'a failed write reports false instead of throwing');
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temp file is left behind');
    console.log('✔ Test 5: db and api patches add, alter and ignore unknown targets; atomic writes report failure');
  }

  console.log('\n🎉 ALL NATIVE TOOL & PATCH APPLIER TESTS PASSED!');
} finally {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
