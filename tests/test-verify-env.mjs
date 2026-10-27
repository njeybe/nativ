import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeVerification } from '../dist/core/verifier/executor.js';
import { buildVerifyEnv } from '../dist/core/verifier/verify-env.js';
import { isCiEnvironment } from '../dist/core/human-gate.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-venv-'));
const q = (s) => JSON.stringify(s);

// buildVerifyEnv allowlist
{
  const src = { Path: 'p', HOME: 'h', SECRET_TOKEN: 'x', CI: 'false', NATIV_CI_OVERRIDE: '1', MYVAR: 'v' };
  const env = buildVerifyEnv(['MYVAR'], src);
  assert.equal(env.Path, 'p');
  assert.equal(env.HOME, 'h');
  assert.equal(env.MYVAR, 'v');
  assert.equal(env.SECRET_TOKEN, undefined);
  assert.equal(env.NATIV_CI_OVERRIDE, undefined);
  assert.equal(env.CI, 'true');
  assert.equal(env.NATIV_VERIFY_SANDBOX, '1');
  assert.equal(buildVerifyEnv([], { NATIV_HEADLESS_OVERRIDE: '1' }).NATIV_HEADLESS_OVERRIDE, undefined);
}

// isCiEnvironment under the sandbox marker
{
  const saved = { ...process.env };
  const keys = ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'NATIV_CI_OVERRIDE', 'NATIV_HEADLESS_OVERRIDE'];
  for (const k of keys) delete process.env[k];
  process.env.CI = 'true';
  assert.equal(isCiEnvironment(), true);
  process.env.NATIV_VERIFY_SANDBOX = '1';
  assert.equal(isCiEnvironment(), false);
  process.env.GITHUB_ACTIONS = 'true';
  process.env.GITLAB_CI = 'true';
  assert.equal(isCiEnvironment(), false);
  process.env.NATIV_HEADLESS_OVERRIDE = '1';
  assert.equal(isCiEnvironment(), true);
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
}

// Default env keeps the parent env and adds the marker; skip is unchanged
{
  process.env.NATIV_TEST_PARENT = 'yes';
  const r = await executeVerification(
    `node -e ${q('process.stdout.write(process.env.NATIV_TEST_PARENT+process.env.NATIV_VERIFY_SANDBOX)')}`,
    tmp,
  );
  assert.equal(r.success, true);
  assert.equal(r.stdout, 'yes1');
  const s = await executeVerification('skip', tmp);
  assert.equal(s.skipped, true);
}

// Explicit env option
{
  const r = await executeVerification(
    `node -e ${q('process.stdout.write(String(process.env.NATIV_TEST_PARENT)+process.env.CI)')}`,
    tmp, 20_000, { env: buildVerifyEnv() },
  );
  assert.equal(r.stdout, 'undefinedtrue');
}

// Timeout kills the tree: a grandchild's open file can be deleted afterwards
{
  const held = path.join(tmp, 'held.txt');
  const child = path.join(tmp, 'child.js');
  const parent = path.join(tmp, 'parent.js');
  fs.writeFileSync(child, `require('fs').openSync(${q(held)}, 'w'); setTimeout(() => {}, 60000);`);
  fs.writeFileSync(
    parent,
    `require('child_process').spawn(process.execPath, [${q(child)}], { stdio: 'ignore' }); `
    + 'setTimeout(() => {}, 60000);',
  );
  const r = await executeVerification(`node ${q(parent)}`, tmp, 1500);
  assert.equal(r.success, false);
  assert.match(r.error, /timed out/);
  let deleted = false;
  for (let i = 0; i < 20 && !deleted; i++) {
    try { fs.unlinkSync(held); deleted = true; } catch { await new Promise((x) => setTimeout(x, 200)); }
  }
  assert.ok(deleted, 'file held by grandchild should be deletable after timeout');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('verify-env tests passed');
