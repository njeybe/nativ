// Guards the always-loaded and per-call text against growth. Budgets are in approximate tokens (chars / 4).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tokens = (rel) => Math.ceil(fs.readFileSync(path.join(root, rel), 'utf8').length / 4);

const budgets = {
  'templates/AGENTS.md': 1750,
  'templates/CLAUDE.md': 700,
  'templates/claude-agents/worker.md': 700,
  'templates/claude-agents/verifier.md': 520,
  'templates/claude-agents/explorer.md': 850,
  'templates/claude-agents/architect.md': 2000,
};

for (const [rel, max] of Object.entries(budgets)) {
  const used = tokens(rel);
  assert.ok(used <= max, `${rel} is ~${used} tokens, budget ${max}. Trim it or raise the budget on purpose.`);
}

const claude = fs.readFileSync(path.join(root, 'templates/CLAUDE.md'), 'utf8');
assert.ok(!/Human-Centric/.test(claude), 'CLAUDE.md must not repeat the human-communication rules kept in AGENTS.md');
for (const rel of ['worker', 'verifier', 'explorer', 'architect']) {
  const text = fs.readFileSync(path.join(root, `templates/claude-agents/${rel}.md`), 'utf8');
  assert.ok(!/Read `AGENTS\.md` first/.test(text), `${rel} must not force a second read of AGENTS.md`);
}
assert.ok(fs.readFileSync(path.join(root, 'templates/AGENTS.md'), 'utf8').includes('## Self-healing ladder'), 'AGENTS.md keeps the escalation ladder');
console.log('✔ token budgets hold');
