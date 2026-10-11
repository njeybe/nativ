export const DESIGN_PROFILES = ['taste-v1', 'taste-v2'] as const;
export type DesignProfile = (typeof DESIGN_PROFILES)[number];

export interface DesignFinding {
  line: number;
  column: number;
  rule: string;
  severity: 'error' | 'warning';
  message: string;
}

interface Rule {
  id: string;
  profiles: readonly DesignProfile[];
  severity: 'error' | 'warning';
  message: string;
  pattern?: RegExp;
  exts?: readonly string[];
}

const TASTE: readonly DesignProfile[] = ['taste-v1', 'taste-v2'];

export const DESIGN_RULES: readonly Rule[] = [
  {
    id: 'no-emoji', profiles: DESIGN_PROFILES, severity: 'error',
    message: 'Emoji found; use an icon from the catalog',
    pattern: /\p{Extended_Pictographic}/gu,
  },
  {
    id: 'no-em-dash', profiles: ['taste-v2'], severity: 'error',
    message: 'Em or en dash found; use a comma, colon or hyphen',
    pattern: /[–—]/g,
  },
  {
    id: 'no-h-screen', profiles: TASTE, severity: 'error',
    message: 'h-screen found; use min-h-[100dvh]',
    pattern: /(?<![\w-])h-screen(?![\w-])/g,
  },
  {
    id: 'no-scroll-listener', profiles: TASTE, severity: 'error',
    message: 'Scroll listener found; use IntersectionObserver or CSS',
    pattern: /addEventListener\(\s*['"`]scroll['"`]/g,
  },
  {
    id: 'no-pure-black', profiles: TASTE, severity: 'warning',
    message: 'Pure black found; use an off-black token',
    pattern: /#000(?:000)?(?![0-9a-fA-F])|rgba?\(\s*0\s*,\s*0\s*,\s*0\s*[,)]/g,
  },
  {
    id: 'no-google-fonts-link', profiles: ['taste-v2'], severity: 'warning',
    message: 'Google Fonts link found; self-host the font',
    pattern: /fonts\.googleapis\.com/g,
  },
  {
    id: 'no-custom-cursor', profiles: TASTE, severity: 'warning',
    message: 'Custom cursor found',
    pattern: /cursor:\s*url\(|cursor-\[url/g,
  },
  {
    id: 'no-hand-rolled-icon', profiles: TASTE, severity: 'warning',
    message: 'Inline svg with a path; use an icon from the catalog',
    exts: ['.tsx', '.jsx'],
  },
];

export const SCAN_EXTENSIONS = [
  '.tsx', '.jsx', '.ts', '.js', '.html', '.vue', '.svelte', '.astro', '.mdx', '.css',
];

const PROFILE_LINE = /^- \*\*Profile:\*\*\s*(taste-v1|taste-v2)\s*$/m;

export function readProfile(uiSpecsText: string): DesignProfile | null {
  const m = PROFILE_LINE.exec(uiSpecsText);
  return m ? (m[1] as DesignProfile) : null;
}

export function isCommentLine(line: string): boolean {
  const t = line.trim();
  return ['//', '/*', '*', '{/*', '<!--'].some((p) => t.startsWith(p));
}

function active(profile: DesignProfile, ext: string): Rule[] {
  return DESIGN_RULES.filter(
    (r) => r.profiles.includes(profile) && (!r.exts || r.exts.includes(ext)),
  );
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function locate(starts: number[], index: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: index - starts[lo] + 1 };
}

function svgFindings(text: string, rule: Rule, starts: number[], lines: string[]) {
  const out: DesignFinding[] = [];
  const re = /<svg\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = text.indexOf('</svg>', m.index);
    const body = text.slice(m.index, end === -1 ? text.length : end);
    const pos = locate(starts, m.index);
    if (/<path\b/.test(body) && !isCommentLine(lines[pos.line - 1])) {
      out.push({ ...pos, rule: rule.id, severity: rule.severity, message: rule.message });
    }
  }
  return out;
}

export function checkText(text: string, ext: string, profile: DesignProfile): DesignFinding[] {
  const rules = active(profile, ext);
  const lines = text.split('\n');
  const starts = lineStarts(text);
  const found: DesignFinding[] = [];
  for (const rule of rules) {
    if (!rule.pattern) {
      found.push(...svgFindings(text, rule, starts, lines));
      continue;
    }
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      for (const m of line.matchAll(rule.pattern as RegExp)) {
        found.push({
          line: i + 1, column: (m.index ?? 0) + 1,
          rule: rule.id, severity: rule.severity, message: rule.message,
        });
      }
    });
  }
  return found.sort((a, b) => a.line - b.line || a.column - b.column);
}
