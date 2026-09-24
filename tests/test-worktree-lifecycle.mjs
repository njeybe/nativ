import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

console.log('--- Starting Worktree Lifecycle & MCP Hardening Verification ---');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'bin', 'cli.js');
const execFileAsync = promisify(execFile);
const tempDirs = [];

function createGitFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-wt-'));
  tempDirs.push(dir);

  // Initialize git repo
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test Runner"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@nativ.dev"', { cwd: dir, stdio: 'ignore' });

  // Create initial commit on main branch
  fs.writeFileSync(path.join(dir, 'README.md'), '# Fixture\n', 'utf8');
  fs.writeFileSync(path.join(dir, '.gitignore'), ".ai/\n.worktrees/\n.nativ/\n", 'utf8');
  execSync('git add . && git commit -m "initial commit"', { cwd: dir, stdio: 'ignore' });

  // Scaffold .ai/
  const aiDir = path.join(dir, '.ai');
  fs.mkdirSync(aiDir, { recursive: true });
  fs.writeFileSync(path.join(aiDir, 'context.md'), '# Context\n', 'utf8');
  fs.writeFileSync(path.join(aiDir, 'db_schema.json'), JSON.stringify({ tables: [] }, null, 2), 'utf8');

  const plan = {
    version: '1.0.0',
    projectName: 'worktree-fixture',
    lastUpdated: new Date().toISOString(),
    overallStatus: 'in_progress',
    activeMilestoneId: 'm1',
    milestones: [
      {
        id: 'm1',
        name: 'Sprint 1',
        status: 'in_progress',
        tasks: [
          {
            id: 'task-wt-1',
            title: 'Feature Worktree',
            description: 'Worktree test',
            assignedSubagent: 'backend',
            dependencies: [],
            targetFiles: [],
            status: 'in_progress',
            verificationCommand: '',
            notes: '',
          },
          {
            id: 'task-wt-2',
            title: 'Completed Feature',
            description: 'Worktree test completed',
            assignedSubagent: 'backend',
            dependencies: [],
            targetFiles: [],
            status: 'completed',
            verificationCommand: '',
            notes: '',
          },
          {
            id: 'task-wt-3',
            title: 'Completed Feature With Uncommitted Work',
            description: 'Agent verified its work but never committed it',
            assignedSubagent: 'backend',
            dependencies: [],
            targetFiles: [],
            status: 'completed',
            verificationCommand: '',
            notes: '',
          },
        ],
      },
    ],
  };

  fs.writeFileSync(path.join(aiDir, 'master_plan.json'), JSON.stringify(plan, null, 2), 'utf8');
  return dir;
}

async function cli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], { timeout: 60000 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
  }
}

function startMcp(projectDir) {
  const child = spawn(process.execPath, [cliPath, 'mcp', projectDir], { stdio: ['pipe', 'pipe', 'pipe'] });
  let nextId = 1;
  const pending = new Map();
  let buffer = '';

  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch {
        // ignore
      }
    }
  });

  return {
    child,
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    close() {
      child.stdin.end();
      child.kill();
    },
  };
}

try {
  const dir = createGitFixture();

  // Test 1: Worktree Creation with .ai Contract Accessibility
  console.log('1. Testing Worktree Creation & Contract Mount...');
  const createRes = await cli(['worktree', 'create', 'task-wt-1', dir, '--json']);
  assert.equal(createRes.code, 0, `worktree create failed: ${createRes.stderr}`);
  const createData = JSON.parse(createRes.stdout);
  assert.equal(createData.success, true);
  assert.equal(createData.branch, 'agent/task-task-wt-1');
  assert.ok(fs.existsSync(createData.worktreeDir), 'Worktree directory should exist');

  // Verify that commands run inside the worktree directory resolve .ai/ correctly
  const listFromInside = await cli(['task', 'list', createData.worktreeDir, '--json']);
  assert.equal(listFromInside.code, 0, 'task list inside worktree should find master_plan.json');
  const tasks = JSON.parse(listFromInside.stdout);
  assert.ok(tasks.length >= 2, 'Should find project tasks from inside worktree');
  console.log('✔ Worktree created and .ai contracts successfully resolved from within worktree.');

  // Test 2: Safe Merge Gatekeeper (Reject Uncompleted Task)
  console.log('2. Testing Safe Merge Gatekeeper Rejection for in_progress Task...');
  const mergeReject = await cli(['worktree', 'merge', 'task-wt-1', dir, '--json']);
  assert.equal(mergeReject.code, 1, 'Merge of in_progress task must be rejected');
  const rejectData = JSON.parse(mergeReject.stdout);
  assert.equal(rejectData.success, false);
  assert.ok(rejectData.error.includes('GATEKEEPER REJECTED'), 'Expected GATEKEEPER REJECTED error');
  console.log('✔ Safe Merge Gatekeeper properly rejected uncompleted task.');

  // Test 3: Worktree List Output
  console.log('3. Testing Worktree List with JSON output...');
  const listRes = await cli(['worktree', 'list', dir, '--json']);
  assert.equal(listRes.code, 0);
  const wtList = JSON.parse(listRes.stdout);
  assert.ok(Array.isArray(wtList), 'Expected worktree array');
  const agentWt = wtList.find((w) => w.isAgentWorktree);
  assert.ok(agentWt, 'Expected agent worktree in list');
  console.log('✔ Worktree list reports active agent worktrees.');

  // Test 4: Safe Merge of Completed Task
  console.log('4. Testing Successful Worktree Merge for Completed Task...');
  // Create worktree for task-wt-2 (which is marked 'completed' in fixture plan)
  await cli(['worktree', 'create', 'task-wt-2', dir, '--json']);
  // Add a commit in the worktree
  const wt2Dir = path.join(dir, '.worktrees', 'task-task-wt-2');
  fs.writeFileSync(path.join(wt2Dir, 'feature.txt'), 'done\n', 'utf8');
  execSync('git add . && git commit -m "completed feature"', { cwd: wt2Dir, stdio: 'ignore' });

  const mergeSuccess = await cli(['worktree', 'merge', 'task-wt-2', dir, '--json']);
  assert.equal(mergeSuccess.code, 0, `Merge failed: ${mergeSuccess.stderr}`);
  const mergeData = JSON.parse(mergeSuccess.stdout);
  assert.equal(mergeData.success, true);
  assert.equal(mergeData.merged, true);
  assert.ok(!fs.existsSync(wt2Dir), 'Worktree directory should be cleaned up after merge');
  assert.ok(fs.existsSync(path.join(dir, 'feature.txt')), 'Feature file should be merged into base branch');
  console.log('✔ Completed task worktree cleanly merged and cleaned up.');

  // Test 4b: Merge never discards work the agent left uncommitted
  console.log('4b. Testing Merge Preserves Uncommitted Agent Work...');
  await cli(['worktree', 'create', 'task-wt-3', dir, '--json']);
  const wt3Dir = path.join(dir, '.worktrees', 'task-task-wt-3');
  fs.writeFileSync(path.join(wt3Dir, 'uncommitted.txt'), 'kept\n', 'utf8');
  const mergeDirty = await cli(['worktree', 'merge', 'task-wt-3', dir, '--json']);
  assert.equal(mergeDirty.code, 0, `Merge failed: ${mergeDirty.stdout}${mergeDirty.stderr}`);
  const dirtyData = JSON.parse(mergeDirty.stdout);
  assert.equal(dirtyData.success, true);
  assert.equal(dirtyData.committedPendingWork, true, 'uncommitted work must be committed on the agent branch first');
  // core.autocrlf may rewrite line endings on checkout; compare content, not EOL style.
  assert.equal(fs.readFileSync(path.join(dir, 'uncommitted.txt'), 'utf8').replace(/\r\n/g, '\n'), 'kept\n', 'uncommitted work must reach the base branch');
  assert.ok(!fs.existsSync(wt3Dir), 'worktree is removed only after the merge succeeded');
  console.log('✔ Uncommitted agent work was committed, merged and kept.');

  // Test 4c: A worktree folder deleted by hand can be recreated, keeping the branch's commits
  console.log('4c. Testing recovery after a worktree folder is deleted manually...');
  await cli(['worktree', 'create', 'task-wt-4', dir, '--json']);
  const wt4Dir = path.join(dir, '.worktrees', 'task-task-wt-4');
  fs.writeFileSync(path.join(wt4Dir, 'progress.txt'), 'half done\n', 'utf8');
  execSync('git add progress.txt && git commit -m "agent progress"', { cwd: wt4Dir, stdio: 'ignore' });
  // What a careful manual cleanup does: drop the contract mount, then the folder. Git metadata and the branch remain.
  fs.unlinkSync(path.join(wt4Dir, '.ai'));
  fs.rmSync(wt4Dir, { recursive: true, force: true });
  const recreate = await cli(['worktree', 'create', 'task-wt-4', dir, '--json']);
  assert.equal(recreate.code, 0, `recreate failed: ${recreate.stdout}${recreate.stderr}`);
  assert.ok(fs.existsSync(path.join(wt4Dir, 'progress.txt')), 'the surviving branch is reused, so earlier commits come back');
  assert.ok(fs.existsSync(path.join(wt4Dir, '.ai', 'master_plan.json')), 'contracts are mounted again');
  console.log('✔ A manually deleted worktree was recreated on its surviving branch with commits intact.');

  // Test 4d: Leftover folders that git no longer tracks
  console.log('4d. Testing leftover (untracked) worktree folders...');
  const zombie = path.join(dir, '.worktrees', 'task-task-zombie');
  fs.mkdirSync(zombie, { recursive: true });
  const zombieRes = await cli(['worktree', 'create', 'task-zombie', dir, '--json']);
  assert.equal(zombieRes.code, 0, `an empty leftover folder must not block create: ${zombieRes.stdout}`);
  assert.ok(fs.existsSync(path.join(zombie, '.git')), 'the leftover shell is replaced by a real worktree');
  const keep = path.join(dir, '.worktrees', 'task-task-keep');
  fs.mkdirSync(keep, { recursive: true });
  fs.writeFileSync(path.join(keep, 'notes.txt'), 'someone\'s work\n', 'utf8');
  const keepRes = await cli(['worktree', 'create', 'task-keep', dir, '--json']);
  assert.equal(keepRes.code, 1, 'a leftover folder with files is never deleted to make room');
  assert.match(JSON.parse(keepRes.stdout).error, /still contains files/);
  assert.ok(fs.existsSync(path.join(keep, 'notes.txt')), 'the files are left untouched');
  console.log('✔ Empty leftovers are cleared; leftovers holding files are refused and preserved.');

  // Test 4e: Non-agent worktrees other than the main checkout are labelled as linked
  console.log('4e. Testing worktree list labels...');
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-wt-external-'));
  tempDirs.push(external);
  fs.rmSync(external, { recursive: true, force: true });
  execSync(`git worktree add --detach "${external}"`, { cwd: dir, stdio: 'ignore' });
  const listText = await cli(['worktree', 'list', dir]);
  assert.equal((listText.stdout.match(/\[main\]/g) || []).length, 1, `only the main checkout is [main]:\n${listText.stdout}`);
  assert.match(listText.stdout, /\[linked\]/);
  execSync(`git worktree remove --force "${external}"`, { cwd: dir, stdio: 'ignore' });
  console.log('✔ Only the main checkout is labelled [main]; other worktrees show as [linked].');

  // Test 5: Worktree Removal / Cleanup (Discard without merging)
  console.log('5. Testing Worktree Removal / Abort without merging...');
  await cli(['worktree', 'create', 'task-abort', dir, '--json']);
  const abortDir = path.join(dir, '.worktrees', 'task-task-abort');
  assert.ok(fs.existsSync(abortDir));

  const removeRes = await cli(['worktree', 'remove', 'task-abort', dir, '--json']);
  assert.equal(removeRes.code, 0);
  const removeData = JSON.parse(removeRes.stdout);
  assert.equal(removeData.success, true);
  assert.equal(removeData.removed, true);
  assert.ok(!fs.existsSync(abortDir), 'Aborted worktree directory should be removed');
  console.log('✔ Worktree successfully discarded without merging.');

  // Test 6: MCP Worktree Dual-Tool Verification
  console.log('6. Testing MCP Server Worktree Tools...');
  const mcp = startMcp(dir);
  try {
    // Initialize MCP
    await mcp.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    });

    // Call nativ_worktree_create
    const mcpCreate = await mcp.request('tools/call', {
      name: 'nativ_worktree_create',
      arguments: { taskId: 'task-mcp' },
    });
    assert.ok(mcpCreate.result, 'Expected result from MCP worktree_create');
    const createOut = JSON.parse(mcpCreate.result.content[0].text);
    assert.equal(createOut.success, true);

    // Call nativ_worktree_list
    const mcpList = await mcp.request('tools/call', {
      name: 'nativ_worktree_list',
      arguments: {},
    });
    const listOut = JSON.parse(mcpList.result.content[0].text);
    assert.ok(listOut.some((w) => w.branch.includes('task-mcp')), 'Expected task-mcp in MCP worktree list');

    // Call nativ_worktree_remove
    const mcpRemove = await mcp.request('tools/call', {
      name: 'nativ_worktree_remove',
      arguments: { taskId: 'task-mcp', force: true },
    });
    const removeOut = JSON.parse(mcpRemove.result.content[0].text);
    assert.equal(removeOut.success, true);
    console.log('✔ MCP worktree tools (create, list, remove) verified over stdio.');
  } finally {
    mcp.close();
  }

  console.log('\n🎉 ALL WORKTREE LIFECYCLE & MCP TESTS PASSED!');
} finally {
  for (const d of tempDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
