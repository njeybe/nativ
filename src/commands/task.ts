/**
 * Barrel exports for task subcommands.
 * Re-exports all public APIs to preserve backward compatibility.
 */
export { loadPlan, savePlan, withPlanLock } from '../core/lock-manager.js';
export {
  getRoleGuide,
  getRecommendedContractSlice,
} from './task/task-common.js';
export type {
  TaskUnlockOptions,
  TaskCompleteOptions,
  TaskAddOptions,
  TaskAddResult,
  ProposePatchOptions,
} from './task/task-common.js';
export { runTaskList, runTaskNext } from './task/task-query.js';
export {
  runTaskStart,
  runTaskComplete,
  runTaskBlock,
  runTaskUnlock,
} from './task/task-lifecycle.js';
export { runTaskReclaim } from './task/task-reclaim.js';
export type { TaskReclaimOptions, TaskReclaimResult } from './task/task-reclaim.js';
export {
  FAST_PATH_MILESTONE_NAME,
  generateNextTaskId,
  generateNextMilestoneId,
  runTaskAdd,
} from './task/task-add.js';
export {
  runTaskEscalate,
  runTaskProposePatch,
} from './task/task-escalate.js';
