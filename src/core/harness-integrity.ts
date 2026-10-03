import fs from 'node:fs';
import path from 'node:path';
import { parseJsonLoose } from './enforcement.js';
import { getTemplatesDir, planTemplateFile } from './setup-assets.js';
import { canonicalRole, listLearnings, loadLearnings } from './learnings.js';

/**
 * nativ · Checks that the harness itself is intact: nothing switches the guardrails off, no secret
 * sits in a file agents read, every role a task names has a guide. Findings never include a secret.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info';

export interface IntegrityFinding {
  id: string;
  status: CheckStatus;
  message: string;
  /** `guardrail` and `secret` findings decide whether doctor may report the harness as clean. */
  category: 'guardrail' | 'secret' | 'roles' | 'learnings' | 'specs';
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
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"']*:[^\s@"'$<{/]+@/i,
    severity: 'warn',
  },
];

const SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'];
const AGENT_READ_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.mcp.json', '.nativ/config.json', ...SETTINGS_FILES];
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
  const add = (id: string, status: CheckStatus, message: string) =>
    findings.push({ id, status, message, category: 'guardrail' });
  for (const rel of SETTINGS_FILES) {
    const text = readText(path.join(root, rel));
    if (!text?.trim()) continue;
    let settings: any;
    try {
      settings = parseJsonLoose(text);
    } catch {
      const message = `${rel} is not valid JSON, so its guardrail settings could not be checked.`;
      add(`guardrail:${rel}:unreadable`, 'warn', message);
      continue;
    }
    if (settings?.disableAllHooks === true) {
      const message = `${rel} sets disableAllHooks, so the enforcement hook never runs. Remove it.`;
      add(`guardrail:${rel}:hooks`, 'fail', message);
    }
    if (settings?.permissions?.defaultMode === 'bypassPermissions') {
      const message = `${rel} sets bypassPermissions, so writes under .ai/ and .nativ/ no longer ask a human first.`;
      add(`guardrail:${rel}:bypass`, 'warn', message);
    }
  }
  return findings;
}

function scanFile(root: string, file: string): IntegrityFinding[] {
  try {
    if (fs.statSync(file).size > MAX_SCAN_BYTES) return [];
  } catch {
    return [];
  }
  const lines = (readText(file) ?? '').split(/\r?\n/);
  const rel = path.relative(root, file).split(path.sep).join('/');
  const findings: IntegrityFinding[] = [];
  for (const shape of SECRET_SHAPES) {
    const line = lines.findIndex((l) => shape.pattern.test(l));
    if (line < 0) continue;
    findings.push({
      id: `secret:${rel}:${shape.kind}`,
      status: shape.severity,
      category: 'secret',
      message: `${rel}:${line + 1} looks like a ${shape.kind}. Agents read this file; `
        + 'move the value to .env and reference it.',
    });
  }
  return findings;
}

function checkSecrets(root: string): IntegrityFinding[] {
  const files = [
    ...AGENT_READ_FILES.map((rel) => path.join(root, rel)),
    ...AGENT_READ_DIRS.flatMap((rel) => listFiles(path.join(root, rel))),
  ];
  return files.flatMap((file) => scanFile(root, file));
}

function plannedRoles(root: string): string[] {
  try {
    const plan = parseJsonLoose<{ milestones?: Array<{ tasks?: Array<{ assignedSubagent?: unknown }> }> }>(
      readText(path.join(root, '.ai', 'master_plan.json')) ?? '{}',
    );
    const roles = (plan.milestones ?? []).flatMap((m) => (Array.isArray(m?.tasks) ? m.tasks : []))
      .map((t) => t?.assignedSubagent)
      .filter((r): r is string => typeof r === 'string');
    return [...new Set(roles)];
  } catch {
    return [];
  }
}

function checkMissingRoleGuides(root: string): IntegrityFinding[] {
  const guidesDir = path.join(root, '.ai', 'subagents');
  const missing = plannedRoles(root).filter((role) => {
    const guide = canonicalRole(role) ?? role;
    return !/^[\w-]+$/.test(guide) || !fs.existsSync(path.join(guidesDir, `${guide}.md`));
  });
  if (!missing.length) return [];
  return [{
    id: 'role-guides:missing',
    status: 'warn',
    category: 'roles',
    message: `Tasks name roles with no guide in .ai/subagents/: ${missing.sort().join(', ')}. `
      + 'Their workers start without one.',
  }];
}

function checkEditedRoleGuides(root: string, templatesDir: string): IntegrityFinding[] {
  const edited: string[] = [];
  for (const file of listFiles(path.join(templatesDir, 'dot-ai', 'subagents'))) {
    const name = path.basename(file);
    const existing = readText(path.join(root, '.ai', 'subagents', name));
    if (existing === null) continue;
    if (planTemplateFile(existing, readText(file) ?? '', `subagents/${name}`).action === 'skipped') edited.push(name);
  }
  if (!edited.length) return [];
  const message = `Role guides edited by hand (nativ update keeps them as they are): ${edited.sort().join(', ')}`;
  return [{ id: 'role-guides:edited', status: 'info', category: 'roles', message }];
}

function checkLearnings(root: string): IntegrityFinding[] {
  const findings: IntegrityFinding[] = [];
  const waiting = listLearnings(root, { status: 'proposed' }).length;
  if (waiting) {
    const noun = waiting === 1 ? 'lesson waits' : 'lessons wait';
    const message = `${waiting} proposed ${noun} for approval: nativ learn list --status proposed`;
    findings.push({ id: 'learnings', status: 'info', category: 'learnings', message });
  }
  if (loadLearnings(root).unreadable) {
    findings.push({
      id: 'learnings:unreadable',
      status: 'warn',
      category: 'learnings',
      message: '.ai/learnings.json cannot be read, so workers receive no lessons and new ones cannot be '
        + 'proposed. Fix the JSON or move the file.',
    });
  }
  return findings;
}

function checkUiSpecs(root: string): IntegrityFinding[] {
  const specs = readText(path.join(root, '.ai', 'ui_specs.md'));
  if (specs === null || /Marketing pages/i.test(specs)) return [];
  return [{
    id: 'specs:marketing',
    status: 'info',
    category: 'specs',
    message: '.ai/ui_specs.md predates the Marketing pages checks. Ask the architect to add that part '
      + 'of the Anti-Generic Checklist from the current nativ template.',
  }];
}

export function checkHarnessIntegrity(root: string, options: { templatesDir?: string } = {}): IntegrityFinding[] {
  const findings = [
    ...checkGuardrailOverrides(root),
    ...checkSecrets(root),
    ...checkMissingRoleGuides(root),
    ...checkEditedRoleGuides(root, options.templatesDir ?? getTemplatesDir()),
    ...checkLearnings(root),
    ...checkUiSpecs(root),
  ];
  if (!findings.some((f) => f.category === 'guardrail' || f.category === 'secret')) {
    const message = 'No guardrail overrides and no secrets in files agents read';
    findings.unshift({ id: 'integrity', status: 'ok', category: 'guardrail', message });
  }
  return findings;
}
