import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const md = readFileSync(new URL('../templates/AGENTS.md', import.meta.url), 'utf8');
assert.ok(
  md.includes("A project's own formatter or linter wins, then the task's `styleSlice`."),
  'AGENTS.md formatter line must mention styleSlice',
);
console.log('style templates ok');
