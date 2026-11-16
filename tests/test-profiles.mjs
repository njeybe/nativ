import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProfile, setProfile, resolveActiveProfileSettings, PROFILE_DEFAULTS } from '../dist/core/profiles.js';
import { loadEnforcementMode } from '../dist/core/enforcement.js';
import { refuseHeadless, hasHeadlessOverride } from '../dist/core/human-gate.js';
import { TestIntegrityGuard } from '../dist/governor/test-integrity.js';

console.log('--- Starting Adaptive Ceremony Profiles Tests ---');

function createTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-profile-test-'));
  fs.mkdirSync(path.join(dir, '.nativ'), { recursive: true });
  return dir;
}

const dir = createTempProject();

// Test 1: Default profile is enterprise
assert.equal(loadProfile(dir), 'enterprise', 'default profile is enterprise');
assert.equal(loadEnforcementMode(dir), 'warn', 'default enforcement in enterprise is warn');

// Test 2: Switch to prototype profile
const protoSettings = setProfile(dir, 'prototype');
assert.equal(protoSettings.profile, 'prototype');
assert.equal(protoSettings.enforcement, 'off');
assert.equal(protoSettings.governorMode, 'auto_adopt');
assert.equal(protoSettings.testIntegrity, 'off');

assert.equal(loadProfile(dir), 'prototype');
assert.equal(loadEnforcementMode(dir), 'off', 'prototype mode relaxes enforcement to off');

// Test 3: TestIntegrityGuard respects prototype mode / testIntegrity: off
const integrityReport = TestIntegrityGuard.evaluate(dir, 'task-01');
assert.equal(integrityReport.approved, true, 'test integrity approved when profile is prototype');
assert.match(integrityReport.message, /Test integrity check disabled/);

// Test 4: Switch to solo profile
const soloSettings = setProfile(dir, 'solo');
assert.equal(soloSettings.profile, 'solo');
assert.equal(soloSettings.enforcement, 'warn');
assert.equal(soloSettings.governorMode, 'auto_adopt');
assert.equal(loadEnforcementMode(dir), 'warn', 'solo mode uses advisory warn enforcement');

// Test 5: CI Headless overrides
// CI=true no longer opens the gate; only the explicit override does
const origCI = process.env.CI;
const origOverride = process.env.NATIV_HEADLESS_OVERRIDE;
try {
  delete process.env.NATIV_HEADLESS_OVERRIDE;
  delete process.env.NATIV_CI_OVERRIDE;
  process.env.CI = 'true';
  assert.equal(hasHeadlessOverride(), false, 'CI=true does not open the gate');
  process.env.NATIV_HEADLESS_OVERRIDE = '1';
  assert.equal(hasHeadlessOverride(), true, 'explicit override opens the gate');
  assert.equal(refuseHeadless('nativ task complete --no-verify'), false, 'override skips the refusal');
} finally {
  if (origCI !== undefined) process.env.CI = origCI;
  else delete process.env.CI;
  if (origOverride !== undefined) process.env.NATIV_HEADLESS_OVERRIDE = origOverride;
  else delete process.env.NATIV_HEADLESS_OVERRIDE;
}

{
  const { loadVerifySettings, resolveActiveProfileSettings: rs } = await import('../dist/core/profiles.js');
  const s = rs(dir);
  assert.equal(s.verifyIsolation, 'clean');
  assert.equal(s.skippedCheck, 'warn');
  fs.writeFileSync(path.join(dir, '.nativ', 'config.json'), JSON.stringify({
    profile: 'solo', skippedCheck: 'block', verifyIsolation: 'bogus',
    verifyEnv: ['FOO', 'CI', 'NATIV_X', 'GITLAB_CI'],
  }));
  const o = rs(dir);
  assert.equal(o.skippedCheck, 'block');
  assert.equal(o.verifyIsolation, 'clean', 'invalid ignored');
  const v = loadVerifySettings(dir);
  assert.deepEqual(v.verifyEnv, ['FOO']);
  assert.deepEqual(v.verifyLinks, ['node_modules', '.venv', 'venv']);
}
console.log('✔ Test 1: Default enterprise profile');
console.log('✔ Test 2: Prototype profile relaxation');
console.log('✔ Test 3: Test integrity bypass in prototype');
console.log('✔ Test 4: Solo profile configuration');
console.log('✔ Test 5: Headless execution in CI');
console.log('--- All Adaptive Profiles Tests Passed ---');
