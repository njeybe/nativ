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

export interface MasterPlanTask {
  id: string;
  title: string;
  description: string;
  assignedSubagent: SubagentType;
  dependencies: string[];
  targetFiles: string[];
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  verificationCommand: string;
  notes?: string;
}

export interface MasterPlanMilestone {
  id: string;
  name: string;
  status: 'pending' | 'in_progress' | 'completed';
  tasks: MasterPlanTask[];
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

