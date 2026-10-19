import vm from 'node:vm';
import assert from 'node:assert/strict';

// Run with `npx tsx tests/test-studio-inspector.mjs`: checks the runner inspector pane.
import { markupTools } from '../src/server/studio-ui/shell/markup-tools.ts';
import { consoleScript } from '../src/server/studio-ui/shell/console.ts';
import { proposalsScript } from '../src/server/studio-ui/shell/proposals.ts';
import { consoleCss } from '../src/server/studio-ui/styles/console.ts';

const start = markupTools.indexOf('<section id="runner-console-drawer"');
const drawer = markupTools.slice(start, markupTools.indexOf('</section>', start));
const has = (re, msg) => assert.match(drawer, re, msg);

has(/id="runner-console-drawer" aria-labelledby="rc-task"/, 'drawer id and label');
has(/role="tablist"/, 'tablist');
for (const [tab, pane] of [['logs', 'rc-body'], ['diff', 'rc-diff'], ['heal', 'rc-heal']]) {
  const re = new RegExp(`id="rc-tab-${tab}"[^>]*aria-controls="${pane}" aria-selected=`);
  has(new RegExp(`role="tab" id="rc-tab-${tab}"`), `tab ${tab} role`);
  has(re, `tab ${tab} controls ${pane}`);
}
has(/id="rc-body" role="log" aria-live="polite"/, 'log pane');
has(/id="rc-diff" role="tabpanel"/, 'diff pane');
has(/id="rc-heal" role="tabpanel"/, 'heal pane');
has(/id="rc-abort"[^>]*aria-label="Stop the running agent" hidden>Stop</, 'Stop control');
has(/id="rc-more"[^>]*aria-haspopup="true" aria-expanded="false"/, 'More menu button');
for (const id of ['rc-open-diff', 'rc-clear', 'rc-autoscroll']) {
  assert.ok(drawer.indexOf(id) > drawer.indexOf('id="rc-more-menu"'), id + ' in More menu');
}
assert.ok(!/Abort|Idle/.test(drawer), 'no Abort or Idle in console');
for (const copy of ['Live Logs', 'Worktree Changes', 'Self-Healing Proposal', 'Open diff']) {
  assert.ok(drawer.includes(copy), `copy ${copy}`);
}
assert.ok(!/[\u2013\u2014]|&#821[12];|&ndash;|&mdash;/.test(drawer), 'no en or em dash');

assert.ok(!/viewBox="0 0 (16 16|24 24)"/.test(markupTools), 'Phosphor icons only');
assert.ok(markupTools.includes('viewBox="0 0 256 256"'), 'Phosphor viewBox');

assert.match(consoleCss, /width: 320px/, '320px pane');
assert.match(consoleCss, /@media \(min-width: 1280px\)[^}]*width: 360px/, '360px pane');
assert.match(consoleCss, /@media \(max-width: 1023px\)[^}]*92vw/, 'narrow sheet');
assert.match(consoleCss, /:has\(#runner-console-drawer:not\(\[hidden\]\)\) main \{ margin-right/,
  'content reflow');
assert.match(consoleCss, /prefers-reduced-motion/, 'reduced motion');

for (const [name, code] of [['console', consoleScript], ['proposals', proposalsScript]]) {
  assert.doesNotThrow(() => new vm.Script(code), `${name} parses`);
  assert.ok(!code.includes('`') && !code.includes('${'), `${name} has no template syntax`);
}
assert.match(consoleScript, /rc\.opener = active/, 'opener stored');
assert.match(consoleScript, /opener\.focus\(\)/, 'focus returns');
assert.match(proposalsScript, /restoreInspectorFocus\(\)/, 'close restores focus');
assert.match(consoleScript, /aria-modal/, 'sheet is modal');

console.log('inspector checks passed');
