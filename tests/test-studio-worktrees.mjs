import assert from 'node:assert/strict';
import { worktreesPage } from '../src/server/studio-ui/pages/worktrees/index.ts';

const js = worktreesPage.script;
const css = worktreesPage.css;
for (const [n, t] of [['script', js], ['css', css]]) {
  assert.ok(!t.includes('`') && !t.includes('${'), `${n} has no backtick or dollar-brace`);
}
for (const h of ['Task', 'Branch', 'Status', 'Changes', 'Actions']) {
  assert.ok(js.includes('<th scope="col">' + h + '</th>'), 'column ' + h);
}
assert.ok(js.includes('View changes'), 'View changes button');
assert.match(js, /'wt-diff': function \(el\) \{ openConsole\(.*false, 'diff'\)/, 'opens inspector diff tab');
assert.ok(!js.includes('wt-card') && !/diff-panel|wt-diff-view/.test(js), 'no standalone diff panel');
assert.ok(js.includes('No worktrees open.'), 'empty state copy');
for (const a of ['wt-merge', 'wt-remove', '/api/pipeline/worktrees/action']) {
  assert.ok(js.includes(a), 'hook ' + a);
}
assert.ok(js.includes('aria-label'), 'aria labels');
assert.ok(!/[\u2013\u2014]/.test(js + css), 'no dashes');
new Function(js.replace(/^[\s\S]*$/, 'return 0;'));
console.log('worktrees ok');
