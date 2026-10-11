// Offline check of the design-first templates.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ui = fs.readFileSync(path.join(root, 'templates', 'dot-ai', 'ui_specs.md'), 'utf8');

const headings = [
  'Planning Level', 'Design Brief', 'Users & Top Tasks', 'Real Content Samples',
  'User Flows', 'Design Directions', 'Design Tokens', 'Platform Rules', 'Wireframes',
  'Component Map', 'Copy & Wording', 'Signature Moments',
  'States', 'Accessibility', 'Design Profile',
];
for (const h of headings) {
  assert.ok(new RegExp(`^##\\s+${h.replace(/[&]/g, '\\$&')}\\s*$`, 'm').test(ui), `ui_specs.md is missing heading "${h}"`);
}

const h2 = ui.match(/^## .+$/gm);
assert.equal(h2[h2.indexOf('## Planning Level') + 1], '## Design Profile', 'Design Profile follows Planning Level');
const profileRe = /^- \*\*Profile:\*\*\s*(taste-v1|taste-v2)\s*$/m;
assert.ok(!profileRe.test(ui), 'template placeholder is not a machine-read profile');
assert.ok(profileRe.test('- **Profile:** taste-v2'), 'a filled profile line is machine-read');
assert.ok(!profileRe.test('- **Profile:** nativ'), 'the nativ profile no longer exists');
assert.ok(!ui.includes('Anti-Generic Checklist'), 'ui_specs.md has no Anti-Generic Checklist');
for (const t of ['Marketing pages', 'Transitions:', 'Active state']) {
  assert.ok(!ui.includes(t), `ui_specs.md still has "${t}"`);
}

assert.ok(/^###\s+appointment-list\s*$/m.test(ui), 'ui_specs.md has a stable component anchor example');
assert.ok(ui.includes('.ai/design/style-tile.html'), 'ui_specs.md links the style tile');
assert.ok(!/#4f46e5|#4338ca|#eef2ff|#f8fafc|#0f172a/i.test(ui), 'no hard-coded slate/indigo palette remains');
assert.ok(!/#[0-9a-f]{6}\b/i.test(ui), 'no hard-coded hex colors remain');

const architect = fs.readFileSync(path.join(root, 'templates', 'claude-agents', 'architect.md'), 'utf8');
for (const term of ['planning level', 'design brief', 'two directions', 'style tile', 'wireframes', 'specRefs', 'acceptanceCriteria']) {
  assert.ok(architect.toLowerCase().includes(term.toLowerCase()), `architect.md does not mention "${term}"`);
}
assert.ok(architect.includes('.ai/design/direction-a.html'), 'architect.md names the direction tile paths');

const briefStep = architect.search(/Design brief \(Standard and Full\)/);
const directionsStep = architect.search(/Two directions \(Full only\)/);
assert.ok(briefStep >= 0, 'architect.md has a design brief step');
assert.ok(briefStep < directionsStep, 'architect.md writes the brief before the directions');
assert.ok(/primary platform/i.test(architect.slice(briefStep, directionsStep)), 'architect.md brief step records the primary platform');
const gemini = fs.readFileSync(path.join(root, 'templates', 'GEMINI.md'), 'utf8');
const geminiBrief = gemini.search(/fill the Design Brief section/);
assert.ok(geminiBrief >= 0, 'GEMINI.md has a design brief step');
assert.ok(geminiBrief < gemini.search(/Full only: exactly two/), 'GEMINI.md writes the brief before the directions');
assert.ok(/primary platform/i.test(gemini.slice(geminiBrief, geminiBrief + 300)), 'GEMINI.md brief step records the primary platform');

const frontendPath = path.join(root, 'templates', 'dot-ai', 'subagents', 'frontend.md');
const frontend = fs.readFileSync(frontendPath, 'utf8');
for (const term of ['wireframes', 'component map', 'style-tile.html', 'specSlices', 'acceptanceCriteria', 'Code style']) {
  assert.ok(frontend.toLowerCase().includes(term.toLowerCase()), `frontend.md does not mention "${term}"`);
}
for (const term of ['Design Profile', 'DIGEST.md', 'taste-v1', 'taste-v2', 'dependency_conflict', 'architectural_ambiguity', 'React 18']) {
  assert.ok(frontend.includes(term), `frontend.md does not mention "${term}"`);
}
assert.ok(!/[^\x00-\x7f]/.test(frontend.replace(/[–—]/g, '')), 'frontend.md has no emoji or mojibake');
assert.ok(frontend.split('\n').every((l) => l.length <= 100), 'frontend.md lines are 100 chars or fewer');
assert.ok(!/CSS mathematics|#[0-9a-f]{6}\b/i.test(frontend), 'frontend.md has no jargon or hard-coded hex');

for (const t of ['Visual style', 'Anti-generic rules', 'Build-time details', 'Anti-Generic Checklist', '`nativ`']) {
  assert.ok(!frontend.includes(t), `frontend.md still has "${t}"`);
}
assert.ok(frontend.includes('architectural_ambiguity') && frontend.includes('DIGEST.md'), 'frontend.md escalates and names the digest');

const flutter = fs.readFileSync(path.join(root, 'templates', 'dot-ai', 'subagents', 'flutter-developer.md'), 'utf8');
for (const term of ['ThemeData', 'ThemeExtension', '48dp', 'offline', 'permission denied', 'specSlices', 'acceptanceCriteria', 'wireframes', 'style-tile.html', 'Code style', 'one widget per file']) {
  assert.ok(flutter.toLowerCase().includes(term.toLowerCase()), `flutter-developer.md does not mention "${term}"`);
}
assert.ok(!/[^\x00-\x7f]/.test(flutter.replace(/[–—]/g, '')), 'flutter-developer.md has no emoji or mojibake');
assert.ok(flutter.split('\n').every((l) => l.length <= 100), 'flutter-developer.md lines are 100 chars or fewer');
assert.ok(!/#[0-9a-f]{6}\b/i.test(flutter), 'flutter-developer.md has no hard-coded hex');

for (const [name, txt] of [['frontend.md', frontend], ['flutter-developer.md', flutter]]) {
  assert.ok(txt.includes('ASCII box art') && txt.includes('Semantic Component Tree'), `${name} names both wireframe formats`);
}
for (const [name, txt] of [['architect.md', architect], ['GEMINI.md', gemini]]) {
  for (const term of ['--primary', '--ring', '--radius', 'ColorScheme', 'ThemeExtension']) {
    assert.ok(txt.includes(term), `${name} style tile step mentions ${term}`);
  }
}

const intake = ['Experience-First', 'Data-First'];
for (const term of [...intake, 'Semantic Component Tree', 'Mutation / Action']) {
  assert.ok(ui.includes(term), `ui_specs.md does not mention "${term}"`);
}

const pluginArchitect = fs.readFileSync(path.join(root, 'plugin', 'agents', 'architect.md'), 'utf8');
const enhanced = [
  ['architect.md', architect, [...intake, 'Contextual Typography', 'Semantic Component Tree', 'Mutation State']],
  ['plugin architect.md', pluginArchitect, [...intake, 'Contextual Typography', 'Semantic Component Tree', 'Mutation State']],
  ['GEMINI.md', gemini, [...intake, 'Contextual Typography', 'Semantic Component Tree', 'Mutation State']],
  ['frontend.md', frontend, ['Contextual Typography', 'Semantic Component Tree', 'Mutation State']],
  ['flutter-developer.md', flutter, ['Contextual Typography', 'Semantic Component Tree', 'Mutation State']],
];
for (const [name, text, terms] of enhanced) {
  for (const term of terms) {
    assert.ok(text.includes(term), `${name} does not mention "${term}"`);
  }
}

const dotArchitect = fs.readFileSync(path.join(root, 'templates', 'dot-ai', 'subagents', 'architect.md'), 'utf8');
const profileTerms = ['Design Profile', 'taste-v1', 'taste-v2', '.ai/design/taste/', 'DIGEST.md'];
for (const [name, text] of [['architect.md', architect], ['plugin architect.md', pluginArchitect],
  ['GEMINI.md', gemini], ['dot-ai architect.md', dotArchitect]]) {
  for (const term of profileTerms) {
    assert.ok(text.includes(term), `${name} does not mention "${term}"`);
  }
}
for (const [name, text, level, wire] of [
  ['architect.md', architect, /\*\*Planning level\.\*\*/, /\*\*Wireframes\.\*\*/],
  ['GEMINI.md', gemini, /Pick the planning level/, /Wireframes, as ASCII/],
]) {
  const at = text.indexOf('Design Profile');
  assert.ok(text.search(level) < at, `${name} places Design Profile after the planning level`);
  assert.ok(at < text.search(wire), `${name} places Design Profile before the wireframes`);
}

console.log('test-design-templates: ok');

// nativ design rules are gone from every architect guide
for (const [name, text] of [['architect.md', architect], ['plugin architect.md', pluginArchitect],
  ['GEMINI.md', gemini], ['dot-ai architect.md', dotArchitect]]) {
  for (const bad of ['Anti-Generic', 'Marketing pages', 'Inter,', '`nativ` (', '`nativ` for']) {
    assert.ok(!text.includes(bad), `${name} still mentions "${bad}"`);
  }
}
