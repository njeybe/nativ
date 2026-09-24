import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import pc from 'picocolors';
import { MasterPlan } from '../scanner/types.js';

export interface LockOptions {
  stale?: number;
  retries?: number | { retries?: number; factor?: number; minTimeout?: number; maxTimeout?: number };
  realpath?: boolean;
}

export const DEFAULT_LOCK_OPTIONS: LockOptions = {
  stale: 10000, // 10 seconds stale timeout prevents deadlocks if a process crashes
  retries: {
    retries: 40,
    factor: 1.2,
    minTimeout: 20,
    maxTimeout: 500,
  },
  realpath: false, // Prevents symlink/junction resolution mismatch in git worktrees
};

export interface PlanMutationContext {
  abort: () => void;
  isAborted: () => boolean;
}

/**
 * Executes an operation holding an advisory lock on a given file.
 * Automatically releases the lock when the operation finishes (even on error).
 */
export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T> | T,
  options: LockOptions = {}
): Promise<T> {
  const mergedOptions = { ...DEFAULT_LOCK_OPTIONS, ...options };

  // proper-lockfile requires the target file to exist
  if (!fs.existsSync(filePath)) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, '', 'utf8');
  }

  const release = await lockfile.lock(filePath, mergedOptions as any);
  try {
    return await fn();
  } finally {
    try {
      await release();
    } catch {
      // Best-effort release (in case lock was already freed or invalidated)
    }
  }
}

/**
 * Loads a master plan from disk without acquiring an advisory lock.
 * Includes automatic transient retries to handle atomic file swap collisions (e.g. Windows EBUSY).
 * Returns null if the file does not exist or fails to parse.
 */
export function loadPlan(planPath: string, options: { silent?: boolean; retries?: number } = {}): MasterPlan | null {
  if (!fs.existsSync(planPath)) {
    if (!options.silent) {
      console.error(pc.red(`\n✖ No .ai/master_plan.json found at: ${planPath}`));
      console.log(pc.yellow('Run `nativ init` first to scaffold the workflow.\n'));
    }
    return null;
  }

  const maxAttempts = options.retries ?? 10;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const raw = fs.readFileSync(planPath, 'utf8');
      return JSON.parse(raw) as MasterPlan;
    } catch (err: any) {
      if (attempt === maxAttempts - 1) {
        if (!options.silent) {
          console.error(pc.red(`\n✖ Failed to parse .ai/master_plan.json: ${err.message}\n`));
        }
        return null;
      }
      // Brief synchronous pause to allow concurrent rename to finalize
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  return null;
}

/**
 * Atomically writes the plan using a temp file rename with Windows EPERM/EBUSY resilience.
 * Creates a unique temp file to prevent rename collisions across threads/processes.
 */
export function savePlan(planPath: string, plan: MasterPlan): boolean {
  const tmpPath = `${planPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    plan.lastUpdated = new Date().toISOString();
    fs.writeFileSync(tmpPath, JSON.stringify(plan, null, 2) + '\n', 'utf8');

    // Windows NTFS atomic rename retry loop
    let renamed = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        fs.renameSync(tmpPath, planPath);
        renamed = true;
        break;
      } catch (err: any) {
        if (err.code === 'EPERM' || err.code === 'EBUSY') {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        } else {
          throw err;
        }
      }
    }

    if (!renamed) {
      // Fallback: direct atomic copyFileSync + unlinkSync under advisory lock
      fs.copyFileSync(tmpPath, planPath);
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Best-effort cleanup of temp file
      }
    }

    return true;
  } catch (err: any) {
    fs.rmSync(tmpPath, { force: true });
    console.error(pc.red(`\n✖ Failed to save .ai/master_plan.json: ${err.message}\n`));
    return false;
  }
}

/**
 * Safely executes a mutation on master_plan.json under an OS-level advisory lock.
 * Ensures an atomic Read-Modify-Write cycle across concurrent agent processes.
 */
export async function withPlanLock<T>(
  planPath: string,
  mutator: (plan: MasterPlan, ctx: PlanMutationContext) => Promise<T> | T,
  options: LockOptions = {}
): Promise<T | null> {
  if (!fs.existsSync(planPath)) {
    console.error(pc.red(`\n✖ No .ai/master_plan.json found at: ${planPath}`));
    console.log(pc.yellow('Run `nativ init` first to scaffold the workflow.\n'));
    return null;
  }

  return withFileLock(
    planPath,
    async () => {
      const plan = loadPlan(planPath);
      if (!plan) {
        console.error(pc.red(`\n✖ Failed to parse .ai/master_plan.json at: ${planPath}\n`));
        return null;
      }

      let aborted = false;
      const ctx: PlanMutationContext = {
        abort: () => {
          aborted = true;
        },
        isAborted: () => aborted,
      };

      const result = await mutator(plan, ctx);

      if (!aborted) {
        savePlan(planPath, plan);
      }

      return result;
    },
    options
  );
}

/**
 * Synchronous counterpart of withFileLock for callers that cannot await (the governor runs inside
 * synchronous verdicts). Uses the same `<file>.lock` directory, so it excludes async holders too.
 */
export function withFileLockSync<T>(filePath: string, fn: () => T, options: LockOptions = {}): T {
  const { retries: _ignored, ...syncOptions } = { ...DEFAULT_LOCK_OPTIONS, ...options };
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '', 'utf8');
  }

  let release: (() => void) | null = null;
  // ~5s of contention before giving up: parallel agents trip the breaker at the same moment.
  const maxAttempts = 200;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      release = lockfile.lockSync(filePath, syncOptions as any);
      break;
    } catch (err: any) {
      if (attempt === maxAttempts - 1 || err.code !== 'ELOCKED') throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }

  try {
    return fn();
  } finally {
    try {
      release?.();
    } catch {
      // Best-effort release
    }
  }
}

/**
 * Writes JSON through a unique temp file and a rename, so readers never observe a half-written
 * file. Retries the rename on Windows sharing violations, like savePlan().
 */
export function writeJsonAtomicSync(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmpPath, filePath);
        return;
      } catch (err: any) {
        if (attempt >= 10 || (err.code !== 'EPERM' && err.code !== 'EBUSY')) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
}

/**
 * Synchronous variant of withPlanLock using proper-lockfile lockSync.
 */
export function withPlanLockSync<T>(
  planPath: string,
  mutator: (plan: MasterPlan, ctx: PlanMutationContext) => T,
  options: LockOptions = {}
): T | null {
  if (!fs.existsSync(planPath)) {
    return null;
  }
  const { retries: _ignored, ...syncOptions } = { ...DEFAULT_LOCK_OPTIONS, ...options };

  let release: (() => void) | null = null;
  const maxAttempts = 15;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      release = lockfile.lockSync(planPath, syncOptions as any);
      break;
    } catch (err: any) {
      if (attempt === maxAttempts - 1 || err.code !== 'ELOCKED') {
        throw err;
      }
      // Brief synchronous pause
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }

  if (!release) return null;

  try {
    const plan = loadPlan(planPath, { silent: true });
    if (!plan) return null;

    let aborted = false;
    const ctx: PlanMutationContext = {
      abort: () => {
        aborted = true;
      },
      isAborted: () => aborted,
    };

    const result = mutator(plan, ctx);
    if (!aborted) {
      savePlan(planPath, plan);
    }
    return result;
  } finally {
    try {
      release();
    } catch {
      // Best-effort release
    }
  }
}

