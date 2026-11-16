import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInit } from '../dist/commands/init.js';
import { validateMasterPlanTask } from '../dist/scanner/types.js';

console.log('--- Starting nativ validate Tests ---');

const cli = path.resolve('bin', 'cli.js');
const validate = (dir) => {
  const r = spawnSync(process.execPath, [cli, 'validate', dir], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, '') };
};

// Keep init's console output out of the test log
const quietInit = async (dir) => {
  const log = console.log;
  console.log = () => {};
  try {
    await runInit(dir, {});
  } finally {
    console.log = log;
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-validate-test-'));
try {
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"demo","version":"1.0.0"}', 'utf8');
  await quietInit(dir);

  // Test 1: a freshly initialised project validates
  {
    const r = validate(dir);
    assert.equal(r.code, 0, `a fresh project validates:\n${r.out}`);
    assert.match(r.out, /Present: AGENTS\.md/);
    console.log('✔ Test 1: a fresh project passes and its directives are listed');
  }

  // Test 2: no directive files is a warning, not a failure
  {
    for (const f of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) fs.rmSync(path.join(dir, f), { force: true });
    const r = validate(dir);
    assert.equal(r.code, 0, `missing directives must not fail validation:\n${r.out}`);
    assert.match(r.out, /No directive file/);
    assert.doesNotMatch(r.out, /Missing: (CLAUDE|GEMINI)\.md/);
    console.log('✔ Test 2: missing directives warn but do not fail');
  }

  // Test 3: a Claude-only project (no GEMINI.md) is fine
  {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Claude Code directive\n\n@AGENTS.md\n', 'utf8');
    const r = validate(dir);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /GEMINI\.md/);
    assert.doesNotMatch(r.out, /No directive file/);
    console.log('✔ Test 3: a Claude-only project passes without GEMINI.md');
  }

  // Test 4: real contract problems still fail
  {
    fs.writeFileSync(path.join(dir, '.ai', 'db_schema.json'), '{ not json', 'utf8');
    const r = validate(dir);
    assert.equal(r.code, 1, 'a corrupted contract fails validation');
    assert.match(r.out, /Malformed JSON in \.ai\/db_schema\.json/);
    fs.rmSync(path.join(dir, '.ai', 'api_contracts.json'));
    assert.match(validate(dir).out, /Missing: \.ai\/api_contracts\.json/);
    console.log('✔ Test 4: corrupted and missing contracts still fail');
  }

  // Test 5: check commands may not set gate-override names
  {
    const task = (verificationCommand) => ({
      id: 'task-x', title: 'Demo', description: 'Demo task', assignedSubagent: 'qa-tester',
      status: 'pending', dependencies: [], targetFiles: ['tests/demo.mjs'], verificationCommand,
    });
    assert.deepEqual(validateMasterPlanTask(task('node tests/demo.mjs')), []);
    for (const name of ['NATIV_CI_OVERRIDE', 'NATIV_HEADLESS_OVERRIDE']) {
      const errors = validateMasterPlanTask(task(`${name}=1 node tests/demo.mjs`));
      assert.equal(errors.length, 1, `one error for ${name}:\n${errors.join('\n')}`);
      assert.match(errors[0], new RegExp(name));
    }
    console.log('✔ Test 5: check commands may not set gate-override names');
  }

  // Test 6: duplicate task and milestone ids fail; a clean plan does not
  {
    const dupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-validate-dup-'));
    try {
      fs.writeFileSync(path.join(dupDir, 'package.json'), '{"name":"demo","version":"1.0.0"}', 'utf8');
      await quietInit(dupDir);
      const task = (id) => ({ id, title: 'T', description: 'T', status: 'pending', dependencies: [], targetFiles: [] });
      const writePlan = (milestones) => {
        fs.writeFileSync(path.join(dupDir, '.ai', 'master_plan.json'), JSON.stringify({ milestones }), 'utf8');
      };
      const archived = { id: 'm2', tasks: [{ id: 'task-2' }] };
      fs.mkdirSync(path.join(dupDir, '.ai', 'archive'), { recursive: true });
      fs.writeFileSync(path.join(dupDir, '.ai', 'archive', 'm2.json'), JSON.stringify(archived), 'utf8');

      writePlan([
        { id: 'm1', tasks: [task('task-1'), task('task-2')] },
        { id: 'm2', tasks: [], archived: { taskIds: ['task-2'] } },
      ]);
      const taskDup = validate(dupDir);
      assert.equal(taskDup.code, 1, `a task id in live and archived milestones fails:\n${taskDup.out}`);
      assert.match(taskDup.out, /Duplicate task id task-2 in m1, m2/);

      writePlan([{ id: 'm1', tasks: [] }, { id: 'm1', tasks: [] }]);
      const milestoneDup = validate(dupDir);
      assert.equal(milestoneDup.code, 1, `a duplicate milestone id fails:\n${milestoneDup.out}`);
      assert.match(milestoneDup.out, /Duplicate milestone id m1 in position 1, position 2/);

      writePlan([{ id: 'm1', tasks: [task('task-1')] }, { id: 'm2', tasks: [], archived: { taskIds: ['task-2'] } }]);
      const clean = validate(dupDir);
      assert.equal(clean.code, 0, `a plan without duplicates passes:\n${clean.out}`);
      assert.doesNotMatch(clean.out, /Duplicate/);
      console.log('✔ Test 6: duplicate task and milestone ids fail, clean plans pass');
    } finally {
      fs.rmSync(dupDir, { recursive: true, force: true });
    }
  }

  console.log('\n🎉 ALL nativ validate TESTS PASSED!');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
