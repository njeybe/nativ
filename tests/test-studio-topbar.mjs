import assert from 'node:assert/strict';
import { renderStudioHtml } from '../src/server/studio-ui.ts';
import { dispatchScript } from '../src/server/studio-ui/shell/dispatch.ts';

// Run with `npx tsx tests/test-studio-topbar.mjs`.
console.log('--- Studio top bar ---');
const html = renderStudioHtml({ version: '1.0.0' });
const at = (s) => { const i = html.indexOf(s); assert.ok(i >= 0, s); return i; };
const order = ['class="crumb"', 'id="btn-find"', 'id="btn-theme"', 'id="btn-dispatch-next"', 'id="t1-chip"', 'id="live"'];
for (let i = 1; i < order.length; i++) assert.ok(at(order[i - 1]) < at(order[i]), order[i]);
const btn = html.slice(at('id="btn-dispatch-next"'), at('id="t1"'));
assert.ok(btn.includes('<svg') && btn.includes('<path'), 'play icon');
assert.ok(at('</header>') < at('id="pulse"'));
assert.ok(html.includes('id="pulse" class="pulse-strip" aria-live="polite"'));
assert.ok(html.includes('class="wordmark"') && html.includes('class="wordmark is-rail"'));
assert.ok(!dispatchScript.includes('Nothing ready'));
assert.ok(/id="btn-dispatch-next" type="button" hidden/.test(html), 'starts hidden');
assert.ok(dispatchScript.includes('nextBtn.hidden = !t'));
assert.ok(!dispatchScript.includes('Abort agent run'));
new Function(dispatchScript);
console.log('ok: studio top bar');
