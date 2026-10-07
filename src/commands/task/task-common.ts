import path from 'node:path';
import type { SubagentType, TaskComplexity, MasterPlanTask, MasterPlanMilestone } from '../../scanner/types.js';

export function getPlanPath(targetDirArg?: string): { targetDir: string; planPath: string } {
  const targetDir = path.resolve(targetDirArg || process.cwd());
  const planPath = path.join(targetDir, '.ai', 'master_plan.json');
  return { targetDir, planPath };
}

export function getRoleGuide(assignedSubagent: SubagentType): string {
  const normalized = assignedSubagent
    .replace(/-agent$/, '')
    .replace(/^qa$/, 'qa-tester');

  const fileMap: Record<string, string> = {
    backend: 'backend.md',
    frontend: 'frontend.md',
    database: 'database.md',
    'qa-tester': 'qa-tester.md',
    'flutter-developer': 'flutter-developer.md',
    'devops-agent': 'devops-agent.md',
    'security-auditor': 'security-auditor.md',
    'db-migration': 'db-migration.md',
  };

  const filename = fileMap[assignedSubagent] || fileMap[normalized] || `${normalized}.md`;
  return `.ai/subagents/${filename}`;
}

export function getRecommendedContractSlice(assignedSubagent: SubagentType): string {
  const sub = assignedSubagent.toLowerCase();
  if (sub.includes('frontend') || sub.includes('flutter')) {
    return '.ai/ui_specs.md + .ai/api_contracts.json';
  }
  if (sub.includes('backend')) {
    return '.ai/api_contracts.json + .ai/db_schema.json';
  }
  if (sub.includes('database') || sub.includes('db-migration')) {
    return '.ai/db_schema.json';
  }
  if (sub.includes('devops')) {
    return '.ai/context.md';
  }
  if (sub.includes('security')) {
    return 'targetFiles + dependency manifests + .ai/context.md';
  }
  if (sub.includes('qa')) {
    return 'targetFiles + .ai/api_contracts.json';
  }
  return '.ai/context.md';
}

export interface TaskUnlockOptions {
  /** Why scope enforcement is being lifted; kept in .nativ/unlocks.json. */
  reason?: string;
  /** Re-locks the task instead. */
  revoke?: boolean;
}

export interface TaskCompleteOptions {
  notes?: string;
  skipVerify?: boolean;
  timeout?: number;
}

export interface TaskAddOptions {
  /** Milestone ID or name; defaults to the active milestone (or the fast-path milestone with fastPath). */
  milestone?: string;
  /** Assigned sub-agent (default backend). */
  agent?: string;
  /** Verification command run by the `task complete` gatekeeper. */
  verify?: string;
  /** Target files, comma-separated or as an array. */
  files?: string | string[];
  description?: string;
  fastPath?: boolean;
  /** Dependency task IDs, comma-separated or as an array. */
  deps?: string | string[];
  notes?: string;
  /** Spec refs, comma-separated or as an array. */
  specRefs?: string | string[];
  /** simple | standard | complex. */
  complexity?: string;
  /** "Done when" lines: an array, or one string with "|" separators. */
  accept?: string | string[];
  json?: boolean;
}

export interface TaskAddResult {
  task: MasterPlanTask;
  milestoneId: string;
  milestoneName: string;
  createdMilestone: boolean;
  reopenedMilestone: boolean;
}

export interface ProposePatchOptions {
  taskId: string;
  target: 'db_schema' | 'api_contracts';
  operation: 'ADD' | 'ALTER' | 'DROP' | 'RENAME';
  path: string;
  value?: any;
  reason: string;
  baseHash?: string;
  json?: boolean;
}
