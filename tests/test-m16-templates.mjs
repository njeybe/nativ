// Checks that the M16 guardrail wording exists in the templates.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

console.log('--- Starting M16 Template Wording Tests ---');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8').replace(/\r\n/g, '\n');
const lineWith = (text, needle) => text.split('\n').find((l) => l.includes(needle)) ?? '';

const agents = read('templates/AGENTS.md');
const verifier = read('templates/claude-agents/verifier.md');
const architect = read('templates/claude-agents/architect.md');
const qa = read('templates/dot-ai/subagents/qa-tester.md');

// Test 1: AGENTS.md guards required settings and tracked-file tests
{
  assert.ok(agents.includes('Required settings fail loudly, naming the variable.'), 'fail-loudly rule');
  assert.ok(agents.includes('`nativ-allow-fallback`'), 'fallback marker named');
  assert.ok(agents.includes('git-tracked files'), 'tests read tracked files only');
  assert.ok(agents.includes('never spawn `nativ`'), 'tests do not spawn nativ');
  console.log('✔ Test 1: AGENTS.md has the fallback and tracked-file guardrails');
}

// Test 2: verifier checklist, weak verification and scope grouping
{
  for (const token of ["?? ''", "|| ''", '?? null']) {
    assert.ok(verifier.includes(token), `verifier flags ${token}`);
  }
  assert.ok(verifier.includes('Weak verification'), 'step 3a reports weak verification');
  const scope = lineWith(verifier, '**Contract and scope**');
  for (const word of ['checklist', 'Weak verification', 'config']) {
    assert.ok(scope.toLowerCase().includes(word.toLowerCase()), `Contract and scope covers ${word}`);
  }
  console.log('✔ Test 2: verifier flags empty fallbacks and reports weak verification');
}

// Test 3: architect gives a real check for every verificationKind
{
  const kinds = ['unit', 'integration', 'static-config', 'docs', 'probe', 'manual'];
  for (const kind of kinds) {
    assert.ok(architect.includes(`\`${kind}\`:`), `architect describes the ${kind} kind`);
  }
  assert.ok(lineWith(architect, '`docs`:').includes('nativ check docs'), 'docs uses nativ check docs');
  assert.ok(lineWith(architect, '`manual`:').includes('notes'), 'manual needs notes');
  const speed = lineWith(architect, '`unit`:') + lineWith(architect, '`integration`:');
  assert.ok(speed.includes('under 5s'), 'the 5s rule covers unit and integration');
  assert.ok(!lineWith(architect, '`probe`:').includes('under 5s'), 'the 5s rule is not on probe');
  console.log('✔ Test 3: architect describes each verificationKind and the 5s rule');
}

// Test 4: qa-tester reads only tracked files
{
  assert.ok(qa.includes('Tests read only files git tracks'), 'qa-tester tracked-file rule');
  assert.ok(qa.includes('Tests never spawn `nativ`'), 'qa-tester no nativ spawn');
  console.log('✔ Test 4: qa-tester template has the tracked-file rule');
}

console.log('All M16 template wording tests passed.');
