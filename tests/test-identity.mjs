// Person name from git config: a local user.name, a repo without one, and hidden characters.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolvePerson } from '../dist/core/identity.js';

const created = [];
const emptyConfig = path.join(os.tmpdir(), `nativ-identity-empty-${process.pid}.gitconfig`);
fs.writeFileSync(emptyConfig, '');
created.push(emptyConfig);

function makeRepo(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nativ-identity-${name}-`));
  created.push(dir);
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

// Runs with git pointed away from the developer's own config.
function withIsolatedGit(fn) {
  const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM };
  process.env.GIT_CONFIG_GLOBAL = emptyConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  try {
    return fn();
  } finally {
    for (const [key, val] of [['GIT_CONFIG_GLOBAL', saved.g], ['GIT_CONFIG_NOSYSTEM', saved.s]]) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  }
}

try {
  const withName = makeRepo('named');
  spawnSync('git', ['config', 'user.name', String.fromCharCode(0x200b) + '  Ada Lovelace\u0007  '], { cwd: withName });
  withIsolatedGit(() => {
    assert.equal(resolvePerson(withName), 'Ada Lovelace');
  });

  const longRepo = makeRepo('long');
  spawnSync('git', ['config', 'user.name', 'x'.repeat(100)], { cwd: longRepo });
  withIsolatedGit(() => {
    assert.equal(resolvePerson(longRepo), 'x'.repeat(64));
  });

  const bare = makeRepo('bare');
  withIsolatedGit(() => {
    assert.equal(resolvePerson(bare), undefined);
  });

  const missing = path.join(os.tmpdir(), `nativ-identity-missing-${process.pid}`);
  withIsolatedGit(() => {
    assert.equal(resolvePerson(missing), undefined);
  });

  const blank = makeRepo('blank');
  spawnSync('git', ['config', 'user.name', '   '], { cwd: blank });
  withIsolatedGit(() => {
    assert.equal(resolvePerson(blank), undefined);
  });

  console.log('identity: all checks passed');
} finally {
  for (const p of created) fs.rmSync(p, { recursive: true, force: true });
}
