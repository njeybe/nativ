import type { CodeShapeReport } from '../code-shape.js';

export interface VerificationResult {
  success: boolean;
  exitCode: number;
  command: string;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
  skipped?: boolean;
  codeShape?: CodeShapeReport;
  /** Results of the configured `verifyPhases`, when any ran. */
  phases?: PhaseResult[];
}

export interface PhaseResult {
  name: string;
  command: string;
  success: boolean;
  durationMs: number;
}

export interface TaskVerificationResult {
  taskId: string;
  title: string;
  milestoneId: string;
  milestoneName: string;
  status: string;
  result: VerificationResult;
}

export interface BatchVerificationResult {
  projectName: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  tasks: TaskVerificationResult[];
}

export interface VerifyPhase {
  name: string;
  run: string;
}

/** Configured phases, or an error when the config exists but cannot be trusted to say what they are. */
export interface VerifyPhasesConfig {
  phases: VerifyPhase[];
  error?: string;
}

/** Outcome of running the configured phases once; shared by every task in a batch. */
export interface PhasesOutcome {
  reports: PhaseResult[];
  failure?: VerificationResult;
}
