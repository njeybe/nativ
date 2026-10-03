import fs from 'node:fs';
import path from 'node:path';
import { parseJsonLoose } from './enforcement.js';
import { getTemplatesDir, planTemplateFile } from './setup-assets.js';
import { listLearnings } from './learnings.js';

/**
 * nativ · Checks that the harness itself is intact: nothing switches the guardrails off, no secret
 * sits in a file every agent reads, every role a task names has a guide. Pure reads; findings never
 * include the secret itself.
 */

export interface IntegrityFinding {
  id: string;
  status: 'ok' | 'warn' | 'fail' | 'info';
  message: string;
}

/** Well-known credential shapes only; loose `password=` matches would flag every doc that mentions one. */
const SECRET_SHAPES: Array<{ kind: string; pattern: RegExp; severity: 'fail' | 'warn' }> = [
  { kind: 'private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, severity: 'fail' },
  { kind: 'Anthropic or OpenAI key', pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/, severity: 'fail' },
  { kind: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, severity: 'fail' },
  { kind: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/, severity: 'fail' },
  { kind: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/, severity: 'fail' },
  { kind: 'JSON web token', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, severity: 'fail' },
  // A placeholder such as user:password@localhost also matches, so this one only warns.
  {
    kind: 'connection string with a password',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"']*:[^\s@"'$<{]+@/i,
    severity: 'warn',
  },
];

const AGENT_READ_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.mcp.json', '.claude/settings.json'];
const AGENT_READ_DIRS = ['.claude/agents', '.ai'];
const SCANNED_EXT = new Set(['.md', '.json', '.html', '.txt', '.yaml', '.yml']);
const MAX_SCAN_BYTES = 1_000_000;

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function listFiles(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(full, out);
    else if (e.isFile() && SCANNED_EXT.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}

function checkGuardrailOverrides(root: string): IntegrityFinding[] {
  const findings: IntegrityFinding[] = [];
  for (const rel of ['.claude/settings.json', '.claude/settings.local.json']) {
    const text = readText(path.join(root, rel));
    if (!text?.trim()) continue;
    let settings: any;
    try {
      settings = parseJsonLoose(text);
    } catch {
      continue;
    }
    if (settings?.disableAllHooks === true) {
      findings.push({
        id: `guardrail:${rel}:hooks`,
        status: 'fail',
        message: `${rel} sets disableAllHooks, so the enforcement hook never runs. Remove it.`,
      });
    }
    if (settings?.permissions?.defaultMode === 'bypassPermissions') {
      findings.push({
        id: `guardrail:${rel}:bypass`,
        status: 'warn',
        message: `${rel} sets bypassPermissions, so writes under .ai/ no longer ask a human first.`,
      });
    }
  }
  return findings;
}

function checkSecrets(root: string): IntegrityFinding[] {
  const files = [
    ...AGENT_READ_FILES.map((rel) => path.join(root, rel)),
    ...AGENT_READ_DIRS.flatMap((rel) => listFiles(path.join(root, rel))),
  ];
  const findings: IntegrityFinding[] = [];
  for (const file of files) {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      continue;
    }
    if (size > MAX_SCAN_BYTES) continue;
    const lines = (readText(file) ?? '').split(/\r?\n/);
    const rel = path.relative(root, file).split(path.sep).join('/');
    for (const shape of SECRET_SHAPES) {
      const line = lines.findIndex((l) => shape.pattern.test(l));
      if (line < 0) continue;
      findings.push({
        id: `secret:${rel}:${shape.kind}`,
        status: shape.severity,
        message: `${rel}:${line + 1} looks like a ${shape.kind}. Every agent reads this file; `
          + 'move the value to .env and reference it.',
      });
    }
  }
  return findings;
}

function checkRoleGuides(root: string, templatesDir: string): IntegrityFinding[] {
  const findings: IntegrityFinding[] = [];
  const guidesDir = path.join(root, '.ai', 'subagents');
  let roles = new Set<string>();
  try {
    const plan = parseJsonLoose<{ milestones?: Array<{ tasks?: Array<{ assignedSubagent?: unknown }> }> }>(
      readText(path.join(root, '.ai', 'master_plan.json')) ?? '{}',
    );
    for (const m of plan.milestones ?? []) {
      for (const t of m.tasks ?? []) {
        if (typeof t.assignedSubagent === 'string') roles.add(t.assignedSubagent);
      }
    }
  } catch {
    roles = new Set();
  }
  const missing = [...roles].filter((r) => /^[\w-]+$/.test(r) && !fs.existsSync(path.join(guidesDir, `${r}.md`)));
  if (missing.length) {
    findings.push({
      id: 'role-guides:missing',
      status: 'warn',
      message: `Tasks name roles with no guide in .ai/subagents/: ${missing.sort().join(', ')}. `
        + 'Their workers start without one.',
    });
  }

  const edited: string[] = [];
  for (const file of listFiles(path.join(templatesDir, 'dot-ai', 'subagents'))) {
    const name = path.basename(file);
    const existing = readText(path.join(guidesDir, name));
    if (existing === null) continue;
    const plan = planTemplateFile(existing, readText(file) ?? '', `subagents/${name}`);
    if (plan.action === 'skipped') edited.push(name);
  }
  if (edited.length) {
    findings.push({
      id: 'role-guides:edited',
      status: 'info',
      message: `Role guides edited by hand (nativ update keeps them as they are): ${edited.sort().join(', ')}`,
    });
  }
  return findings;
}

function checkLearnings(root: string): IntegrityFinding[] {
  const waiting = listLearnings(root, { status: 'proposed' }).length;
  if (!waiting) return [];
  const noun = waiting === 1 ? 'lesson waits' : 'lessons wait';
  const message = `${waiting} proposed ${noun} for approval: nativ learn list --status proposed`;
  return [{ id: 'learnings', status: 'info', message }];
}

export function checkHarnessIntegrity(root: string, options: { templatesDir?: string } = {}): IntegrityFinding[] {
  const findings = [
    ...checkGuardrailOverrides(root),
    ...checkSecrets(root),
    ...checkRoleGuides(root, options.templatesDir ?? getTemplatesDir()),
    ...checkLearnings(root),
  ];
  const problems = findings.some((f) => f.id.startsWith('guardrail:') || f.id.startsWith('secret:'));
  if (!problems) {
    const message = 'No guardrail overrides and no secrets in files agents read';
    findings.unshift({ id: 'integrity', status: 'ok', message });
  }
  return findings;
}
