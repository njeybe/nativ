// v1 activity event schema; see .ai/design/studio-activity.md#event-schema.
export const EVENT_LOG_VERSION = 1;

export type EventSource = 'hook' | 'runner' | 'cli';

export interface EventLane {
  id: string;
  session?: string;
  agent?: string;
  agentType?: string;
  role?: string;
  model?: string;
  runId?: string;
}

export interface EventTaskRef {
  id: string;
  via: 'worktree' | 'env' | 'command';
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface ToolData {
  name: string;
  path?: string;
  outside?: true;
  program?: string;
  nativ?: string;
  taskId?: string;
  added?: number;
  removed?: number;
  ok: boolean;
  spawn?: { agentType: string; model?: string };
}

export interface AgentData {
  phase: 'start' | 'stop';
  tokens?: TokenCounts;
  models?: string[];
}

export type RunReason =
  | 'timeout'
  | 'idle'
  | 'exit_nonzero'
  | 'verify_failed'
  | 'merge_failed'
  | 'aborted'
  | 'spawn_failed'
  | 'worktree_failed';

export interface RunData {
  runId: string;
  status: string;
  engine: string;
  model?: string;
  exitCode?: number;
  reason?: RunReason;
}

export interface TaskData {
  action: 'start' | 'complete' | 'block' | 'reclaim' | 'escalate';
  by?: string;
}

export interface VerifyData {
  pass: boolean;
  durationMs: number;
  failedPhase?: string;
  exitCode?: number;
  skipped?: boolean;
  shape?: { issues: number; byKind: Record<string, number> };
}

export interface ViolationData {
  rule: string;
  mode: string;
  tool: string;
  path: string;
}

export interface UsageData {
  runId?: string;
  model: string;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  costUsd?: number;
}

interface EventBase {
  v: typeof EVENT_LOG_VERSION;
  at: string;
  src: EventSource;
  lane: EventLane;
  task?: EventTaskRef;
}

export type ActivityEvent =
  | (EventBase & { kind: 'tool'; data: ToolData })
  | (EventBase & { kind: 'agent'; data: AgentData })
  | (EventBase & { kind: 'run'; data: RunData })
  | (EventBase & { kind: 'task'; data: TaskData })
  | (EventBase & { kind: 'verify'; data: VerifyData })
  | (EventBase & { kind: 'violation'; data: ViolationData })
  | (EventBase & { kind: 'usage'; data: UsageData });

export type EventKind = ActivityEvent['kind'];
