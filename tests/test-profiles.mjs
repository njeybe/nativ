import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProfile, setProfile, resolveActiveProfileSettings, PROFILE_DEFAULTS } from '../dist/core/profiles.js';
import { loadEnforcementMode } from '../dist/core/enforcement.js';
import { refuseHeadless, isCiEnvironment } from '../dist/core/human-gate.js';
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
const origCI = process.env.CI;
try {
  process.env.CI = 'true';
  assert.equal(isCiEnvironment(), true, 'detects CI=true');
  assert.equal(refuseHeadless('nativ task complete --no-verify'), false, 'does not refuse headless in CI');
} finally {
  if (origCI !== undefined) process.env.CI = origCI;
  else delete process.env.CI;
}

console.log('✔ Test 1: Default enterprise profile');
console.log('✔ Test 2: Prototype profile relaxation');
console.log('✔ Test 3: Test integrity bypass in prototype');
console.log('✔ Test 4: Solo profile configuration');
console.log('✔ Test 5: Headless execution in CI');
console.log('--- All Adaptive Profiles Tests Passed ---');
