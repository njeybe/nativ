export type BlastRadius = 'LOW_ADDITIVE' | 'HIGH_DESTRUCTIVE';

export type PatchOperation = 'ADD' | 'ALTER' | 'DROP' | 'RENAME';

export type ContractTarget = 'db_schema' | 'api_contracts';

export interface ContractPatch {
  taskId: string;
  target: ContractTarget;
  operation: PatchOperation;
  path: string;
  value?: any;
  before?: any;
  reason: string;
  baseHash?: string;
}

export interface AuditLogEntry {
  timestamp: string;
  taskId: string;
  target: ContractTarget;
  operation: PatchOperation;
  path: string;
  blastRadius: BlastRadius;
  ruleId: string;
  reason: string;
  applied: boolean;
}

export interface CircuitBreakerState {
  active: boolean;
  consecutiveFailures: number;
  maxThreshold: number;
  tripped: boolean;
}

export interface EscalationDiagnosticBundle {
  escalationId: string;
  taskId: string;
  circuitBreakerTripped: boolean;
  consecutiveFailures: number;
  intent: string;
  invariantCollision: string;
  proposedPatch: {
    target: ContractTarget;
    operation: PatchOperation;
    path: string;
    value?: any;
    reason: string;
  };
  recommendedActions: string[];
}

export interface GovernorVerdict {
  approved: boolean;
  blastRadius: BlastRadius;
  ruleId: string;
  message: string;
  violations: string[];
  patchApplied: boolean;
  circuitBreaker: CircuitBreakerState;
  auditEntry?: AuditLogEntry;
  diagnosticBundle?: EscalationDiagnosticBundle;
}

export interface RuleEvaluationResult {
  approved: boolean;
  blastRadius: BlastRadius;
  ruleId: string;
  message: string;
  violations: string[];
}
