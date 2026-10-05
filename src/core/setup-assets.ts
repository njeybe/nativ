/**
 * nativ · Single source for every file `nativ setup` generates.
 *
 * Barrel module re-exporting all setup asset planning, config merging,
 * marker validation, and session context creation.
 */

export * from './setup/types.js';
export type {
  DesiredClaudeConfig,
  Json,
  HookGroup,
  MergeResult,
} from './setup/config-merger.js';
export {
  SECRET_READ_DENY,
  buildDesiredConfig,
  isObject,
  unionStrings,
  mergeHook,
  mergeClaudeSettings,
  mergeMcpConfig,
} from './setup/config-merger.js';
export { planTemplateFile } from './setup/template-planner.js';
export {
  getTemplatesDir,
  configuredInvocation,
  planSetup,
  applySetup,
} from './setup/setup-planner.js';
export {
  buildSessionContext,
  runSessionContext,
} from './setup/session-context.js';
