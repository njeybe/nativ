import fs from 'node:fs';
import path from 'node:path';

export interface SpecSlice {
  ref: string;
  /** Path relative to the project root, forward slashes (e.g. ".ai/ui_specs.md"). */
  file: string;
  text: string;
  truncated: boolean;
}

export interface SpecSliceResult {
  slices: SpecSlice[];
  warnings: string[];
}

export interface SpecSliceOptions {
  /** Cap per slice (default 4000 characters). */
  maxChars?: number;
  /** Cap across all slices (default 4x maxChars). */
  maxTotalChars?: number;
}

export const DEFAULT_SLICE_CHARS = 4000;
export const TRUNCATION_MARKER = '\n[... truncated ...]';

/** GitHub-style heading slug: lowercase, drop punctuation, spaces to hyphens. */
export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

function cap(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, Math.max(0, max)) + TRUNCATION_MARKER, truncated: true };
}

function findSection(
  lines: string[],
  predicate: (slug: string, headingText: string) => boolean
): string | null {
  const seen = new Map<string, number>();
  let inFence = false;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const hLevel = m[1].length;
    if (start >= 0) {
      if (hLevel <= level) return lines.slice(start, i).join('\n').trimEnd();
      continue;
    }
    const headingText = m[2];
    const base = slugifyHeading(headingText);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const slug = count === 0 ? base : `${base}-${count}`;
    if (predicate(slug, headingText)) {
      start = i;
      level = hLevel;
    }
  }
  return start >= 0 ? lines.slice(start).join('\n').trimEnd() : null;
}

function markdownSection(content: string, anchor: string): string | null {
  const wanted = decodeURIComponent(anchor).trim().toLowerCase();
  const lines = content.split(/\r?\n/);

  // 1. Exact slug match (standard markdown anchor)
  const exact = findSection(lines, (slug) => slug === wanted);
  if (exact !== null) return exact;

  // 2. Prefix / section number match (e.g. "6" or "15.1" matching "## 6. Coach..." or "### 15.1 Shared Pieces")
  const prefixMatch = findSection(lines, (_slug, headingText) => {
    const raw = headingText.trim().toLowerCase();
    if (raw === wanted) return true;
    if (raw.startsWith(`${wanted}.`) || raw.startsWith(`${wanted} `) || raw.startsWith(`${wanted}:`)) return true;
    const base = slugifyHeading(headingText);
    if (base.startsWith(`${wanted}-`) || base === wanted) return true;
    return false;
  });
  if (prefixMatch !== null) return prefixMatch;

  return null;
}

function jsonPointerValue(doc: unknown, pointer: string): { found: boolean; value?: unknown } {
  if (pointer === '') return { found: true, value: doc };
  if (!pointer.startsWith('/')) return { found: false };
  let current: any = doc;
  for (const raw of pointer.slice(1).split('/')) {
    let token: string;
    try {
      token = decodeURIComponent(raw);
    } catch {
      token = raw;
    }
    token = token.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(token) || Number(token) >= current.length) return { found: false };
      current = current[Number(token)];
    } else if (current && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, token)) {
      current = current[token];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

function getByDotPath(obj: any, pathStr: string): { found: boolean; value?: unknown } {
  const parts = pathStr.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, p)) {
      cur = cur[p];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: cur };
}

function findEntityInDoc(doc: any, ref: string): { found: boolean; value?: unknown } {
  if (!doc || typeof doc !== 'object') return { found: false };

  // 1. Direct table match in relevantTables or tables
  const tables = Array.isArray(doc.relevantTables) ? doc.relevantTables : (Array.isArray(doc.tables) ? doc.tables : null);
  if (tables) {
    const table = tables.find((t: any) => t && (t.name === ref || t.tableName === ref || t.id === ref));
    if (table) return { found: true, value: table };
  }
  if (doc.tables && typeof doc.tables === 'object' && !Array.isArray(doc.tables) && Object.prototype.hasOwnProperty.call(doc.tables, ref)) {
    return { found: true, value: doc.tables[ref] };
  }

  // 2. Mail events trigger match
  if (Array.isArray(doc.mailEvents)) {
    const event = doc.mailEvents.find((m: any) => m && (m.trigger === ref || m.endpoint === ref || m.id === ref));
    if (event) return { found: true, value: event };
  }

  // 3. Routes match in routingPolicy or routes
  const routeLists: any[][] = [];
  if (doc.routingPolicy && typeof doc.routingPolicy === 'object') {
    if (Array.isArray(doc.routingPolicy.playerRoutes)) routeLists.push(doc.routingPolicy.playerRoutes);
    if (Array.isArray(doc.routingPolicy.venueScopedRoutes)) routeLists.push(doc.routingPolicy.venueScopedRoutes);
    if (Array.isArray(doc.routingPolicy.adminRoutes)) routeLists.push(doc.routingPolicy.adminRoutes);
    if (Array.isArray(doc.routingPolicy.routes)) routeLists.push(doc.routingPolicy.routes);
  }
  if (Array.isArray(doc.routes)) routeLists.push(doc.routes);

  for (const list of routeLists) {
    const route = list.find((r: any) => r && (
      r.name === ref ||
      r.id === ref ||
      (Array.isArray(r.routeNames) && r.routeNames.includes(ref))
    ));
    if (route) return { found: true, value: route };
  }

  // 4. Contract list items (e.g. confirmationPageContracts array)
  for (const key of Object.keys(doc)) {
    const val = doc[key];
    if (Array.isArray(val)) {
      const match = val.find((item: any) => item && typeof item === 'object' && (
        item.name === ref ||
        item.id === ref ||
        item.trigger === ref ||
        (Array.isArray(item.routeNames) && item.routeNames.includes(ref))
      ));
      if (match) return { found: true, value: match };
    }
  }

  return { found: false };
}

function joinUrl(base: unknown, p: string): string {
  return typeof base === 'string' ? base.replace(/\/+$/, '') + p : p;
}

/** Finds an endpoint by "GET /path" (with or without baseUrl) or by its id. */
function endpointValue(doc: any, fragment: string): { found: boolean; value?: unknown } {
  let ref = fragment;
  try {
    ref = decodeURIComponent(fragment);
  } catch {
    // keep the raw text when it is not valid percent-encoding
  }
  ref = ref.trim();
  const call = /^([A-Za-z]+)\s+(\/\S*)$/.exec(ref);
  const list: any[] = Array.isArray(doc?.endpoints) ? doc.endpoints : [];
  if (call) {
    const method = call[1].toLowerCase();
    const want = call[2];
    const hit = list.find((e) => {
      if (!e || typeof e.path !== 'string' || String(e.method).toLowerCase() !== method) return false;
      return e.path === want || joinUrl(doc.baseUrl, e.path) === want;
    });
    if (hit) return { found: true, value: hit };
    const item = doc?.paths && typeof doc.paths === 'object' ? doc.paths[want] : undefined;
    if (item && typeof item === 'object' && Object.prototype.hasOwnProperty.call(item, method)) {
      return { found: true, value: item[method] };
    }
    return { found: false };
  }
  const byId = list.find((e) => e && typeof e.id === 'string' && e.id === ref);
  return byId ? { found: true, value: byId } : { found: false };
}

function jsonRefValue(doc: unknown, fragment: string): { found: boolean; value?: unknown } {
  if (fragment === '') return jsonPointerValue(doc, fragment);

  // 1. Direct JSON pointer starting with /
  if (fragment.startsWith('/')) {
    const ptr = jsonPointerValue(doc, fragment);
    if (ptr.found) return ptr;
  } else {
    // 2. JSON pointer or top-level property without leading slash (e.g. #confirmationPageContracts)
    const ptr = jsonPointerValue(doc, `/${fragment}`);
    if (ptr.found) return ptr;

    // 3. Dot-path property navigation (e.g. #contract.section)
    if (fragment.includes('.')) {
      const dot = getByDotPath(doc, fragment);
      if (dot.found) return dot;
    }
  }

  // 4. Endpoint lookup by method + path or id
  const endpoint = endpointValue(doc, fragment);
  if (endpoint.found) return endpoint;

  // 5. Named entity lookup: route names, mail event triggers, DB schema tables
  return findEntityInDoc(doc, fragment);
}

/**
 * Resolves specRefs ("ui_specs.md#anchor", "api_contracts.json#/paths/~1x",
 * "api_contracts.json#GET /x" or "api_contracts.json#<endpoint id>") relative to
 * <root>/.ai into size-capped slices. Unresolvable refs produce a warning and no slice.
 */
export function resolveSpecSlices(root: string, specRefs: string[] | undefined, options: SpecSliceOptions = {}): SpecSliceResult {
  const slices: SpecSlice[] = [];
  const warnings: string[] = [];
  const maxChars = options.maxChars ?? DEFAULT_SLICE_CHARS;
  const maxTotal = options.maxTotalChars ?? maxChars * 4;
  const aiDir = path.resolve(root, '.ai');
  let total = 0;

  for (const ref of specRefs ?? []) {
    if (typeof ref !== 'string' || !ref.trim()) continue;
    const hash = ref.indexOf('#');
    const filePart = (hash >= 0 ? ref.slice(0, hash) : ref).trim();
    const fragment = hash >= 0 ? ref.slice(hash + 1) : '';

    const full = path.resolve(aiDir, filePart);
    const rel = path.relative(aiDir, full);
    if (!filePart || rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      warnings.push(`specRef "${ref}" points outside .ai/ and was ignored`);
      continue;
    }
    let content: string;
    try {
      content = fs.readFileSync(full, 'utf8');
    } catch {
      warnings.push(`specRef "${ref}": file .ai/${rel.split(path.sep).join('/')} not found`);
      continue;
    }

    let body: string | null;
    if (/\.json$/i.test(filePart)) {
      try {
        const found = jsonRefValue(JSON.parse(content), fragment);
        body = found.found ? JSON.stringify(found.value, null, 2) ?? 'null' : null;
      } catch {
        warnings.push(`specRef "${ref}": .ai/${rel.split(path.sep).join('/')} is not valid JSON`);
        continue;
      }
      if (body === null) {
        warnings.push(`specRef "${ref}": JSON reference "${fragment}" not found`);
        continue;
      }
    } else if (fragment) {
      try {
        body = markdownSection(content, fragment);
      } catch {
        body = null;
      }
      if (body === null) {
        warnings.push(`specRef "${ref}": heading anchor "#${fragment}" not found`);
        continue;
      }
    } else {
      body = content;
    }

    const remaining = maxTotal - total;
    if (remaining <= 0) {
      warnings.push(`specRef "${ref}" omitted: total spec slice budget (${maxTotal} characters) exhausted`);
      continue;
    }
    const capped = cap(body, Math.min(maxChars, remaining));
    total += capped.text.length;
    slices.push({ ref, file: `.ai/${rel.split(path.sep).join('/')}`, text: capped.text, truncated: capped.truncated });
  }

  return { slices, warnings };
}
