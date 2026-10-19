import fs from 'node:fs';
import assert from 'node:assert/strict';

// Run with `npx tsx tests/test-studio-db-bench.mjs`: pins the calm Database and Benchmarks wording.
const P = 'src/server/studio-ui/pages/';
const read = (f) => fs.readFileSync(P + f, 'utf8');
const files = ['database/data-shell.ts', 'database/connection.ts', 'database/explorer.ts',
  'benchmarks/script.ts', 'benchmarks/styles.ts'];

for (const f of files) assert.ok(!read(f).includes(' · '), `${f} has a middle-dot separator`);

const shell = read('database/data-shell.ts');
assert.match(shell, /Not set up/);
assert.match(shell, /dot"><\/span><b>' \+ label \+ ':<\/b> Not set up/, 'Not set up uses a plain dot');
assert.match(shell, /badge-neutral">Not set up/);
assert.ok(!/not configured' : 'offline'/.test(shell), 'old red not-configured path remains');
assert.match(read('database/connection.ts'), /Not set up/);

const settingsButtons = files.slice(0, 3).map((f) => read(f))
  .join('\n').match(/<button[^>]*open-settings[^>]*>|btn-diag-settings/g) || [];
assert.equal(settingsButtons.length, 0, 'duplicate Connection Settings buttons remain');
const markup = fs.readFileSync(P + 'database/markup.ts', 'utf8');
assert.equal((markup.match(/Connection Settings/g) || []).length >= 1, true);

const styles = read('benchmarks/styles.ts');
assert.ok(!/\.eyebrow/.test(styles) && !/text-transform:\s*uppercase/.test(styles), 'uppercase eyebrow');
assert.ok(!/eyebrow/.test(read('benchmarks/script.ts')));

const script = read('benchmarks/script.ts');
assert.match(script, /Not run: ' +/, 'not-run scenarios collapse to one line');
assert.ok(!script.includes('Not part of the last run'), 'per-scenario not-run card remains');

console.log('✓ studio db/bench polish checks passed');
