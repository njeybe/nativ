import { scanEnvReads } from '../env-reads.js';
import type { StyleRuleId } from './style-types.js';

/** nativ · Finds habits that break an AGENTS.md code style rule, by file text. */
export interface ConflictEvidence {
  rule: StyleRuleId;
  count: number;
  files: string[];
}

export interface SourceFile {
  path: string;
  text: string;
}

const MODEL_SEGMENTS = new Set([
  'models', 'repositories', 'db', 'database', 'dal', 'migrations', 'prisma', 'schema',
]);
const MIN_OCCURRENCES = 2;
const MAX_EVIDENCE_FILES = 3;

const SQL_LITERAL =
  /['"`]\s*(?:SELECT\s+[\w*(]|INSERT\s+INTO\s|UPDATE\s+\S+\s+SET\s|DELETE\s+FROM\s|CREATE\s+TABLE\s)/i;
const SQL_CALL = /\.query\(|\.connect\(|cursor\.execute\(/;

const SWALLOWED = [
  /\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*(?:\[\]|null|\{\}|''|"")\s*\)/,
  /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/,
  /^\s*except\s*:/m,
  /\bexcept\s+Exception(?:\s+as\s+\w+)?\s*:\s*(?:\r?\n\s*)?pass\b/,
];

/** True when any folder in the path is a model-layer folder. */
export function isModelLayerPath(file: string): boolean {
  const folders = file.split(/[\\/]/).slice(0, -1);
  return folders.some((p) => MODEL_SEGMENTS.has(p.toLowerCase()));
}

function hasRawSql(f: SourceFile): boolean {
  if (isModelLayerPath(f.path)) return false;
  return SQL_LITERAL.test(f.text) || SQL_CALL.test(f.text);
}

function hasSwallowedError(f: SourceFile): boolean {
  return SWALLOWED.some((re) => re.test(f.text));
}

function hasConfigFallback(f: SourceFile): boolean {
  return scanEnvReads(f.text, f.path).some((r) => r.fallback);
}

const DETECTORS: Record<StyleRuleId, (f: SourceFile) => boolean> = {
  'raw-sql': hasRawSql,
  'swallowed-errors': hasSwallowedError,
  'config-fallback': hasConfigFallback,
};

/** Rules with 2+ files showing the habit; evidence holds up to 3 sorted paths. */
export function detectConflicts(files: SourceFile[]): ConflictEvidence[] {
  const out: ConflictEvidence[] = [];
  for (const rule of Object.keys(DETECTORS) as StyleRuleId[]) {
    const hits = files.filter(DETECTORS[rule]).map((f) => f.path).sort();
    if (hits.length >= MIN_OCCURRENCES) {
      out.push({ rule, count: hits.length, files: hits.slice(0, MAX_EVIDENCE_FILES) });
    }
  }
  return out;
}
