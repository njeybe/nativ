/** nativ · Counts JS/TS style traits in one file. Pure: text in, counts out. */

export type TraitCounts = Record<string, Record<string, number>>;

const JS_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const REGEX_PREV = '(,=:[!&|?{};+-*%~^';
const REGEX_WORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw']);

interface Lexed {
  /** Same length as the source; strings, comments, regexes and templates blanked. */
  masked: string;
  /** String contents by the offset of their opening quote. */
  strings: Map<number, { quote: string; content: string }>;
}

function blank(s: string): string {
  return s.replace(/[^\n]/g, ' ');
}

function endOfString(t: string, i: number): number {
  let j = i + 1;
  while (j < t.length && t[j] !== t[i] && t[j] !== '\n') j += t[j] === '\\' ? 2 : 1;
  return t[j] === t[i] ? j : i;
}

function endOfTemplate(t: string, i: number): number {
  let j = i + 1;
  let depth = 0;
  while (j < t.length) {
    const c = t[j];
    if (c === '\\') j++;
    else if (c === '`' && depth === 0) return j;
    else if (c === '$' && t[j + 1] === '{') { depth++; j++; }
    else if (c === '}' && depth > 0) depth--;
    j++;
  }
  return t.length - 1;
}

function endOfRegex(t: string, i: number): number {
  let j = i + 1;
  let inClass = false;
  while (j < t.length && t[j] !== '\n') {
    const c = t[j];
    if (c === '\\') j++;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return j;
    j++;
  }
  return i;
}

function endOfLine(t: string, i: number): number {
  const nl = t.indexOf('\n', i);
  return nl < 0 ? t.length - 1 : nl - 1;
}

function endOfBlockComment(t: string, i: number): number {
  const close = t.indexOf('*/', i + 2);
  return close < 0 ? t.length - 1 : close + 1;
}

function lex(t: string): Lexed {
  const strings: Lexed['strings'] = new Map();
  const out: string[] = [];
  let prev = '';
  let word = '';
  let i = 0;
  // Blank t[i..end]; keep the quotes of strings so imports can still be found.
  const skip = (end: number, keepQuotes = false): void => {
    const piece = t.slice(i, end + 1);
    out.push(keepQuotes ? t[i] + blank(piece.slice(1, -1)) + t[end] : blank(piece));
    i = end + 1;
  };
  while (i < t.length) {
    const c = t[i];
    const two = t.slice(i, i + 2);
    if (two === '//') skip(endOfLine(t, i));
    else if (two === '/*') skip(endOfBlockComment(t, i));
    else if (c === '"' || c === "'") {
      const end = endOfString(t, i);
      if (end === i) { out.push(c); i++; continue; }
      strings.set(i, { quote: c, content: t.slice(i + 1, end) });
      skip(end, true);
      prev = c;
    } else if (c === '`') {
      skip(endOfTemplate(t, i), true);
      prev = c;
    } else if (c === '/' && (prev === '' || REGEX_PREV.includes(prev) || REGEX_WORDS.has(word))) {
      const end = endOfRegex(t, i);
      if (end === i) { out.push(c); prev = c; i++; continue; }
      skip(end);
      prev = ')';
    } else {
      out.push(c);
      if (!/\s/.test(c)) {
        word = /\w/.test(c) ? (/\w/.test(t[i - 1] ?? '') ? word + c : c) : '';
        prev = c;
      }
      i++;
    }
  }
  return { masked: out.join(''), strings };
}

function bump(counts: TraitCounts, trait: string, value: string, n = 1): void {
  if (n <= 0) return;
  counts[trait] ??= {};
  counts[trait][value] = (counts[trait][value] ?? 0) + n;
}

function count(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

/** Case shape of a name; null when a single plain word makes it ambiguous. */
function nameShape(name: string): 'kebab' | 'snake' | 'camel' | 'pascal' | null {
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(name)) return 'kebab';
  if (/^[A-Za-z0-9]+(_[A-Za-z0-9]+)+$/.test(name) && /[a-z]/.test(name)) return 'snake';
  if (/^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/.test(name)) return 'camel';
  if (/^[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*$/.test(name)) return 'pascal';
  return null;
}

function measureFileName(file: string, counts: TraitCounts): void {
  const last = file.split(/[\\/]/).pop() ?? '';
  const base = last.replace(JS_EXT, '').replace(/\.(test|spec)$/, '').split('.')[0];
  const shape = nameShape(base);
  if (shape) bump(counts, 'fileNaming', shape);
}

/** Indent unit from how far each line steps in past the one before. */
function measureIndent(lines: string[], counts: TraitCounts): void {
  let prev = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line[0] === '\t') { bump(counts, 'indent', 'tab'); prev = 0; continue; }
    const n = line.length - line.trimStart().length;
    if (n - prev === 2) bump(counts, 'indent', '2');
    else if (n - prev === 4) bump(counts, 'indent', '4');
    prev = n;
  }
}

function measureQuotes(lexed: Lexed, counts: TraitCounts): void {
  for (const { quote, content } of lexed.strings.values()) {
    if (/['"]/.test(content)) continue;
    bump(counts, 'quotes', quote === "'" ? 'single' : 'double');
  }
}

const STATEMENT = /^(const|let|var|return|throw|import|export|break|continue|await)\b/;
const CONTINUES = /^[.+\-*/?:&|,=(<>{]/;

// Only whole one-line statements vote, so multi-line expressions never look unfinished.
function measureSemicolons(lines: string[], counts: TraitCounts): void {
  const net = (s: string): number => count(s, /[([{]/g) - count(s, /[)\]}]/g);
  let depth = 0;
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k].trim();
    const startDepth = depth;
    depth += net(line);
    if (startDepth !== 0 || net(line) !== 0 || !STATEMENT.test(line)) continue;
    if (line.endsWith(';')) { bump(counts, 'semicolons', 'always'); continue; }
    const next = lines.slice(k + 1).find((l) => l.trim())?.trim() ?? '';
    if (/[\w)\]'"`]$/.test(line) && !CONTINUES.test(next)) bump(counts, 'semicolons', 'never');
  }
}

function isLiteralOpener(before: string, opener: string): boolean {
  if (opener === '[') return true;
  if (opener === '{') return /([=(,:[?]|&&|\|\||\breturn)$/.test(before);
  const call = /[\w)\]]$/.test(before);
  return call && !/\b(if|for|while|switch|catch|function)$/.test(before);
}

interface Opener { ch: string; line: number; literal: boolean }

// A multi-line literal or call whose closer opens its line: is the last item comma-ended?
function measureTrailingCommas(masked: string, counts: TraitCounts): void {
  const stack: Opener[] = [];
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '\n') { line++; lineStart = i + 1; }
    else if ('([{'.includes(c)) {
      const before = masked.slice(Math.max(0, i - 40), i).trimEnd();
      stack.push({ ch: c, line, literal: isLiteralOpener(before, c) });
    } else if (')]}'.includes(c)) {
      const open = stack.pop();
      if (!open || !open.literal || open.line === line) continue;
      if (masked.slice(lineStart, i).trim()) continue;
      const last = masked.slice(0, i).trimEnd().slice(-1);
      if (last === ',') bump(counts, 'trailingCommas', 'always');
      else if (/[\w)\]}'"`]/.test(last)) bump(counts, 'trailingCommas', 'never');
    }
  }
}

function functionShape(name: string): 'camel' | 'snake' | 'pascal' | null {
  if (/^[A-Z][a-z0-9]+[A-Z]?[A-Za-z0-9]*$/.test(name)) return 'pascal';
  if (/_/.test(name) && /[a-z]/.test(name)) return 'snake';
  if (/^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/.test(name)) return 'camel';
  return null;
}

const FN_DECL = /\bfunction\s*\*?\s+([A-Za-z_$][\w$]*)/g;
const FN_HEAD = String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s+)?`;
const FN_BODY = String.raw`(?:function\b|\([^)\n]*\)\s*(?::[^=\n]+)?=>|[A-Za-z_$][\w$]*\s*=>)`;
const FN_ARROW = new RegExp(FN_HEAD + FN_BODY, 'g');

function measureFunctions(masked: string, counts: TraitCounts): void {
  for (const re of [FN_DECL, FN_ARROW]) {
    for (const m of masked.matchAll(re)) {
      const shape = functionShape(m[1]);
      if (shape) bump(counts, 'functionNaming', shape);
    }
  }
}

function measureTypes(masked: string, counts: TraitCounts): void {
  const re = /\b(?:interface|class|enum|type)\s+([A-Za-z_$][\w$]*)\s*(?:<[^>\n]*>)?\s*(?:=|\{|extends|implements)/g;
  for (const m of masked.matchAll(re)) {
    bump(counts, 'typeNaming', /^[A-Z]/.test(m[1]) ? 'pascal' : 'camel');
  }
}

function braceDepths(masked: string): Uint16Array {
  const depths = new Uint16Array(masked.length);
  let d = 0;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === '}') d = Math.max(0, d - 1);
    depths[i] = d;
    if (masked[i] === '{') d++;
  }
  return depths;
}

const FN_VALUE = /^(async\b|function\b|\([^)]*\)\s*(:[^=]+)?=>|\w+\s*=>)/;

function measureConstants(masked: string, counts: TraitCounts): void {
  const depths = braceDepths(masked);
  const re = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*([^\n]*)/g;
  for (const m of masked.matchAll(re)) {
    if (depths[m.index] !== 0 || FN_VALUE.test(m[2])) continue;
    if (/^[A-Z][A-Z0-9_]+$/.test(m[1])) bump(counts, 'constantNaming', 'upper-snake');
    else if (/^[a-z][A-Za-z0-9]*$/.test(m[1])) bump(counts, 'constantNaming', 'camel');
  }
}

/** Module specifiers (imports, requires, dynamic imports) in source order. */
function specifiers(lexed: Lexed): string[] {
  const re = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(["'`])/g;
  const found: string[] = [];
  for (const m of lexed.masked.matchAll(re)) {
    const str = lexed.strings.get(m.index + m[0].length - 1);
    if (str) found.push(str.content);
  }
  return found;
}

function measureImports(lexed: Lexed, counts: TraitCounts): void {
  for (const spec of specifiers(lexed)) {
    if (spec.startsWith('.')) {
      bump(counts, 'importStyle', 'relative');
      if (/\.[cm]?jsx?$/.test(spec)) bump(counts, 'importSuffix', 'js');
      else if (!/\.\.?$/.test(spec) && !/\.(json|css|scss|svg|png|html)$/.test(spec)) {
        bump(counts, 'importSuffix', 'none');
      }
    } else if (/^(@\/|~|#|\$)/.test(spec)) bump(counts, 'importStyle', 'alias');
  }
}

/** One vote per file: the side with more evidence, nothing on a tie. */
function vote(counts: TraitCounts, trait: string, a: [string, number], b: [string, number]): void {
  if (a[1] > b[1]) bump(counts, trait, a[0]);
  else if (b[1] > a[1]) bump(counts, trait, b[0]);
}

function measureModules(masked: string, counts: TraitCounts): void {
  const esm = count(masked, /^\s*(import\s*[\w{*'"]|export\s)/gm);
  const cjs = count(masked, /\brequire\s*\(|\bmodule\.exports\b|\bexports\.\w+\s*=/g);
  vote(counts, 'moduleSystem', ['esm', esm], ['cjs', cjs]);
  const def = count(masked, /\bexport\s+default\b|\bmodule\.exports\s*=/g);
  const named = count(
    masked,
    /\bexport\s+(?!default\b)(?:\w|\{|\*)|\bmodule\.exports\.\w+|\bexports\.\w+\s*=/g,
  );
  vote(counts, 'exportStyle', ['default', def], ['named', named]);
}

function measureFlow(masked: string, counts: TraitCounts): void {
  bump(counts, 'asyncStyle', 'await', count(masked, /\bawait\b/g));
  bump(counts, 'asyncStyle', 'then', count(masked, /\.then\s*\(/g));
  bump(counts, 'errorStyle', 'try-catch', count(masked, /\btry\s*\{/g));
  bump(counts, 'errorStyle', 'promise-catch', count(masked, /\.catch\s*\(/g));
}

/** Counts per trait value for a JS/TS file; empty for other file types. */
export function measureJs(file: string, text: string): TraitCounts {
  const counts: TraitCounts = {};
  if (!JS_EXT.test(file)) return counts;
  const lexed = lex(text);
  const { masked } = lexed;
  measureFileName(file, counts);
  measureIndent(masked.split('\n'), counts);
  measureQuotes(lexed, counts);
  measureSemicolons(masked.split('\n'), counts);
  measureTrailingCommas(masked, counts);
  measureFunctions(masked, counts);
  measureTypes(masked, counts);
  measureConstants(masked, counts);
  measureImports(lexed, counts);
  measureModules(masked, counts);
  measureFlow(masked, counts);
  return counts;
}
