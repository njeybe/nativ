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
console.log('style templates ok');
