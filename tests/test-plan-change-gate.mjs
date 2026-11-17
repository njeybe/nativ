import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildDesiredConfig,
  resolveCliInvocation,
} from '../dist/core/setup-assets.js';
import { checkHarnessIntegrity } from '../dist/core/harness-integrity.js';

console.log('--- Starting Plan Change Gate Tests ---');

const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-plan-gate-test-'));
  fs.mkdirSync(path.join(root, '.ai'), { recursive: true });
  return root;
}

function writePlanChanges(root, text) {
  fs.writeFileSync(path.join(root, '.ai', 'plan_changes.json'), text, 'utf8');
}

function change(id, status) {
  return {
    id,
    status,
    taskId: 'task-a',
    change: { notes: 'Clearer notes' },
    reason: 'Needed for the next step',
    createdAt: '2026-11-17T00:00:00.000Z',
  };
}

const planFinding = (root) =>
  checkHarnessIntegrity(root, { templatesDir: path.resolve('templates') })
    .filter((f) => f.id === 'plan-changes' || f.id === 'plan-changes:unreadable');

// Test 1: plan approve and plan reject are denied for every prefix learn approve is denied for
{
  const invocations = [
    resolveCliInvocation({ command: 'nativ', hasBinary: () => true }),
    resolveCliInvocation({ command: 'npx -y @njeybe/nativ' }),
    resolveCliInvocation({ command: 'node C:/tools/nativ/bin/cli.js' }),
  ];
  for (const invocation of invocations) {
    const deny = buildDesiredConfig(invocation).deny;
    const learnPrefixes = deny
      .filter((rule) => rule.endsWith(' learn approve *)'))
      .map((rule) => rule.slice('Bash('.length, -' learn approve *)'.length));
    assert.ok(learnPrefixes.length >= 1, 'learn approve is denied for at least one prefix');
    for (const p of learnPrefixes) {
      assert.ok(deny.includes(`Bash(${p} plan approve *)`), `deny must include plan approve for ${p}`);
      assert.ok(deny.includes(`Bash(${p} plan reject *)`), `deny must include plan reject for ${p}`);
    }
  }
  console.log('✔ Test 1: plan approve and plan reject are denied for every prefix learn approve covers');
}

// Test 2: no plan_changes.json means no plan finding
{
  const root = tempRoot();
  assert.deepEqual(planFinding(root), []);
  cleanup(root);
  console.log('✔ Test 2: no plan_changes.json gives no finding');
}

// Test 3: zero proposed changes give no info finding
{
  const root = tempRoot();
  writePlanChanges(root, JSON.stringify({ version: '1.0.0', changes: [change('pc-1', 'approved')] }));
  assert.deepEqual(planFinding(root), []);
  cleanup(root);
  console.log('✔ Test 3: zero proposed changes give no finding');
}

// Test 4: two proposed changes give the info finding with the count and command
{
  const root = tempRoot();
  writePlanChanges(root, JSON.stringify({
    version: '1.0.0',
    changes: [change('pc-1', 'proposed'), change('pc-2', 'proposed'), change('pc-3', 'rejected')],
  }));
  const findings = planFinding(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].status, 'info');
  assert.equal(findings[0].category, 'plans');
  assert.equal(
    findings[0].message,
    '2 plan changes wait for approval: nativ plan list --status proposed',
  );
  cleanup(root);
  console.log('✔ Test 4: two proposed changes give an info finding with the count');
}

// Test 5: an unreadable file gives a warn finding
{
  const root = tempRoot();
  writePlanChanges(root, '{ "changes": [ this is broken');
  const findings = planFinding(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'plan-changes:unreadable');
  assert.equal(findings[0].status, 'warn');
  assert.match(findings[0].message, /plan_changes\.json cannot be read/);
  cleanup(root);
  console.log('✔ Test 5: an unreadable plan_changes.json gives a warn finding');
}

console.log('\nALL PLAN CHANGE GATE TESTS PASSED');
