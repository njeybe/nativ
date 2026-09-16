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
}

export interface MasterPlanTask {
  id: string;
  title: string;
  description: string;
  assignedSubagent: 'database-agent' | 'backend-agent' | 'frontend-agent' | 'qa-agent';
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
