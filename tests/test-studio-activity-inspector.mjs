import vm from 'node:vm';
import assert from 'node:assert/strict';

// Run with `npx tsx tests/test-studio-activity-inspector.mjs`: main-tree changes in the inspector.
import { formatScript } from '../src/server/studio-ui/shell/format.ts';
import { consoleScript } from '../src/server/studio-ui/shell/console.ts';

const els = new Map();
const el = (id) => {
  if (!els.has(id)) els.set(id, { id, innerHTML: '', textContent: '', hidden: false, disabled: false,
    setAttribute() {}, focus() {} });
  return els.get(id);
};
const doc = { getElementById: el, addEventListener() {}, activeElement: null, contains: () => false };
const calls = [];
let reply = null;

// Stubbed fetch: the reply callback returns { status, body }.
async function fetchStub(url) {
  calls.push(url);
  const { status, body } = reply(url);
  return { ok: status < 400, status, json: async () => body };
}

// Same error contract as shell/core.ts api().
function api(url) {
  return fetchStub(url).then((res) => res.json().then((body) => {
    if (!res.ok || body.ok === false) {
      const err = new Error(typeof body.error === 'string' ? body.error : 'Request failed');
      err.code = body.code;
      err.status = res.status;
      throw err;
    }
    return body;
  }));
}

const prelude = `
  var pipe = { worktrees: [], loaded: {}, errors: {} };
  var window = { addEventListener() {}, matchMedia: null };
  var $ = function (id) { return document.getElementById(id); };
  var document = doc;
  var Studio = {};
  var fetch = fetchStub;
  var api = apiStub;
`;
const ctx = vm.createContext({ doc, fetchStub, apiStub: api, console });
const exposed = '\n  return { loadConsoleDiff: loadConsoleDiff, pipe: pipe, rc: rc };';
const factory = vm.runInContext(
  `(function () {\n${prelude}\n${formatScript}\n${consoleScript}\n${exposed}\n})`, ctx);
const shell = factory();

const MAIN = { worktrees: [{ path: '/repo', isAgentWorktree: false }] };
const AGENT = { worktrees: [{ path: '/repo/.worktrees/t1', isAgentWorktree: true, taskId: 'task-1' }] };

function setWorktrees(slice) {
  shell.pipe.worktrees = slice.worktrees;
  shell.pipe.loaded.worktrees = true;
  shell.pipe.errors.worktrees = null;
}

async function open(taskId, handler) {
  calls.length = 0;
  reply = handler;
  shell.rc.taskId = taskId;
  shell.rc.tab = 'diff';
  await shell.loadConsoleDiff(taskId);
  return el('rc-diff-summary').innerHTML + el('rc-diff-files').innerHTML + el('rc-diff-body').innerHTML;
}

const DIFF = 'diff --git a/x.ts b/x.ts\n+<script>alert(1)</script>\n-old\n';
const changes = {
  status: 200,
  body: {
    ok: true, taskId: 'task-2', scope: 'main', base: 'abc123',
    files: [{ path: 'src/<a>.ts', added: 3, removed: 1, status: 'modified' }],
    diff: DIFF,
  },
};

// 1. Main-tree task: files, +/- counts, escaped diff, label.
setWorktrees(MAIN);
let html = await open('task-2', () => changes);
assert.deepEqual(calls, ['/api/pipeline/tasks/changes?taskId=task-2&full=1'], 'main-tree url');
assert.match(el('rc-diff-summary').innerHTML, /Changes in the working tree since task start/, 'label');
assert.match(el('rc-diff-files').innerHTML, /<span class="mono">\+3 -1<\/span>/, 'counts in mono');
assert.ok(el('rc-diff-files').innerHTML.includes('src/&lt;a&gt;.ts'), 'path escaped');
assert.ok(!el('rc-diff-files').innerHTML.includes('src/<a>'), 'no raw path');
assert.ok(el('rc-diff-body').innerHTML.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'diff escaped');
assert.ok(!el('rc-diff-body').innerHTML.includes('<script>'), 'no raw script in diff');
assert.equal(el('rc-diff-count').textContent, '1', 'count');
assert.equal(el('rc-diff-files').hidden, false, 'file list shown');
assert.equal(el('rc-diff-refresh').disabled, false, 'refresh re-enabled');
assert.ok(html.length > 0);

// 2. NO_BASELINE: plain empty state, no error card.
setWorktrees(MAIN);
await open('task-3', () => ({ status: 400, body: { ok: false, code: 'NO_BASELINE', error: 'no baseline' } }));
assert.ok(el('rc-diff-body').innerHTML.includes('No start commit was recorded for this task.'), 'NO_BASELINE copy');
assert.ok(!el('rc-diff-summary').innerHTML.includes('Could not load'), 'no error card');
assert.ok(!el('rc-diff-body').innerHTML.includes('no baseline'), 'raw error not shown');

// 3. Other errors use the existing error display.
setWorktrees(MAIN);
await open('task-4', () => ({ status: 400, body: { ok: false, code: 'TASK_NOT_FOUND', error: 'Task <b>x</b>' } }));
assert.equal(el('rc-diff-summary').innerHTML, 'Could not load the diff', 'error summary');
assert.ok(el('rc-diff-body').innerHTML.includes('Task &lt;b&gt;x&lt;/b&gt;'), 'error message escaped');

// 4. Agent worktree task keeps the worktree diff path.
setWorktrees(AGENT);
await open('task-1', () => ({ status: 200, body: {
  ok: true, branch: 'agent/task-1', hasChanges: false, filesChanged: [], diff: '' } }));
assert.deepEqual(calls, ['/api/pipeline/worktrees/diff?taskId=task-1'], 'worktree url unchanged');
assert.match(el('rc-diff-summary').innerHTML, /agent\/task-1/, 'worktree summary');

// 5. Source rules: no backtick, no dollar-brace, parses.
assert.ok(!consoleScript.includes('`'), 'no backtick in client code');
assert.ok(!consoleScript.includes('${'), 'no dollar-brace in client code');
assert.doesNotThrow(() => new vm.Script(consoleScript), 'console parses');

console.log('activity inspector checks passed');
