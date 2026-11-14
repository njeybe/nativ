// Counts Python style traits in one file. Pure: no file system or git access.

export type TraitCounts = Record<string, Record<string, number>>;

const TRAITS = [
  'indent', 'quotes', 'fileNaming', 'functionNaming',
  'classNaming', 'constantNaming', 'importStyle', 'typeHints',
] as const;

function bump(counts: TraitCounts, trait: string, value: string): void {
  counts[trait][value] = (counts[trait][value] ?? 0) + 1;
}

// Name style of an identifier, or null when it is one word and says nothing.
function nameCase(raw: string): 'kebab' | 'snake' | 'camel' | 'pascal' | null {
  const name = raw.replace(/^_+|_+$/g, '');
  if (name.includes('-')) return 'kebab';
  if (name.includes('_')) return 'snake';
  if (!/[a-z]/.test(name) || !/[A-Z]/.test(name)) return null;
  if (/^[A-Z]/.test(name)) return /^[A-Z][a-z0-9]*$/.test(name) ? null : 'pascal';
  return 'camel';
}

interface Masked { code: string; quotes: Array<'single' | 'double'> }

function skipString(text: string, start: number, delim: string): number {
  let i = start + delim.length;
  while (i < text.length && !text.startsWith(delim, i)) {
    if (text[i] === '\\') i++;
    else if (delim.length === 1 && text[i] === '\n') return i;
    i++;
  }
  return Math.min(text.length, i + delim.length);
}

// Blanks strings and comments; records the quote of each plain, non-docstring string.
function mask(text: string): Masked {
  const out: string[] = [];
  const quotes: Masked['quotes'] = [];
  let depth = 0;
  let lineStart = true;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '#') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    const prefix = /^[rRbBuUfF]{0,2}(?=['"])/.exec(text.slice(i, i + 3))?.[0];
    const prev = out.length ? out[out.length - 1] : '';
    if (prefix !== undefined && !/[A-Za-z0-9_]/.test(prev.slice(-1))) {
      const q = text[i + prefix.length];
      const triple = text.startsWith(q.repeat(3), i + prefix.length);
      const end = skipString(text, i + prefix.length, triple ? q.repeat(3) : q);
      if (!triple && !(lineStart && depth === 0)) quotes.push(q === "'" ? 'single' : 'double');
      out.push(text.slice(i, end).replace(/[^\n]/g, ' '));
      lineStart = false;
      i = end;
      continue;
    }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
    if (c === '\n') lineStart = depth === 0;
    else if (c !== ' ' && c !== '\t') lineStart = false;
    out.push(c);
    i++;
  }
  return { code: out.join(''), quotes };
}

function countIndent(lines: string[], counts: TraitCounts): void {
  let depth = 0;
  let prev = 0;
  for (const line of lines) {
    const startsDepth0 = depth === 0;
    for (const ch of line) {
      if ('([{'.includes(ch)) depth++;
      if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
    }
    if (!startsDepth0 || !line.trim()) continue;
    const lead = /^[ \t]*/.exec(line)![0];
    if (lead.startsWith('\t')) {
      if (prev === 0) bump(counts, 'indent', 'tab');
      prev = lead.length * 8;
      continue;
    }
    const delta = lead.length - prev;
    if (delta === 2) bump(counts, 'indent', '2');
    if (delta === 4) bump(counts, 'indent', '4');
    prev = lead.length;
  }
}

// Parameter list text of a def, from the "(" at open to its match.
function params(code: string, open: number): { list: string; end: number } {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if ('([{'.includes(code[i])) depth++;
    if (')]}'.includes(code[i]) && --depth === 0) return { list: code.slice(open + 1, i), end: i };
  }
  return { list: code.slice(open + 1), end: code.length };
}

function hasAnnotation(list: string, after: string): boolean {
  if (/^\s*->/.test(after)) return true;
  let depth = 0;
  let param = '';
  const parts: string[] = [];
  for (const ch of list + ',') {
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      parts.push(param);
      param = '';
    } else param += ch;
  }
  return parts.some((p) => /^\s*\*{0,2}[A-Za-z_]\w*\s*:/.test(p));
}

function countDefs(code: string, counts: TraitCounts): void {
  for (const m of code.matchAll(/^[ \t]*(?:async\s+)?def\s+(\w+)\s*\(/gm)) {
    const fn = m[1];
    if (!/^__\w+__$/.test(fn)) {
      const style = nameCase(fn);
      if (style && style !== 'kebab') bump(counts, 'functionNaming', style);
    }
    const { list, end } = params(code, m.index! + m[0].length - 1);
    bump(counts, 'typeHints', hasAnnotation(list, code.slice(end + 1, end + 8)) ? 'yes' : 'no');
  }
}

function countLines(code: string, counts: TraitCounts): void {
  for (const m of code.matchAll(/^[ \t]*class\s+(\w+)/gm)) {
    const pascal = /^[A-Z][A-Za-z0-9]*$/.test(m[1].replace(/^_+/, ''));
    bump(counts, 'classNaming', pascal ? 'pascal' : 'other');
  }
  for (const m of code.matchAll(/^([A-Za-z_]\w*)\s*(?::[^=\n]+)?=(?!=)/gm)) {
    if (/^__\w+__$/.test(m[1])) continue;
    bump(counts, 'constantNaming', /^[A-Z][A-Z0-9_]*$/.test(m[1]) ? 'upper-snake' : 'other');
  }
  for (const m of code.matchAll(/^[ \t]*(?:from\s+(\.*)\S*\s+import|import\s+\S)/gm)) {
    bump(counts, 'importStyle', m[1] ? 'relative' : 'absolute');
  }
}

function fileStem(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? '';
  return base.replace(/\.py$/, '').replace(/\.(test|spec)$/, '');
}

/** Counts per trait value for every Python trait; file-level traits count once. */
export function measurePython(file: string, text: string): TraitCounts {
  const counts: TraitCounts = {};
  for (const t of TRAITS) counts[t] = {};
  const { code, quotes } = mask(text);
  const fileStyle = nameCase(fileStem(file));
  if (fileStyle) bump(counts, 'fileNaming', fileStyle);
  for (const q of quotes) bump(counts, 'quotes', q);
  countIndent(code.split('\n'), counts);
  countDefs(code, counts);
  countLines(code, counts);
  return counts;
}
