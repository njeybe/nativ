import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInit } from '../dist/commands/init.js';

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

  console.log('\n🎉 ALL nativ validate TESTS PASSED!');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
