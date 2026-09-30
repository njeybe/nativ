export interface ProjectInfo {
  projectName: string;
  projectType: string;
  projectGoal: string;
  runtime: string;
  framework: string;
  databaseOrm: string;
  styling: string;
  testing: string;
  packageManager: string;
  sourceRoot: string;
  architecturePattern: string;
  keyDirectories: string[];
  verificationCommand: string;
  repositoryType: string;
  monorepoWorkspaces: string[];
  detectedOrmConfig: string;
  ecosystemManifests: string[];
}

export type SubagentType =
  // Core development & database units
  | 'backend'
  | 'frontend'
  | 'database'
  | 'qa-tester'
  // Specialized functional units
  | 'flutter-developer'
  | 'devops-agent'
  | 'security-auditor'
  | 'db-migration'
  // Compatibility aliases
  | 'database-agent'
  | 'backend-agent'
  | 'frontend-agent'
  | 'qa-agent';

export const SUBAGENT_TYPES: readonly SubagentType[] = [
  'backend',
  'frontend',
  'database',
  'qa-tester',
  'flutter-developer',
  'devops-agent',
  'security-auditor',
  'db-migration',
  'database-agent',
  'backend-agent',
  'frontend-agent',
  'qa-agent',
];

export function isSubagentType(value: string): value is SubagentType {
  return (SUBAGENT_TYPES as readonly string[]).includes(value);
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export const TASK_STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'completed', 'blocked'];

export interface MasterPlanTask {
  id: string;
  title: string;
  description: string;
  assignedSubagent: SubagentType;
  dependencies: string[];
  targetFiles: string[];
  status: TaskStatus;
  verificationCommand: string;
  notes?: string;
  /**
   * Fast-path task: a small, self-contained change added outside the Tier-1 planned milestones
   * (e.g. via `nativ task add --fast-path`). Absent or false means a planned task.
   */
  fastPath?: boolean;
  /** Spec anchors, e.g. "ui_specs.md#appointment-list" or "api_contracts.json#/paths/~1appointments". */
  specRefs?: string[];
  complexity?: TaskComplexity;
  /** Plain-language "done when" lines. */
  acceptanceCriteria?: string[];
}

export type TaskComplexity = 'simple' | 'standard' | 'complex';

export const TASK_COMPLEXITIES: readonly TaskComplexity[] = ['simple', 'standard', 'complex'];

/** Lists every structural problem with a task; empty when the task is valid. */
export function validateMasterPlanTask(task: unknown): string[] {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return ['task must be an object'];
  const t = task as Record<string, unknown>;
  const label = typeof t.id === 'string' && t.id ? `task "${t.id}"` : 'task';
  const errors: string[] = [];
  const isStringArray = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');

  for (const field of ['id', 'title'] as const) {
    if (typeof t[field] !== 'string' || !(t[field] as string).trim()) errors.push(`${label}: "${field}" must be a non-empty string`);
  }
  if (typeof t.description !== 'string') errors.push(`${label}: "description" must be a string`);
  if (typeof t.verificationCommand !== 'string') errors.push(`${label}: "verificationCommand" must be a string`);
  if (typeof t.assignedSubagent !== 'string' || !isSubagentType(t.assignedSubagent)) {
    errors.push(`${label}: "assignedSubagent" must be one of ${SUBAGENT_TYPES.join(', ')}`);
  }
  if (typeof t.status !== 'string' || !(TASK_STATUSES as readonly string[]).includes(t.status)) {
    errors.push(`${label}: "status" must be one of ${TASK_STATUSES.join(', ')}`);
  }
  if (!isStringArray(t.dependencies)) errors.push(`${label}: "dependencies" must be an array of task IDs`);
  if (!isStringArray(t.targetFiles)) errors.push(`${label}: "targetFiles" must be an array of paths`);
  if (t.notes !== undefined && typeof t.notes !== 'string') errors.push(`${label}: "notes" must be a string`);
  if (t.fastPath !== undefined && typeof t.fastPath !== 'boolean') errors.push(`${label}: "fastPath" must be a boolean`);
  for (const field of ['specRefs', 'acceptanceCriteria'] as const) {
    if (t[field] !== undefined && !isStringArray(t[field])) errors.push(`${label}: "${field}" must be an array of strings`);
  }
  if (t.complexity !== undefined && !(TASK_COMPLEXITIES as readonly unknown[]).includes(t.complexity)) {
    errors.push(`${label}: "complexity" must be one of ${TASK_COMPLEXITIES.join(', ')}`);
  }
  return errors;
}

export interface MasterPlanMilestone {
  id: string;
  name: string;
  status: 'pending' | 'in_progress' | 'completed';
  tasks: MasterPlanTask[];
  /** True for the milestone that collects fast-path tasks. */
  fastPath?: boolean;
}

export interface MasterPlan {
  $schema?: string;
  version: string;
  projectName: string;
  lastUpdated: string;
  overallStatus: 'pending' | 'in_progress' | 'completed';
  activeMilestoneId: string;
  milestones: MasterPlanMilestone[];
}

export type EscalationType =
  | 'contract_drift'
  | 'schema_flaw'
  | 'missing_credential'
  | 'dependency_conflict'
  | 'architectural_ambiguity';

export interface EscalationRecord {
  id: string;
  taskId: string;
  type: EscalationType;
  reportedBy: SubagentType;
  timestamp: string;
  summary: string;
  details?: string;
  affectedContracts: string[];
  recommendedAction?: string;
  status: 'pending_review' | 'resolved' | 'dismissed';
  resolutionNotes?: string;
}

export interface EscalationFile {
  $schema?: string;
  version: string;
  projectName: string;
  lastUpdated: string;
  escalations: EscalationRecord[];
}

