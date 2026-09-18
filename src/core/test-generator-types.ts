/**
 * Contract-to-test generator types (nativ test gen).
 * Result/request shapes conform to POST /api/tests/generate in .ai/api_contracts.json.
 * Endpoint suites are built from .ai/api_contracts.json, database integrity suites from .ai/db_schema.json.
 */

import type { DatabaseEngine, TableSchema } from '../db/types.js';

// ─── Frameworks & options ──────────────────────────────────────────────────

export type TestFramework = 'vitest' | 'jest' | 'node:test' | 'pytest' | 'go';

export const TEST_FRAMEWORKS: readonly TestFramework[] = ['vitest', 'jest', 'node:test', 'pytest', 'go'];

export function isTestFramework(value: string): value is TestFramework {
  return (TEST_FRAMEWORKS as readonly string[]).includes(value);
}

export type TestLanguage = 'typescript' | 'javascript' | 'python' | 'go';

/** Kinds of generated suite; serialized as `suiteType` on each generated file. */
export type TestSuiteType = 'api-contract' | 'db-integrity' | 'support';

export const DEFAULT_TEST_OUTPUT_DIR = 'tests/contract';
export const DEFAULT_TEST_FRAMEWORK: TestFramework = 'vitest';
export const DEFAULT_TEST_BASE_URL = 'http://localhost:3000';

/** POST /api/tests/generate request body. */
export interface TestGenerateRequest {
  outputDir?: string;
  framework?: TestFramework;
  baseUrl?: string;
  dryRun?: boolean;
}

/** Options accepted by the generator (CLI flags, studio endpoint, MCP tool). */
export interface TestGenOptions extends TestGenerateRequest {
  /** Project root containing the .ai/ directory. */
  targetDir: string;
}

/** TestGenOptions with every default applied. */
export interface ResolvedTestGenOptions {
  targetDir: string;
  outputDir: string;
  framework: TestFramework;
  baseUrl: string;
  dryRun: boolean;
}

export interface GeneratedTestFile {
  /** Path relative to outputDir, forward slashes. */
  relativePath: string;
  content: string;
  suiteType: TestSuiteType;
}

/** POST /api/tests/generate response body. */
export interface TestGenResult {
  projectName: string;
  framework: TestFramework;
  outputDir: string;
  files: GeneratedTestFile[];
  endpointsCovered: number;
  tablesCovered: number;
  durationMs: number;
}

// ─── Contract documents (.ai/*.json) ───────────────────────────────────────

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * A field in a contract body is either a nested object of fields or a descriptor string
 * such as "string ('dev' | 'prod')", "integer (optional, default 1)" or "array of TableSchema".
 */
export type ContractFieldValue = string | null | { [field: string]: ContractFieldValue };

export interface ApiEndpointRequest {
  headers?: Record<string, string>;
  queryParams?: Record<string, string>;
  pathParams?: Record<string, string>;
  body?: ContractFieldValue;
}

export interface ApiEndpointResponse {
  description?: string;
  body?: ContractFieldValue;
}

export interface ApiEndpointContract {
  id: string;
  path: string;
  method: HttpMethod;
  description?: string;
  auth: boolean;
  request: ApiEndpointRequest;
  /** Keyed by HTTP status code ("200", "400", ...). */
  responses: Record<string, ApiEndpointResponse>;
}

export interface ApiContractsDocument {
  version?: string;
  projectName: string;
  baseUrl?: string;
  authScheme?: string;
  endpoints: ApiEndpointContract[];
}

export interface DbSchemaDocument {
  version?: string;
  projectName: string;
  engine: DatabaseEngine;
  tables: TableSchema[];
}

// ─── Schema nodes (parsed contract descriptors) ───────────────────────────

export type PrimitiveKind = 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'any';

interface SchemaNodeBase {
  /** Field may be absent ("optional", "required if ..."). */
  optional?: boolean;
  /** Condition from "required if <expr>" descriptors, kept verbatim. */
  requiredIf?: string;
  /** Free-text parenthetical from the descriptor, e.g. "default 1" or "e.g. 'MONGO_URI'". */
  note?: string;
}

export interface PrimitiveNode extends SchemaNodeBase {
  kind: 'primitive';
  type: PrimitiveKind;
}

export interface EnumNode extends SchemaNodeBase {
  kind: 'enum';
  base: 'string' | 'number';
  values: Array<string | number>;
}

export interface ObjectNode extends SchemaNodeBase {
  kind: 'object';
  /** Empty with `open: true` for untyped "object" descriptors. */
  properties: Record<string, SchemaNode>;
  open: boolean;
}

export interface ArrayNode extends SchemaNodeBase {
  kind: 'array';
  items: SchemaNode;
}

export interface UnionNode extends SchemaNodeBase {
  kind: 'union';
  variants: SchemaNode[];
}

/** Named model such as TableSchema or TableDiff; checked structurally as an object. */
export interface RefNode extends SchemaNodeBase {
  kind: 'ref';
  name: string;
}

export type SchemaNode = PrimitiveNode | EnumNode | ObjectNode | ArrayNode | UnionNode | RefNode;

const PRIMITIVES: Record<string, PrimitiveKind> = {
  string: 'string',
  number: 'number',
  integer: 'integer',
  int: 'integer',
  boolean: 'boolean',
  bool: 'boolean',
  null: 'null',
  any: 'any',
  unknown: 'any',
};

/** Splits on `separator` only outside (), {}, [] and quotes. */
function splitTopLevel(input: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    else if (depth === 0 && input.startsWith(separator, i)) {
      parts.push(input.slice(start, i));
      start = i + separator.length;
      i += separator.length - 1;
    }
  }
  parts.push(input.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Separates "head (note)" when the parenthetical is top-level and trailing. */
function splitNote(descriptor: string): { head: string; note: string | null } {
  if (!descriptor.endsWith(')')) return { head: descriptor, note: null };
  let depth = 0;
  for (let i = descriptor.length - 1; i >= 0; i--) {
    const ch = descriptor[i];
    if (ch === ')') depth++;
    else if (ch === '(') {
      depth--;
      if (depth === 0) {
        const head = descriptor.slice(0, i).trim();
        return head ? { head, note: descriptor.slice(i + 1, -1).trim() } : { head: descriptor, note: null };
      }
    }
  }
  return { head: descriptor, note: null };
}

const LITERAL_UNION = /^(?:'[^']*'|-?\d+(?:\.\d+)?)(?:\s*\|\s*(?:'[^']*'|-?\d+(?:\.\d+)?))*$/;

function parseLiteral(token: string): string | number {
  const t = token.trim();
  return t.startsWith("'") ? t.slice(1, -1) : Number(t);
}

function parseHead(head: string): SchemaNode {
  const variants = splitTopLevel(head, '|');
  if (variants.length > 1) {
    return { kind: 'union', variants: variants.map((v) => parseHead(v)) };
  }

  const h = head.trim();
  const arrayMatch = /^array of\s+(.+)$/i.exec(h);
  if (arrayMatch) return { kind: 'array', items: parseHead(arrayMatch[1]) };
  if (h.endsWith('[]')) return { kind: 'array', items: parseHead(h.slice(0, -2)) };

  if (h.startsWith('{') && h.endsWith('}')) return parseInlineObject(h.slice(1, -1));
  if (/^object$/i.test(h)) return { kind: 'object', properties: {}, open: true };

  if (LITERAL_UNION.test(h)) {
    const value = parseLiteral(h);
    return { kind: 'enum', base: typeof value === 'number' ? 'number' : 'string', values: [value] };
  }

  const primitive = PRIMITIVES[h.toLowerCase()];
  if (primitive) return { kind: 'primitive', type: primitive };
  if (/^[A-Z][A-Za-z0-9_]*$/.test(h)) return { kind: 'ref', name: h };
  return { kind: 'primitive', type: 'any', note: h };
}

/** Parses "key: type, key2: 'a' | 'b'" (the inside of an inline `{ ... }` descriptor). */
function parseInlineObject(body: string): ObjectNode {
  const properties: Record<string, SchemaNode> = {};
  for (const entry of splitTopLevel(body, ',')) {
    const colon = entry.indexOf(':');
    if (colon === -1) continue;
    let key = entry.slice(0, colon).trim();
    const optional = key.endsWith('?');
    if (optional) key = key.slice(0, -1).trim();
    const node = parseFieldDescriptor(entry.slice(colon + 1).trim());
    properties[key] = optional ? { ...node, optional: true } : node;
  }
  return { kind: 'object', properties, open: false };
}

/** Collapses "T | null" style unions of literals into one enum node. */
function mergeLiteralUnion(node: SchemaNode): SchemaNode {
  if (node.kind !== 'union' || !node.variants.every((v) => v.kind === 'enum')) return node;
  const values = node.variants.flatMap((v) => (v as EnumNode).values);
  const base = values.every((v) => typeof v === 'number') ? 'number' : 'string';
  return { kind: 'enum', base, values };
}

/**
 * Parses a contract descriptor string into a SchemaNode.
 * Examples: "boolean", "string | null", "integer (optional, default 25, max 100)",
 * "string ('dev' | 'prod')", "boolean (required if env === 'prod')", "array of TableSchema",
 * "array of { key: string, targetEnv: 'dev' | 'prod' }".
 */
export function parseFieldDescriptor(descriptor: string): SchemaNode {
  const { head, note } = splitNote(descriptor.trim());
  let node = mergeLiteralUnion(parseHead(head));
  if (note === null) return node;

  const extras: SchemaNodeBase = {};
  let rest = note;

  const requiredIf = /^required if\s+(.+)$/i.exec(rest);
  if (requiredIf) {
    extras.optional = true;
    extras.requiredIf = requiredIf[1].trim();
    rest = '';
  } else if (/^optional\b/i.test(rest)) {
    extras.optional = true;
    rest = rest.replace(/^optional\b\s*[:,]?\s*/i, '');
  }

  // "string ('dev' | 'prod')" or "string (optional: 'asc' | 'desc')" narrows to an enum.
  if (rest && LITERAL_UNION.test(rest) && (node.kind === 'primitive' || node.kind === 'enum')) {
    const values = splitTopLevel(rest, '|').map(parseLiteral);
    const base = values.every((v) => typeof v === 'number') ? 'number' : 'string';
    node = { kind: 'enum', base, values };
    rest = '';
  }

  if (rest) extras.note = node.note ? `${node.note}; ${rest}` : rest;
  return { ...node, ...extras } as SchemaNode;
}

/** Builds a SchemaNode from a contract body value (nested objects, descriptor strings, or null). */
export function buildSchemaNode(value: ContractFieldValue | undefined): SchemaNode {
  if (value === null || value === undefined) return { kind: 'primitive', type: 'null' };
  if (typeof value === 'string') return parseFieldDescriptor(value);
  const properties: Record<string, SchemaNode> = {};
  for (const [key, child] of Object.entries(value)) {
    properties[key] = buildSchemaNode(child);
  }
  return { kind: 'object', properties, open: false };
}

/** True when a schema node accepts null (nullable union or explicit null). */
export function isNullableNode(node: SchemaNode): boolean {
  if (node.kind === 'primitive') return node.type === 'null' || node.type === 'any';
  if (node.kind === 'union') return node.variants.some(isNullableNode);
  return false;
}

// ─── Framework-agnostic test model ─────────────────────────────────────────

export type TestCaseKind =
  | 'route'
  | 'auth-required'
  | 'invalid-payload'
  | 'response-schema'
  | 'table-exists'
  | 'column'
  | 'primary-key'
  | 'nullability'
  | 'unique-constraint';

export interface TestRequestSpec {
  method: HttpMethod;
  /** Contract path with `:param` placeholders filled from pathParams. */
  path: string;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  body?: unknown;
}

export type TestAssertion =
  | { kind: 'status'; expected: number | number[] }
  | { kind: 'response-shape'; schema: SchemaNode }
  | { kind: 'table-exists'; table: string }
  | { kind: 'column-exists'; table: string; column: string; type: string }
  | { kind: 'primary-key'; table: string; columns: string[] }
  | { kind: 'nullability'; table: string; column: string; nullable: boolean }
  | { kind: 'unique-constraint'; table: string; index: string; columns: string[] };

export interface TestCaseSpec {
  /** Stable id, e.g. "db-status:route". */
  id: string;
  name: string;
  kind: TestCaseKind;
  /** Present for endpoint cases; absent for database integrity cases. */
  request?: TestRequestSpec;
  assertions: TestAssertion[];
}

export type TestSuiteSource =
  | { kind: 'endpoint'; endpointId: string; method: HttpMethod; path: string }
  | { kind: 'table'; table: string; entityType: 'table' | 'collection' };

export interface TestSuiteSpec {
  id: string;
  name: string;
  suiteType: TestSuiteType;
  source: TestSuiteSource;
  cases: TestCaseSpec[];
}

// ─── Framework adapters ────────────────────────────────────────────────────

export interface TestRenderContext {
  projectName: string;
  baseUrl: string;
  /** Engine from .ai/db_schema.json; null when no schema contract exists. */
  engine: DatabaseEngine | null;
  /** Relative import path from a suite file to the generated support file, when one is emitted. */
  supportImportPath?: string;
}

/** Renders framework-agnostic suites into source files for one test framework. */
export interface TestFrameworkAdapter {
  framework: TestFramework;
  language: TestLanguage;
  /** Extension including the dot, e.g. ".test.ts" or "_test.go". */
  fileExtension: string;
  /** Relative path (under outputDir) for a suite's file. */
  suiteFileName(suite: TestSuiteSpec): string;
  renderSuite(suite: TestSuiteSpec, ctx: TestRenderContext): string;
  /** Shared helpers (HTTP client, shape matcher, DB connection stub) emitted once per run. */
  renderSupportFiles?(ctx: TestRenderContext): GeneratedTestFile[];
}

export type TestFrameworkAdapterRegistry = Partial<Record<TestFramework, TestFrameworkAdapter>>;
