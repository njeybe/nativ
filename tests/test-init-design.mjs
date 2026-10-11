import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { checkHarnessIntegrity } from '../dist/core/harness-integrity.js';

console.log('--- Starting init --design Tests ---');
const CLI = path.resolve('bin', 'cli.js');
const nativ = (cwd, ...a) =>
  spawnSync(process.execPath, [CLI, ...a], { cwd, encoding: 'utf8', timeout: 120_000 });
const dirs = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-design-'));
  dirs.push(d);
  fs.writeFileSync(path.join(d, 'package.json'), '{"name":"demo","version":"1.0.0"}');
  return d;
};
const P = (root, rel) => path.join(root, ...rel.split('/'));
const designFindings = (root) => checkHarnessIntegrity(root)
  .filter((f) => f.id === 'specs:design-profile' || f.id === 'design:taste-bundle');

try {
  const a = tmp();
  assert.equal(nativ(a, 'init', a).status, 0);
  for (const f of ['LICENSE', 'SOURCE.md', 'v1/SKILL.md', 'v1/DIGEST.md', 'v2/SKILL.md', 'v2/DIGEST.md']) {
    assert.ok(fs.existsSync(P(a, `.ai/design/taste/${f}`)), f);
  }
  const specs = fs.readFileSync(P(a, '.ai/ui_specs.md'), 'utf8');
  assert.match(specs, /^- \*\*Profile:\*\* taste-v1 \| taste-v2$/m, 'placeholder stays');
  assert.deepEqual(designFindings(a), [], 'clean project has no design findings');
  console.log('✔ Test 1: init installs the bundle and keeps the placeholder');

  const b = tmp();
  assert.equal(nativ(b, 'init', b, '--design', 'taste-v2').status, 0);
  const sb = fs.readFileSync(P(b, '.ai/ui_specs.md'), 'utf8');
  assert.match(sb, /^- \*\*Profile:\*\*\s*(taste-v1|taste-v2)\s*$/m);
  assert.match(sb, /^- \*\*Profile:\*\* taste-v2\s*$/m);
  assert.match(sb, /^- \*\*Digest:\*\* \.ai\/design\/taste\/v2\/DIGEST\.md\s*$/m);
  const c = tmp();
  const nv = nativ(c, 'init', c, '--design', 'nativ');
  assert.equal(nv.status, 1);
  assert.ok(!fs.existsSync(P(c, '.ai')), 'nativ profile writes nothing');
  console.log('✔ Test 2: --design writes the Profile and Digest lines');

  const d = tmp();
  const bad = nativ(d, 'init', d, '--design', 'bogus');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr + bad.stdout, /taste-v1, taste-v2/);
  assert.ok(!fs.existsSync(P(d, '.ai')), 'no .ai/ created');
  console.log('✔ Test 3: unknown profile exits 1 and writes nothing');

  const before = fs.readFileSync(P(a, '.ai/ui_specs.md'), 'utf8');
  fs.rmSync(P(a, '.ai/design/taste/v1/DIGEST.md'));
  fs.writeFileSync(P(a, '.ai/design/taste/v2/SKILL.md'), 'my edit\n');
  const up = nativ(a, 'update', a);
  assert.ok(fs.existsSync(P(a, '.ai/design/taste/v1/DIGEST.md')), 'deleted file re-added');
  assert.equal(fs.readFileSync(P(a, '.ai/design/taste/v2/SKILL.md'), 'utf8'), 'my edit\n');
  assert.equal(fs.readFileSync(P(a, '.ai/ui_specs.md'), 'utf8'), before, 'ui_specs untouched');
  assert.match(up.stdout, /v2\/SKILL\.md/);
  console.log('✔ Test 4: update adds missing, keeps edited, leaves ui_specs.md');

  // Simulate an older template: file and manifest agree, so update refreshes it.
  const mpath = P(a, '.ai/design/taste/.manifest.json');
  const manifest = JSON.parse(fs.readFileSync(mpath, 'utf8'));
  assert.ok(manifest['v1/SKILL.md'], 'manifest lists installed files');
  const old = 'old template\n';
  fs.writeFileSync(P(a, '.ai/design/taste/v1/SKILL.md'), old);
  manifest['v1/SKILL.md'] = createHash('sha256').update(old).digest('hex');
  fs.writeFileSync(mpath, JSON.stringify(manifest));
  nativ(a, 'update', a);
  assert.equal(
    fs.readFileSync(P(a, '.ai/design/taste/v1/SKILL.md'), 'utf8'),
    fs.readFileSync(path.resolve('templates/design/taste/v1/SKILL.md'), 'utf8'),
    'untouched old file refreshed',
  );
  assert.equal(fs.readFileSync(P(a, '.ai/design/taste/v2/SKILL.md'), 'utf8'), 'my edit\n', 'edit kept');
  console.log('✔ Test 4b: update refreshes untouched old files and keeps edited ones');

  const f = designFindings(a);
  assert.deepEqual(f.map((x) => x.id), ['design:taste-bundle']);
  assert.equal(f[0].status, 'info');
  fs.writeFileSync(P(a, '.ai/ui_specs.md'), '# Old specs\nMarketing pages\n');
  fs.rmSync(P(a, '.ai/design'), { recursive: true });
  const g = designFindings(a);
  assert.deepEqual(g.map((x) => x.id).sort(), ['design:taste-bundle', 'specs:design-profile']);
  assert.ok(g.every((x) => x.status === 'info'));
  console.log('✔ Test 5: doctor findings are info and appear when expected');
} finally {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
console.log('All init --design tests passed');
