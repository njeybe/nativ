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
  'Component Map', 'Copy & Wording', 'Signature Moments', 'Anti-Generic Checklist',
  'States', 'Accessibility',
];
for (const h of headings) {
  assert.ok(new RegExp(`^##\\s+${h.replace(/[&]/g, '\\$&')}\\s*$`, 'm').test(ui), `ui_specs.md is missing heading "${h}"`);
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
assert.ok(!/[^\x00-\x7f]/.test(frontend.replace(/[–—]/g, '')), 'frontend.md has no emoji or mojibake');
assert.ok(frontend.split('\n').every((l) => l.length <= 100), 'frontend.md lines are 100 chars or fewer');
assert.ok(!/CSS mathematics|#[0-9a-f]{6}\b/i.test(frontend), 'frontend.md has no jargon or hard-coded hex');

const flutter = fs.readFileSync(path.join(root, 'templates', 'dot-ai', 'subagents', 'flutter-developer.md'), 'utf8');
for (const term of ['ThemeData', 'ThemeExtension', '48dp', 'offline', 'permission denied', 'specSlices', 'acceptanceCriteria', 'wireframes', 'style-tile.html', 'Code style', 'one widget per file']) {
  assert.ok(flutter.toLowerCase().includes(term.toLowerCase()), `flutter-developer.md does not mention "${term}"`);
}
assert.ok(!/[^\x00-\x7f]/.test(flutter.replace(/[–—]/g, '')), 'flutter-developer.md has no emoji or mojibake');
assert.ok(flutter.split('\n').every((l) => l.length <= 100), 'flutter-developer.md lines are 100 chars or fewer');
assert.ok(!/#[0-9a-f]{6}\b/i.test(flutter), 'flutter-developer.md has no hard-coded hex');

console.log('test-design-templates: ok');
