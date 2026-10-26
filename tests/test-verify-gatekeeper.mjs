import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { runTaskComplete, runTaskStart } from '../dist/commands/task.js';
import { runVerify } from '../dist/commands/verify.js';
import { executeVerification, verifyBatch } from '../dist/core/verifier.js';

console.log('--- Starting Automated Verification Gatekeeper Tests ---');

/** Runs fn as if from an interactive terminal: the human-only commands refuse to run headless. */
async function asHuman(fn) {
  const before = [process.stdin.isTTY, process.stdout.isTTY];
  process.stdin.isTTY = true;
  process.stdout.isTTY = true;
  try {
    return await fn();
  } finally {
    [process.stdin.isTTY, process.stdout.isTTY] = before;
  }
}

/** Runs fn as if without an interactive terminal: verifies human-only commands refuse to run headless. */
async function asHeadless(fn) {
  const before = [process.stdin.isTTY, process.stdout.isTTY];
  process.stdin.isTTY = false;
  process.stdout.isTTY = false;
  try {
    return await fn();
  } finally {
    [process.stdin.isTTY, process.stdout.isTTY] = before;
  }
}


function createFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-verify-test-'));
  const aiDir = path.join(dir, '.ai');
  fs.mkdirSync(aiDir, { recursive: true });
  fs.writeFileSync(path.join(aiDir, 'context.md'), '# Context\n', 'utf8');

  const plan = {
    projectName: 'verify-fixture',
    overallStatus: 'in_progress',
    activeMilestoneId: 'm1',
    lastUpdated: new Date().toISOString(),
    milestones: [
      {
        id: 'm1',
        name: 'Milestone 1',
        status: 'in_progress',
        tasks: [
          {
            id: 'task-pass',
            title: 'Task Passing',
            assignedSubagent: 'backend',
            dependencies: [],
            targetFiles: ['pass.js'],
            status: 'in_progress',
            verificationCommand: 'node -e "console.log(\\"tests pass\\"); process.exit(0)"',
            notes: '',
          },
          {
            id: 'task-fail',
            title: 'Task Failing',
            assignedSubagent: 'backend',
            dependencies: [],
            targetFiles: ['fail.js'],
            status: 'in_progress',
            verificationCommand: 'node -e "console.error(\\"syntax error: unexpected token\\"); process.exit(42)"',
            notes: '',
          },
          {
            id: 'task-none',
            title: 'Task None',
            assignedSubagent: 'frontend',
            dependencies: [],
            targetFiles: ['none.js'],
            status: 'in_progress',
            verificationCommand: 'none',
            notes: '',
          },
        ],
      },
    ],
  };

  fs.writeFileSync(path.join(aiDir, 'master_plan.json'), JSON.stringify(plan, null, 2), 'utf8');
  return dir;
}

function readPlan(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, '.ai', 'master_plan.json'), 'utf8'));
}

async function runTests() {
  const dir = createFixture();

  // Test 1: Direct executeVerification engine
  {
    const passRes = await executeVerification('node -e "process.exit(0)"', dir);
    assert.equal(passRes.success, true);
    assert.equal(passRes.exitCode, 0);

    const failRes = await executeVerification('node -e "process.exit(5)"', dir);
    assert.equal(failRes.success, false);
    assert.equal(failRes.exitCode, 5);

    const skippedRes = await executeVerification('none', dir);
    assert.equal(skippedRes.success, true);
    assert.equal(skippedRes.skipped, true);

    console.log('  ✔ executeVerification handles success, failure exit codes, and skipped commands');
  }

  // Test 2: Task with valid verification command completes
  {
    process.exitCode = undefined;
    await runTaskComplete('task-pass', dir);
    assert.equal(process.exitCode, undefined);

    const plan = readPlan(dir);
    const t = plan.milestones[0].tasks.find((item) => item.id === 'task-pass');
    assert.equal(t.status, 'completed');
    console.log('  ✔ runTaskComplete verifies task and marks it completed when command exits 0');
  }

  // Test 3: Task with failing verification command is REJECTED
  {
    process.exitCode = undefined;
    await runTaskComplete('task-fail', dir);
    assert.equal(process.exitCode, 1, 'Failing verification must set process.exitCode = 1');

    const plan = readPlan(dir);
    const t = plan.milestones[0].tasks.find((item) => item.id === 'task-fail');
    assert.equal(t.status, 'in_progress', 'Task must NOT be marked completed when verification fails');
    process.exitCode = undefined;
    console.log('  ✔ runTaskComplete rejects completion and preserves in_progress when verification fails');
  }

  // Test 4: Task with failing verification command can be bypassed via skipVerify
  {
    process.exitCode = undefined;
    await asHeadless(() => runTaskComplete('task-fail', dir, { skipVerify: true }));
    assert.equal(process.exitCode, 1, 'headless --no-verify is refused');
    assert.equal(readPlan(dir).milestones[0].tasks.find((item) => item.id === 'task-fail').status, 'in_progress');
    process.exitCode = undefined;
    await asHuman(() => runTaskComplete('task-fail', dir, { skipVerify: true }));
    assert.equal(process.exitCode, undefined);

    const plan = readPlan(dir);
    const t = plan.milestones[0].tasks.find((item) => item.id === 'task-fail');
    assert.equal(t.status, 'completed', 'Task should be completed when skipVerify is true');
    console.log('  ✔ runTaskComplete allows bypass when skipVerify: true (--no-verify)');
  }

  // Test 5: Task with verificationCommand: 'none' completes smoothly
  {
    process.exitCode = undefined;
    await runTaskComplete('task-none', dir);
    assert.equal(process.exitCode, undefined);

    const plan = readPlan(dir);
    const t = plan.milestones[0].tasks.find((item) => item.id === 'task-none');
    assert.equal(t.status, 'completed');
    console.log('  ✔ runTaskComplete completes tasks with verificationCommand: none without error');
  }

  // Test 6: Standalone runVerify CLI output
  {
    process.exitCode = undefined;
    const batch = await runVerify(undefined, dir, { all: true, json: true });
    assert.equal(batch.total, 3);
    assert.equal(batch.passed, 1); // task-pass
    assert.equal(batch.failed, 1); // task-fail
    assert.equal(batch.skipped, 1); // task-none
    assert.equal(process.exitCode, 1, 'Batch with failure must set process.exitCode = 1 in JSON mode');
    process.exitCode = undefined;
    console.log('  ✔ runVerify produces accurate telemetry batch reports');
  }

  // Test 7: MCP Server integration for verify and task_complete
  {
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1')), '..');
    const cliPath = path.join(repoRoot, 'bin', 'cli.js');
    const child = spawn(process.execPath, [cliPath, 'mcp', dir], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test' },
    });

    const pending = new Map();
    let buffer = '';
    let nextId = 1;

    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== undefined && pending.has(msg.id)) {
          const { resolve, reject } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      }
    });

    const request = (method, params = {}) => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    };

    // Initialize MCP handshake
    await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-runner', version: '1.0.0' },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    // Check tools list contains nativ_verify
    const tools = await request('tools/list', {});
    const verifyTool = tools.tools.find((t) => t.name === 'nativ_verify');
    assert.ok(verifyTool, 'nativ_verify tool must exist in tools/list');
    const completeTool = tools.tools.find((t) => t.name === 'nativ_task_complete');
    assert.ok(completeTool.inputSchema.properties.skipVerify, 'task_complete inputSchema must expose skipVerify');

    // Run nativ_verify on task-pass
    const callPass = await request('tools/call', {
      name: 'nativ_verify',
      arguments: { taskId: 'task-pass' },
    });
    assert.equal(callPass.isError, undefined);
    assert.match(callPass.content[0].text, /task-pass/);

    // Run nativ_verify on task-fail
    const callFail = await request('tools/call', {
      name: 'nativ_verify',
      arguments: { taskId: 'task-fail' },
    });
    assert.equal(callFail.isError, true, 'nativ_verify on failing task must return isError: true');
    assert.match(callFail.content[0].text, /syntax error/);

    child.kill();
    console.log('  ✔ MCP server exposes nativ_verify and properly reports tool verification outcomes');
  }

  // Clean-checkout isolation
  {
    const { runTaskVerification } = await import('../dist/core/verifier.js');
    const { execFileSync } = await import('node:child_process');
    const sh = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'ignore' });
    const mkRepo = (config) => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-iso-test-'));
      sh(repo, 'init', '-q');
      sh(repo, 'config', 'user.email', 't@t.t');
      sh(repo, 'config', 'user.name', 't');
      sh(repo, 'config', 'core.autocrlf', process.platform === 'win32' ? 'true' : 'false');
      fs.mkdirSync(path.join(repo, '.nativ'));
      fs.writeFileSync(path.join(repo, '.nativ', 'config.json'), JSON.stringify(config));
      fs.writeFileSync(path.join(repo, '.gitignore'), 'secret.txt\n');
      fs.writeFileSync(path.join(repo, 'read-secret.js'), "require('fs').readFileSync('secret.txt');\n");
      fs.writeFileSync(path.join(repo, 'crlf.js'),
        "if (!require('fs').readFileSync('data.txt', 'utf8').includes('\\r\\n')) process.exit(1);\n");
      fs.writeFileSync(path.join(repo, 'data.txt'), 'a\r\nb\r\n');
      fs.writeFileSync(path.join(repo, 'secret.txt'), 'x');
      sh(repo, 'add', '-A');
      sh(repo, 'commit', '-q', '-m', 'init');
      return repo;
    };
    const task = (cmd) => ({ id: 't', title: 't', verificationCommand: cmd, targetFiles: [] });
    const trees = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('nativ-verify-')).length;
    const before = trees();

    const block = mkRepo({ profile: 'enterprise' });
    const none = await runTaskVerification(task('node read-secret.js'), { cwd: block, isolation: 'none' });
    assert.equal(none.success, true);
    assert.equal(none.isolation, 'none');
    const blocked = await runTaskVerification(task('node read-secret.js'), { cwd: block });
    assert.equal(blocked.success, false, 'a gitignored file must be missing in the clean copy');
    assert.equal(blocked.isolation, 'clean');
    assert.match(blocked.error, /Passes only on this machine/);
    assert.match(blocked.error, /block/);

    const warn = mkRepo({ profile: 'enterprise', verifyIsolationFailure: 'warn' });
    const warned = await runTaskVerification(task('node read-secret.js'), { cwd: warn });
    assert.equal(warned.success, true);
    assert.ok(warned.warnings.some((w) => /Passes only on this machine/.test(w)));

    const good = await runTaskVerification(task('node -e "process.exit(0)"'), { cwd: warn });
    assert.equal(good.success, true);
    assert.equal(good.isolation, 'clean');
    assert.equal(good.warnings, undefined);

    const skipped = await runTaskVerification(task('none'), { cwd: warn });
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.isolation, 'none');

    if (process.platform === 'win32') {
      const crlfNone = await runTaskVerification(task('node crlf.js'), { cwd: block, isolation: 'none' });
      assert.equal(crlfNone.success, true);
      const crlf = await runTaskVerification(task('node crlf.js'), { cwd: block });
      assert.equal(crlf.success, false, 'a CRLF assertion must fail in the clean copy');
    }

    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-iso-plain-'));
    const fallback = await runTaskVerification(task('node -e "process.exit(0)"'), {
      cwd: plain, isolation: 'clean',
    });
    assert.equal(fallback.success, true);
    assert.equal(fallback.isolation, 'none');
    assert.match(fallback.warnings[0], /Clean isolation unavailable/);

    assert.equal(trees(), before, 'clean trees must be disposed');
    for (const d of [block, warn, plain]) fs.rmSync(d, { recursive: true, force: true });
    console.log('  ✔ clean isolation fails on ignored files and CRLF, warns or blocks, falls back, disposes');
  }

  // Isolation flags: override reaches verifyBatch; --isolation none is gated under block
  {
    const { execFileSync } = await import('node:child_process');
    const { parseIsolation } = await import('../dist/commands/verify.js');
    assert.equal(parseIsolation({}), undefined);
    assert.equal(parseIsolation({ clean: true }), 'clean');
    assert.equal(parseIsolation({ isolation: 'none' }), 'none');
    assert.throws(() => parseIsolation({ isolation: 'bogus' }), /none or clean/);

    const sh = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'ignore' });
    const mk = (config) => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-flag-test-'));
      sh(repo, 'init', '-q');
      sh(repo, 'config', 'user.email', 't@t.t');
      sh(repo, 'config', 'user.name', 't');
      fs.mkdirSync(path.join(repo, '.nativ'));
      fs.writeFileSync(path.join(repo, '.nativ', 'config.json'), JSON.stringify(config));
      fs.writeFileSync(path.join(repo, '.gitignore'), 'secret.txt\n.ai/\n');
      fs.writeFileSync(path.join(repo, 'read-secret.js'), "require('fs').readFileSync('secret.txt');\n");
      fs.writeFileSync(path.join(repo, 'secret.txt'), 'x');
      sh(repo, 'add', '-A');
      sh(repo, 'commit', '-q', '-m', 'init');
      fs.mkdirSync(path.join(repo, '.ai'));
      const plan = {
        projectName: 'flags', overallStatus: 'in_progress', activeMilestoneId: 'm1',
        lastUpdated: new Date().toISOString(),
        milestones: [{ id: 'm1', name: 'M', status: 'in_progress', tasks: [{
          id: 'task-s', title: 'S', assignedSubagent: 'backend', dependencies: [], targetFiles: [],
          status: 'in_progress', verificationCommand: 'node read-secret.js', notes: '',
        }] }],
      };
      fs.writeFileSync(path.join(repo, '.ai', 'master_plan.json'), JSON.stringify(plan));
      return repo;
    };

    const warn = mk({ profile: 'enterprise', verifyIsolationFailure: 'warn' });
    const viaNone = await verifyBatch(warn, { taskId: 'task-s', isolation: 'none' });
    assert.equal(viaNone.tasks[0].result.isolation, 'none');
    assert.equal(viaNone.tasks[0].result.warnings, undefined);
    const viaProfile = await verifyBatch(warn, { taskId: 'task-s' });
    assert.equal(viaProfile.tasks[0].result.isolation, 'clean');
    assert.ok(viaProfile.tasks[0].result.warnings.some((w) => /Passes only on this machine/.test(w)));

    const block = mk({ profile: 'enterprise' });
    process.exitCode = undefined;
    await asHeadless(() => runTaskComplete('task-s', block, { isolation: 'none' }));
    assert.equal(process.exitCode, 1, '--isolation none must be refused headless under block');
    assert.equal(readPlan(block).milestones[0].tasks[0].status, 'in_progress');
    process.exitCode = undefined;
    await asHuman(() => runTaskComplete('task-s', block, { isolation: 'none' }));
    assert.equal(readPlan(block).milestones[0].tasks[0].status, 'completed');
    process.exitCode = undefined;

    for (const d of [warn, block]) fs.rmSync(d, { recursive: true, force: true });
    console.log('  ✔ isolation flag overrides the profile, reports warnings, and is gated under block');
  }

  // Skipped-check policy
  {
    const { execFileSync } = await import('node:child_process');
    const mkSkip = (profile, task) => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-skip-test-'));
      execFileSync('git', ['init', '-q'], { cwd: repo });
      fs.mkdirSync(path.join(repo, '.nativ'));
      fs.writeFileSync(path.join(repo, '.nativ', 'config.json'), JSON.stringify({ profile }));
      fs.mkdirSync(path.join(repo, '.ai'));
      const t = { id: 'task-k', title: 'K', assignedSubagent: 'backend', dependencies: [],
        targetFiles: [], status: 'in_progress', notes: '', verificationCommand: 'skip', ...task };
      const plan = { projectName: 'skip', overallStatus: 'in_progress', activeMilestoneId: 'm1',
        lastUpdated: new Date().toISOString(),
        milestones: [{ id: 'm1', name: 'M', status: 'in_progress', tasks: [t] }] };
      fs.writeFileSync(path.join(repo, '.ai', 'master_plan.json'), JSON.stringify(plan));
      return repo;
    };
    const statusOf = (r) => JSON.parse(fs.readFileSync(path.join(r, '.ai', 'master_plan.json'), 'utf8'))
      .milestones[0].tasks[0].status;
    const cases = [
      ['enterprise', { verificationKind: 'unit' }, 1, 'in_progress'],
      ['enterprise', {}, undefined, 'completed'],
      ['enterprise', { verificationKind: 'manual', notes: 'checked by hand' }, undefined, 'completed'],
      ['enterprise', { verificationKind: 'manual' }, 1, 'in_progress'],
      ['solo', { verificationKind: 'unit' }, undefined, 'completed'],
      ['prototype', { verificationKind: 'unit' }, undefined, 'completed'],
    ];
    for (const [profile, task, code, status] of cases) {
      const repo = mkSkip(profile, task);
      process.exitCode = undefined;
      await runTaskComplete('task-k', repo);
      assert.equal(process.exitCode, code, `${profile} ${JSON.stringify(task)} exit code`);
      assert.equal(statusOf(repo), status, `${profile} ${JSON.stringify(task)} status`);
      process.exitCode = undefined;
      if (profile === 'enterprise' && task.verificationKind === 'unit') {
        await runVerify('task-k', repo);
        assert.equal(process.exitCode, undefined, 'verify never fails on a skip');
      }
      fs.rmSync(repo, { recursive: true, force: true });
    }
    console.log('  ✔ skipped-check policy follows kind, notes and profile');
  }

  // Cleanup
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}

  console.log('\n✔ All Automated Verification Gatekeeper tests PASSED successfully!\n');
}

runTests().catch((err) => {
  console.error('\n✖ Test suite failed:', err);
  process.exit(1);
});
