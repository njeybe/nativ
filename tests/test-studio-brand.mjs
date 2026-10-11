import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WORDMARK_PATH } from '../src/server/studio-ui/shell/brand.ts';
import { renderStudioHtml } from '../src/server/studio-ui.ts';

// Run with `npx tsx tests/test-studio-brand.mjs`.
console.log('--- Studio brand: wordmark and notices ---');

const pathOf = (f) => readFileSync(f, 'utf8').match(/ d="([^"]+)"/)[1];
assert.equal(WORDMARK_PATH, pathOf('assets/brand/nativ-dark.svg'));
assert.equal(WORDMARK_PATH, pathOf('assets/brand/nativ-light.svg'));

const html = renderStudioHtml({ version: '1.0.0' });
for (const s of ['class="wordmark"', 'role="img"', 'aria-label="nativ"', 'fill="currentColor"']) {
  assert.ok(html.includes(s), s);
}
assert.ok(!html.includes('<span class="logo">'), 'old logo square gone');
assert.ok(!html.includes('viewBox="0 0 24 24"'), 'no 24px icons');

// Spec bans en and em dashes in Studio UI text, scripts and styles.
const dashAt = html.search(/[–—]/);
assert.equal(dashAt, -1, 'en/em dash in Studio HTML: ' + html.slice(Math.max(0, dashAt - 40), dashAt + 40));

const readme = readFileSync('README.md', 'utf8');
assert.ok(readme.includes('Phosphor Icons'));
assert.ok(readme.includes('Copyright (c) 2023 Phosphor Icons'));

console.log('ok: studio brand');
