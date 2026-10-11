// Offline check that the vendored taste-skill bundle matches its pinned hashes.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const taste = path.join(root, 'templates', 'design', 'taste');
const commit = '717446e07a78d4e6d7918b1fde1a263378eebac9';

const pinned = {
  'LICENSE': '4575a543ab88dad12ccea7d97e563d0bce5b448b06072e65d3264497dad326df',
  'v1/SKILL.md': '033d45af1ed23832730642f95f40ab49db7fb5222848489a6c5656144bfc6dae',
  'v2/SKILL.md': 'aa194351b246b8b4799099d4ed7b033d29eab6e6e3d58d8d2172978be7b3ec89',
};
const optional = ['v1/DIGEST.md', 'v2/DIGEST.md'];

const sha256Lf = (file) => {
  const text = fs.readFileSync(file, 'utf8').replace(/\r/g, '');
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
};

for (const [rel, hash] of Object.entries(pinned)) {
  const file = path.join(taste, ...rel.split('/'));
  assert.ok(fs.existsSync(file), `missing ${rel}`);
  assert.equal(sha256Lf(file), hash, `${rel} does not match the pinned sha256`);
}

const source = fs.readFileSync(path.join(taste, 'SOURCE.md'), 'utf8');
assert.ok(source.includes('https://github.com/Leonxlnx/taste-skill'), 'SOURCE.md misses the URL');
assert.ok(source.includes(commit), 'SOURCE.md misses the pinned commit');
assert.ok(source.includes('2026-10-09'), 'SOURCE.md misses the commit date');
assert.ok(source.includes('MIT'), 'SOURCE.md misses the MIT license name');
assert.ok(source.includes('Copyright (c) 2026 Leonxlnx'), 'SOURCE.md misses the copyright line');
for (const hash of Object.values(pinned)) {
  assert.ok(source.includes(hash), `SOURCE.md misses hash ${hash}`);
}

const allowed = new Set([...Object.keys(pinned), ...optional, 'SOURCE.md']);
const walk = (dir, prefix = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const rel = prefix ? `${prefix}/${e.name}` : e.name;
  return e.isDirectory() ? walk(path.join(dir, e.name), rel) : [rel];
});
for (const rel of walk(taste)) {
  assert.ok(allowed.has(rel), `unexpected file in taste bundle: ${rel}`);
}

console.log('test-taste-bundle: ok');
