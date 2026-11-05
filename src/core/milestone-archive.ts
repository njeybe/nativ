import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseJsonLoose } from './enforcement.js';
import { loadPlan, savePlan, withFileLock, writeJsonAtomicSync } from './lock-manager.js';
import { resolveMainRoot } from './root-resolver.js';
import { executeVerification } from './verifier/executor.js';
import { digestOutput } from './verifier/output-digest.js';
import { loadEscalationFile } from '../governor/store.js';
import { resolveGitHead } from '../governor/test-integrity.js';
import {
  CHECK_OVERRIDE_NAMES,
  type MasterPlan,
  type MasterPlanMilestone,
  type MasterPlanTask,
  type MilestoneArchiveInfo,
} from '../scanner/types.js';

export const DEFAULT_SUITE_TIMEOUT_MS = 600_000;

/** An expected "no": the message is written for the person running the command. */
export class ArchiveRefusal extends Error {}

/** Seams so tests can make the read-back or the plan save fail. */
export interface ArchiveDeps {
  readBack?: (file: string) => string;
  save?: (planPath: string, plan: MasterPlan) => boolean;
}

export interface ArchiveRequest {
  ids: string[];
  summaries: Record<string, string>;
  check?: string;
  timeout?: number;
}

export interface ArchiveResult {
  archived: Array<{ id: string; file: string; taskCount: number }>;
  activeMilestoneId: string;
  commit: string | null;
  warnings: string[];
}

export interface RestoreResult {
  id: string;
  taskCount: number;
  warnings: string[];
}

/** Ids of tasks moved out to archive files; they count as existing, completed tasks. */
export function archivedTaskIds(plan: MasterPlan): string[] {
  return plan.milestones.flatMap((m) => m.archived?.taskIds ?? []);
}

/** The plan as dependency checks should see it: archived tasks appear as completed. */
export function withArchivedAsDone(plan: MasterPlan): MasterPlan {
  const tasks = archivedTaskIds(plan).map((id) => ({ id, status: 'completed' }) as MasterPlanTask);
  const done: MasterPlanMilestone = { id: '', name: '', status: 'completed', tasks };
  return { ...plan, milestones: [...plan.milestones, done] };
}

const planPathOf = (targetDir: string) => path.join(targetDir, '.ai', 'master_plan.json');
const archiveFile = (targetDir: string, id: string) =>
  path.join(targetDir, '.ai', 'archive', `${id}.json`);
const configFile = (targetDir: string) =>
  path.join(resolveMainRoot(targetDir), '.nativ', 'config.json');

function assertSafeId(id: string): void {
  if (!/^[\w-][\w.-]*$/.test(id)) {
    throw new ArchiveRefusal(`"${id}" is not a valid milestone id.`);
  }
}

function readConfig(targetDir: string): Record<string, any> {
  let raw: string;
  try {
    raw = fs.readFileSync(configFile(targetDir), 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return {};
    throw new ArchiveRefusal(`.nativ/config.json cannot be read (${err?.message}).`);
  }
  if (!raw.trim()) return {};
  try {
    const parsed = parseJsonLoose<Record<string, any>>(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // Reported below, same as valid JSON of the wrong shape.
  }
  throw new ArchiveRefusal('.nativ/config.json is not a valid JSON object. Fix it first.');
}

/** The suite to run: --check wins over the saved regressionCommand. */
function resolveSuite(targetDir: string, check?: string): string {
  const raw = check ?? readConfig(targetDir).regressionCommand;
  const command = typeof raw === 'string' ? raw.trim() : '';
  if (!command) {
    throw new ArchiveRefusal(
      'No test suite is set. Pass --check "<command>" once (it is saved), '
      + 'or set "regressionCommand" in .nativ/config.json.',
    );
  }
  if (['none', 'skip'].includes(command.toLowerCase())) {
    throw new ArchiveRefusal(`"${command}" runs no tests, so it cannot protect an archive.`);
  }
  if (CHECK_OVERRIDE_NAMES.test(command)) {
    throw new ArchiveRefusal(
      'The check command must not set NATIV_CI_OVERRIDE or NATIV_HEADLESS_OVERRIDE.',
    );
  }
  return command;
}

/** Tracked files with changes, leaving out nativ's own folders; null when git cannot tell. */
function dirtyTrackedFiles(targetDir: string): string[] | null {
  const args = [
    'status', '--porcelain', '--untracked-files=no', '--', '.', ':(exclude).ai', ':(exclude).nativ',
  ];
  const res = spawnSync('git', args, { cwd: targetDir, encoding: 'utf8' });
  if (res.status !== 0) return null;
  return res.stdout.split('\n').map((line) => line.slice(3).trim()).filter(Boolean);
}

function assertTreeClean(targetDir: string, inRepo: boolean): void {
  const dirty = dirtyTrackedFiles(targetDir);
  if (dirty === null && inRepo) {
    throw new ArchiveRefusal('Could not read the git status of this project.');
  }
  if (dirty?.length) {
    const names = dirty.slice(0, 5).join(', ');
    throw new ArchiveRefusal(`Tracked code has uncommitted changes: ${names}. Commit first.`);
  }
}

function assertArchivable(
  plan: MasterPlan,
  id: string,
  targetDir: string,
): MasterPlanMilestone {
  const milestone = plan.milestones.find((m) => m.id === id);
  if (!milestone) throw new ArchiveRefusal(`Milestone "${id}" not found.`);
  if (milestone.archived) throw new ArchiveRefusal(`Milestone ${id} is already archived.`);
  if (!milestone.tasks.length) throw new ArchiveRefusal(`Milestone ${id} has no tasks to archive.`);
  const open = milestone.tasks.filter((t) => t.status !== 'completed').map((t) => t.id);
  if (open.length) {
    throw new ArchiveRefusal(`Milestone ${id} has unfinished tasks: ${open.join(', ')}.`);
  }
  const taskIds = new Set(milestone.tasks.map((t) => t.id));
  const escalated = loadEscalationFile(targetDir, plan.projectName).escalations
    .filter((e) => e && taskIds.has(e.taskId) && (!e.status || e.status === 'pending_review'))
    .map((e) => e.id);
  if (escalated.length) {
    const names = escalated.join(', ');
    throw new ArchiveRefusal(`Milestone ${id} has open escalations: ${names}. Settle them first.`);
  }
  return milestone;
}

function assertRequest(ids: string[], summaries: Record<string, string>): void {
  if (!ids.length) throw new ArchiveRefusal('Name at least one milestone to archive.');
  ids.forEach(assertSafeId);
  const missing = ids.filter((id) => typeof summaries[id] !== 'string' || !summaries[id].trim());
  if (missing.length) {
    throw new ArchiveRefusal(`A summary is required for: ${missing.join(', ')}.`);
  }
}

async function runSuite(command: string, targetDir: string, timeout: number): Promise<void> {
  const result = await executeVerification(command, targetDir, timeout);
  if (result.success) return;
  const detail = digestOutput(`${result.stdout}\n${result.stderr}`.trim(), 15);
  throw new ArchiveRefusal(`The test suite failed: ${result.error ?? command}\n${detail}`);
}

/** Writes the archive and proves it can be read back whole; the plan depends on this. */
function writeConfirmed(
  file: string,
  milestone: MasterPlanMilestone,
  readBack: (f: string) => string,
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomicSync(file, milestone);
  if (JSON.stringify(JSON.parse(readBack(file))) !== JSON.stringify(milestone)) {
    throw new Error('the file read back does not match the milestone');
  }
}

function removeArchives(files: string[]): void {
  for (const file of files) fs.rmSync(file, { force: true });
  if (!files.length) return;
  try {
    fs.rmdirSync(path.dirname(files[0]));
  } catch {
    // Other archives are still in the folder.
  }
}

function toStub(
  milestone: MasterPlanMilestone,
  summary: string,
  check: string,
  commit: string | null,
): MasterPlanMilestone {
  const archived: MilestoneArchiveInfo = {
    summary: summary.trim(),
    commit,
    check,
    archivedAt: new Date().toISOString(),
    taskCount: milestone.tasks.length,
    taskIds: milestone.tasks.map((t) => t.id),
    file: `.ai/archive/${milestone.id}.json`,
  };
  return { ...milestone, status: 'completed', tasks: [], archived };
}

function moveActiveOffArchived(plan: MasterPlan): void {
  const active = plan.milestones.find((m) => m.id === plan.activeMilestoneId);
  if (!active?.archived) return;
  const open = plan.milestones.find((m) => !m.archived && m.status !== 'completed');
  if (open) plan.activeMilestoneId = open.id;
}

/** Under the plan lock: archive files first, confirmed, and only then the plan. */
function commitArchive(
  plan: MasterPlan,
  request: ArchiveRequest,
  suite: string,
  commit: string | null,
  targetDir: string,
  deps: ArchiveDeps,
): ArchiveResult {
  const readBack = deps.readBack ?? ((f: string) => fs.readFileSync(f, 'utf8'));
  const written: string[] = [];
  const archived: ArchiveResult['archived'] = [];
  try {
    for (const id of request.ids) {
      const milestone = assertArchivable(plan, id, targetDir);
      const file = archiveFile(targetDir, id);
      written.push(file);
      writeConfirmed(file, milestone, readBack);
      const stub = toStub(milestone, request.summaries[id], suite, commit);
      plan.milestones[plan.milestones.indexOf(milestone)] = stub;
      archived.push({ id, file: stub.archived!.file, taskCount: stub.archived!.taskCount });
    }
    moveActiveOffArchived(plan);
    if (!(deps.save ?? savePlan)(planPathOf(targetDir), plan)) {
      throw new Error('the plan could not be saved');
    }
  } catch (err: any) {
    removeArchives(written);
    if (err instanceof ArchiveRefusal) throw err;
    throw new ArchiveRefusal(`Nothing was archived, the plan is unchanged: ${err?.message}.`);
  }
  return { archived, activeMilestoneId: plan.activeMilestoneId, commit, warnings: [] };
}

function saveSuite(targetDir: string, command: string): string[] {
  try {
    const config = { ...readConfig(targetDir), regressionCommand: command };
    writeJsonAtomicSync(configFile(targetDir), config);
    return [];
  } catch (err: any) {
    return [`The archive is done, but --check was not saved: ${err?.message}`];
  }
}

function loadOrRefuse(planPath: string): MasterPlan {
  const plan = loadPlan(planPath);
  if (!plan) throw new ArchiveRefusal('.ai/master_plan.json could not be read.');
  return plan;
}

/** Refuses without side effects, runs the suite once outside the lock, then re-checks and commits. */
export async function archiveMilestones(
  targetDir: string,
  request: ArchiveRequest,
  deps: ArchiveDeps = {},
): Promise<ArchiveResult> {
  const timeout = request.timeout ?? DEFAULT_SUITE_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new ArchiveRefusal('--timeout must be a positive number.');
  }
  const ids = [...new Set(request.ids)];
  assertRequest(ids, request.summaries);
  const planPath = planPathOf(targetDir);
  const before = loadOrRefuse(planPath);
  ids.forEach((id) => assertArchivable(before, id, targetDir));
  const commit = resolveGitHead(targetDir);
  assertTreeClean(targetDir, commit !== null);
  const suite = resolveSuite(targetDir, request.check);

  // The lock stays free during the long suite, so everything is checked again once it is held.
  await runSuite(suite, targetDir, timeout);
  const result = await withFileLock(planPath, () => {
    assertTreeClean(targetDir, commit !== null);
    if (resolveGitHead(targetDir) !== commit) {
      throw new ArchiveRefusal('HEAD moved while the suite ran. Run the command again.');
    }
    const plan = loadOrRefuse(planPath);
    return commitArchive(plan, { ...request, ids }, suite, commit, targetDir, deps);
  });
  return { ...result, warnings: request.check !== undefined ? saveSuite(targetDir, suite) : [] };
}

function readArchive(
  targetDir: string,
  id: string,
  expected: MilestoneArchiveInfo,
): MasterPlanMilestone {
  let saved: MasterPlanMilestone;
  try {
    saved = JSON.parse(fs.readFileSync(archiveFile(targetDir, id), 'utf8'));
  } catch (err: any) {
    throw new ArchiveRefusal(
      `The archive file of ${id} cannot be read (${err?.message}). The plan is unchanged.`,
    );
  }
  const taskIds = Array.isArray(saved?.tasks) ? saved.tasks.map((t) => t.id) : null;
  if (saved?.id !== id || JSON.stringify(taskIds) !== JSON.stringify(expected.taskIds)) {
    throw new ArchiveRefusal(`The archive file of ${id} does not match the plan. The plan is unchanged.`);
  }
  return saved;
}

/** Puts the tasks back; the archive file goes only after the plan is safely saved. */
export async function restoreMilestone(
  targetDir: string,
  id: string,
  deps: ArchiveDeps = {},
): Promise<RestoreResult> {
  assertSafeId(id);
  const planPath = planPathOf(targetDir);
  return withFileLock(planPath, () => {
    const plan = loadOrRefuse(planPath);
    const index = plan.milestones.findIndex((m) => m.id === id);
    if (index < 0) throw new ArchiveRefusal(`Milestone "${id}" not found.`);
    const info = plan.milestones[index].archived;
    if (!info) throw new ArchiveRefusal(`Milestone ${id} is not archived.`);
    const saved = readArchive(targetDir, id, info);
    plan.milestones[index] = saved;
    if (!(deps.save ?? savePlan)(planPath, plan)) {
      throw new ArchiveRefusal(`The plan could not be saved. The archive file of ${id} is kept.`);
    }
    const warnings: string[] = [];
    try {
      removeArchives([archiveFile(targetDir, id)]);
    } catch (err: any) {
      warnings.push(`Restored, but the archive file was not removed: ${err?.message}`);
    }
    return { id, taskCount: saved.tasks.length, warnings };
  });
}
