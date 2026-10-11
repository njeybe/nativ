import fs from 'fs';
import path from 'path';
import {
  DESIGN_PROFILES,
  SCAN_EXTENSIONS,
  checkText,
  readProfile,
  type DesignFinding,
  type DesignProfile,
} from '../core/design-rules.js';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.ai']);

let jsonMode = false;

function fail(msg: string): never {
  if (jsonMode) console.log(JSON.stringify({ error: msg }));
  else console.error(msg);
  process.exit(1);
}

function isScannable(name: string): boolean {
  if (/\.(test|spec)\./.test(name)) return false;
  return SCAN_EXTENSIONS.includes(path.extname(name));
}

function collect(target: string, out: string[]): void {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (isScannable(path.basename(target))) out.push(target);
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    collect(path.join(target, entry.name), out);
  }
}

function resolveProfile(opt: string | undefined, cwd: string): DesignProfile {
  if (opt !== undefined) {
    if (!(DESIGN_PROFILES as readonly string[]).includes(opt)) {
      fail(`Unknown profile "${opt}". Use one of: ${DESIGN_PROFILES.join(', ')}`);
    }
    return opt as DesignProfile;
  }
  const specs = path.join(cwd, '.ai', 'ui_specs.md');
  const found = fs.existsSync(specs) ? readProfile(fs.readFileSync(specs, 'utf8')) : null;
  if (found) return found;
  return fail(
    'No design profile is set. Pass --profile taste-v1|taste-v2, or ask the architect '
      + 'to fill the Design Profile in .ai/ui_specs.md.',
  );
}

type Located = DesignFinding & { file: string };

export function runDesignCheck(
  paths: string[] | undefined,
  options: { profile?: string; json?: boolean },
): void {
  jsonMode = !!options.json;
  const cwd = process.cwd();
  const profile = resolveProfile(options.profile, cwd);
  const files: string[] = [];
  for (const p of paths && paths.length ? paths : ['src']) {
    const abs = path.resolve(cwd, p);
    if (!fs.existsSync(abs)) fail(`Path not found: ${p}`);
    collect(abs, files);
  }
  const findings: Located[] = [];
  for (const abs of files) {
    const file = path.relative(cwd, abs).split(path.sep).join('/');
    const text = fs.readFileSync(abs, 'utf8');
    for (const f of checkText(text, path.extname(abs), profile)) findings.push({ file, ...f });
  }
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.length - errors;
  if (options.json) {
    const out = { profile, filesScanned: files.length, findings, errors, warnings };
    console.log(JSON.stringify(out, null, 2));
  } else {
    for (const f of findings) {
      console.log(`${f.file}:${f.line}:${f.column}  ${f.rule}  ${f.message}`);
    }
    console.log(`${files.length} files scanned (${profile}): ${errors} errors, ${warnings} warnings`);
  }
  process.exit(errors > 0 ? 1 : 0);
}
