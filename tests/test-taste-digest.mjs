// Offline check of the taste-skill worker digests against the digest format contract.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const headings = ['Dials', 'Hard rules', 'Banned patterns', 'Pre-flight', 'Read SKILL.md for'];

function checkDigest(version) {
  const file = path.join(root, 'templates', 'design', 'taste', version, 'DIGEST.md');
  const text = fs.readFileSync(file, 'utf8').replace(/\r/g, '');
  const label = `${version}/DIGEST.md`;

  assert.ok(text.length <= 3800, `${label} is ${text.length} chars, limit 3800`);
  const lines = text.split('\n');
  assert.equal(lines[0], `# taste-skill ${version} digest`, `${label} line 1`);
  const head = lines.slice(1, 4).join(' ');
  for (const part of [`taste-skill ${version}`, '717446e', 'MIT', 'Copyright (c) 2026 Leonxlnx']) {
    assert.ok(head.includes(part), `${label} attribution lacks "${part}"`);
  }

  const found = lines.filter((l) => l.startsWith('## ')).map((l) => l.slice(3).trim());
  assert.deepEqual(found, headings, `${label} headings`);

  assert.ok(!/[^\x00-\x7F]/.test(text), `${label} has non-ASCII characters`);
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(text), `${label} has a hex color`);
  lines.forEach((l, i) => assert.ok(l.length <= 100, `${label} line ${i + 1} exceeds 100 chars`));

  const start = lines.indexOf('## Pre-flight');
  const end = lines.indexOf('## Read SKILL.md for');
  const checks = lines.slice(start + 1, end).filter((l) => /^\s*- \[ \]/.test(l));
  assert.ok(checks.length > 0 && checks.length <= 12, `${label} has ${checks.length} checks`);
}

checkDigest('v1');
checkDigest('v2');
console.log('test-taste-digest: ok');
