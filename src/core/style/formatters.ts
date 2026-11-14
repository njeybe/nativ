import fs from 'node:fs';
import path from 'node:path';
import type { StyleFormatter, StyleLanguage } from './style-types.js';

const JS_OWNS = ['indent', 'quotes', 'semicolons', 'trailingCommas'];
const PY_OWNS = ['indent', 'quotes'];
const PRETTIER_FILE = /^(\.prettierrc(\.(json5?|ya?ml|toml|c?js|mjs))?|prettier\.config\.(c?js|mjs))$/;
const ESLINT_FILE = /^(eslint\.config\..+|\.eslintrc.*)$/;

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function readPackageJson(root: string): Record<string, unknown> {
  try {
    return JSON.parse(readText(path.join(root, 'package.json')));
  } catch {
    return {};
  }
}

function hasToml(text: string, table: string): boolean {
  const escaped = table.replace(/[.[\]]/g, '\\$&');
  return new RegExp(`^\\s*\\[${escaped}\\]`, 'm').test(text);
}

// Languages an .editorconfig section glob can match.
function sectionLanguages(glob: string): StyleLanguage[] {
  if (glob === '*' || glob === '**') return ['js', 'python'];
  const langs: StyleLanguage[] = [];
  if (/(ts|js|mjs|cjs|jsx|tsx)/.test(glob)) langs.push('js');
  if (/py/.test(glob)) langs.push('python');
  return langs;
}

function editorconfigLanguages(text: string): StyleLanguage[] {
  const found = new Set<StyleLanguage>();
  let langs: StyleLanguage[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[(.+)\]$/.exec(line);
    if (section) langs = sectionLanguages(section[1]);
    else if (/^indent_(style|size)\s*=/.test(line)) langs.forEach((l) => found.add(l));
  }
  return [...found];
}

function entry(tool: string, config: string, language: StyleLanguage, owns: string[]) {
  return { tool, config, language, owns } satisfies StyleFormatter;
}

/** Finds formatters and linters at the repository root and the traits each owns. */
export function detectFormatters(root: string): StyleFormatter[] {
  const names = fs.existsSync(root) ? fs.readdirSync(root) : [];
  const has = (n: string) => names.includes(n);
  const pkg = readPackageJson(root);
  const pyproject = readText(path.join(root, 'pyproject.toml'));
  const out: StyleFormatter[] = [];

  const prettier = names.find((n) => PRETTIER_FILE.test(n));
  if (prettier) out.push(entry('prettier', prettier, 'js', JS_OWNS));
  else if ('prettier' in pkg) out.push(entry('prettier', 'package.json', 'js', JS_OWNS));

  const biome = ['biome.json', 'biome.jsonc'].find(has);
  if (biome) out.push(entry('biome', biome, 'js', JS_OWNS));

  const ec = readText(path.join(root, '.editorconfig'));
  for (const lang of editorconfigLanguages(ec)) {
    out.push(entry('editorconfig', '.editorconfig', lang, ['indent']));
  }

  if (hasToml(pyproject, 'tool.black')) out.push(entry('black', 'pyproject.toml', 'python', PY_OWNS));

  const ruffToml = ['ruff.toml', '.ruff.toml'].find(
    (n) => has(n) && hasToml(readText(path.join(root, n)), 'format'),
  );
  if (ruffToml) out.push(entry('ruff', ruffToml, 'python', PY_OWNS));
  else if (hasToml(pyproject, 'tool.ruff.format')) {
    out.push(entry('ruff', 'pyproject.toml', 'python', PY_OWNS));
  }

  const eslint = names.find((n) => ESLINT_FILE.test(n));
  if (eslint) out.push(entry('eslint', eslint, 'js', []));
  else if ('eslintConfig' in pkg) out.push(entry('eslint', 'package.json', 'js', []));
  return out;
}
