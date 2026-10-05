import fs from 'node:fs';
import path from 'node:path';
import { ROLE_ENV, loadEnforcementMode, parseJsonLoose } from '../enforcement.js';
import { resolveProjectRoot } from '../root-resolver.js';

interface PlanTask {
  id: string;
  title: string;
  status: string;
  dependencies: string[];
  targetFiles: string[];
}

function readPlanTasks(root: string): PlanTask[] {
  try {
    const plan = parseJsonLoose<{ milestones?: Array<{ tasks?: Array<Partial<PlanTask>> }> }>(
      fs.readFileSync(path.join(root, '.ai', 'master_plan.json'), 'utf8'),
    );
    const tasks: PlanTask[] = [];
    for (const milestone of plan.milestones ?? []) {
      for (const t of milestone.tasks ?? []) {
        if (typeof t.id === 'string') {
          tasks.push({
            id: t.id,
            title: typeof t.title === 'string' ? t.title : '',
            status: typeof t.status === 'string' ? t.status : 'pending',
            dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
            targetFiles: Array.isArray(t.targetFiles) ? t.targetFiles : [],
          });
        }
      }
    }
    return tasks;
  } catch {
    return [];
  }
}

/** A few lines of orientation for a new Claude Code session, or null when this is not a nativ project. */
export function buildSessionContext(cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const root = resolveProjectRoot(cwd);
  if (!fs.existsSync(path.join(root, '.ai', 'master_plan.json'))) return null;

  const tasks = readPlanTasks(root);
  const active = tasks.filter((t) => t.status === 'in_progress');
  const done = new Set(tasks.filter((t) => t.status === 'completed').map((t) => t.id));
  const next = tasks.find((t) => t.status === 'pending' && t.dependencies.every((d) => done.has(d)));
  const role = (env[ROLE_ENV] ?? '').trim().toLowerCase() || 'project manager';

  const lines = [
    'This is a nativ project (role-based multi-agent workflow).',
    `Session role: ${role}. Enforcement: ${loadEnforcementMode(root)}. Edits outside the active task's targetFiles are flagged, and .ai/ contracts are architect-only.`,
  ];
  if (active.length) {
    for (const t of active) lines.push(`In progress: ${t.id} "${t.title}" (targetFiles: ${t.targetFiles.join(', ') || 'none'})`);
  } else if (next) {
    lines.push(`Next available task: ${next.id} "${next.title}". Run \`nativ task next\` to load its context.`);
  } else {
    lines.push('No task is in progress or ready.');
  }
  lines.push('Prefer the nativ_* MCP tools (or the `nativ` CLI). Do not edit .ai/ directly: escalate contract gaps with `nativ task escalate`.');
  return lines.join('\n');
}

/** `nativ hook context`: prints the SessionStart hook output. Never throws and always prints valid JSON or nothing. */
export function runSessionContext(targetDirArg?: string, write: (text: string) => void = (t) => process.stdout.write(t)): void {
  try {
    const context = buildSessionContext(targetDirArg ? path.resolve(targetDirArg) : process.env.CLAUDE_PROJECT_DIR || process.cwd());
    if (context) write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
  } catch {
    // Orientation is a convenience; a failure must never disturb session start.
  }
}
