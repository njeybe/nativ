import fs from 'node:fs';
import path from 'node:path';
import { gitOutput } from './style-git.js';

export const EXISTING_CODEBASE_MIN_FILES = 10;
export const MAX_FILES_PER_DIR = 40;
export const MAX_FILES_TOTAL = 1500;
const MAX_FILE_BYTES = 256 * 1024;

const SKIP_DIRS = new Set([
  'dist', 'build', 'node_modules', 'vendor', 'generated', '.next', 'coverage',
]);
const SKIP_FILE = /(\.min\.[^/]+$)|(\.d\.ts$)|(^\.env)|(\.pem$)|(\.key$)|(\.local\.json$)/;
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py)$/;

export type StyleSources =
  | { available: true; files: string[] }
  | { available: false; reason: string };

function trackedFiles(root: string): string[] | null {
  const out = gitOutput(root, ['ls-files', '-z']);
  return out === null ? null : out.split('\0').filter(Boolean);
}

function pathAllowed(file: string): boolean {
  const parts = file.split('/');
  if (parts.slice(0, -1).some((p) => SKIP_DIRS.has(p))) return false;
  return !SKIP_FILE.test(parts[parts.length - 1]);
}

// Reads only the file head and size; unreadable files are skipped.
function contentAllowed(root: string, file: string): boolean {
  const full = path.join(root, file);
  try {
    if (fs.statSync(full).size > MAX_FILE_BYTES) return false;
    const head = fs.readFileSync(full, 'utf8').split('\n').slice(0, 5).join('\n');
    return !head.includes('@generated');
  } catch {
    return false;
  }
}

/** Source files the scanner may read: git-tracked, sorted, capped per directory and in total. */
export function listStyleSources(root: string): StyleSources {
  const tracked = trackedFiles(root);
  if (!tracked) return { available: false, reason: 'not a git repository' };
  const perDir = new Map<string, number>();
  const files: string[] = [];
  for (const file of tracked.sort()) {
    if (files.length >= MAX_FILES_TOTAL) break;
    if (!pathAllowed(file) || !contentAllowed(root, file)) continue;
    const dir = path.posix.dirname(file);
    const n = perDir.get(dir) ?? 0;
    if (n >= MAX_FILES_PER_DIR) continue;
    perDir.set(dir, n + 1);
    files.push(file);
  }
  return { available: true, files };
}

/** True when enough of the sampled files are code to count as an existing codebase. */
export function isCodebase(files: string[]): boolean {
  return files.filter((f) => CODE_FILE.test(f)).length >= EXISTING_CODEBASE_MIN_FILES;
}

export function isExistingCodebase(root: string): boolean {
  const sources = listStyleSources(root);
  if (!sources.available) return false;
  return isCodebase(sources.files);
}
