import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectFormatters } from '../dist/core/style/formatters.js';

const mk = (files) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-fm-'));
  for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(root, f), t);
  return root;
};
const tools = (files) => detectFormatters(mk(files)).map((f) => `${f.tool}:${f.config}:${f.language}`);
const JS4 = ['indent', 'quotes', 'semicolons', 'trailingCommas'];

assert.deepEqual(detectFormatters(mk({})), []);
assert.deepEqual(detectFormatters(path.join(os.tmpdir(), 'nativ-fm-missing')), []);

for (const f of ['.prettierrc', '.prettierrc.yml', '.prettierrc.mjs', 'prettier.config.cjs']) {
  assert.deepEqual(tools({ [f]: '' }), [`prettier:${f}:js`]);
}
assert.deepEqual(tools({ 'package.json': '{"prettier":{}}' }), ['prettier:package.json:js']);
assert.deepEqual(tools({ 'package.json': '{"name":"x"}' }), []);
assert.deepEqual(detectFormatters(mk({ 'biome.jsonc': '{}' }))[0].owns, JS4);
assert.deepEqual(tools({ 'biome.json': '{}' }), ['biome:biome.json:js']);

assert.deepEqual(tools({ '.editorconfig': '[*]\nindent_style = tab\n' }), [
  'editorconfig:.editorconfig:js', 'editorconfig:.editorconfig:python',
]);
assert.deepEqual(tools({ '.editorconfig': '[*.py]\nindent_size = 4\n' }), [
  'editorconfig:.editorconfig:python',
]);
assert.deepEqual(tools({ '.editorconfig': '[*]\ncharset = utf-8\n' }), []);

const black = detectFormatters(mk({ 'pyproject.toml': '[tool.black]\nline-length = 88\n' }));
assert.deepEqual(black, [{ tool: 'black', config: 'pyproject.toml', language: 'python',
  owns: ['indent', 'quotes'] }]);
assert.deepEqual(tools({ 'pyproject.toml': '[tool.ruff.format]\n' }), ['ruff:pyproject.toml:python']);
assert.deepEqual(tools({ 'ruff.toml': '[format]\n' }), ['ruff:ruff.toml:python']);
assert.deepEqual(tools({ '.ruff.toml': '[format]\n' }), ['ruff:.ruff.toml:python']);
assert.deepEqual(tools({ 'ruff.toml': 'line-length = 88\n' }), []);

const lint = detectFormatters(mk({ 'eslint.config.js': '', '.prettierrc': '' }));
assert.deepEqual(lint.find((f) => f.tool === 'eslint').owns, []);
assert.deepEqual(tools({ 'package.json': '{"eslintConfig":{}}' }), ['eslint:package.json:js']);

const naming = /naming|importStyle|exportStyle|moduleSystem/;
const allFormatters = { '.prettierrc': '', 'biome.json': '', '.editorconfig': '[*]\nindent_size=2\n' };
for (const f of detectFormatters(mk(allFormatters))) {
  assert.ok(!f.owns.some((o) => naming.test(o)));
}
console.log('style formatters ok');
