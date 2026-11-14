import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const md = readFileSync(new URL('../templates/AGENTS.md', import.meta.url), 'utf8');
assert.ok(
  md.includes("A project's own formatter or linter wins, then the task's `styleSlice`."),
  'AGENTS.md formatter line must mention styleSlice',
);
const ver = readFileSync(new URL('../templates/claude-agents/verifier.md', import.meta.url), 'utf8');
assert.ok(ver.includes('nativ style show --files <targetFiles>'), 'verifier runs style show');
assert.ok(ver.includes('`codebase` suppresses'), 'verifier honours codebase decisions');
const exp = readFileSync(new URL('../templates/claude-agents/explorer.md', import.meta.url), 'utf8');
assert.ok(exp.includes('5. **Patterns.**'), 'explorer reports Patterns');
assert.ok(exp.includes('| evidence:'), 'explorer pattern line has evidence');
const arc = readFileSync(new URL('../templates/claude-agents/architect.md', import.meta.url), 'utf8');
assert.ok(
  arc.includes('as `.ai/codebase_map.md` and its approved Patterns into `.ai/code_style.json`'),
  'architect saves patterns',
);
console.log('style templates ok');
