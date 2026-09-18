import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolves the primary project root containing the .ai/ contract specifications.
 * When running inside an isolated Git worktree (.worktrees/task-*), this safely
 * climbs back to the parent repository root so contracts, master plans, and
 * schemas remain accessible to sub-agents.
 */
export function resolveProjectRoot(startDirArg?: string): string {
  let current = path.resolve(startDirArg || process.cwd());

  // 1. Direct hit: .ai exists in the current directory
  if (fs.existsSync(path.join(current, '.ai'))) {
    return current;
  }

  // 2. Worktree directory convention (.worktrees/task-*)
  const worktreeIdx = current.indexOf(path.join('.worktrees'));
  if (worktreeIdx !== -1) {
    const candidate = current.substring(0, worktreeIdx).replace(/[\\/]$/, '');
    if (fs.existsSync(path.join(candidate, '.ai'))) {
      return candidate;
    }
  }

  // 3. Git worktree file inspection: in worktrees, .git is a file containing "gitdir: <path>"
  const gitPath = path.join(current, '.git');
  if (fs.existsSync(gitPath)) {
    try {
      const stat = fs.lstatSync(gitPath);
      if (stat.isFile()) {
        const content = fs.readFileSync(gitPath, 'utf8').trim();
        const match = content.match(/^gitdir:\s*(.+)$/i);
        if (match) {
          let gitDir = match[1].trim();
          if (!path.isAbsolute(gitDir)) {
            gitDir = path.resolve(current, gitDir);
          }
          // gitDir points to /path/to/repo/.git/worktrees/task-xxx
          // Main repo is 2 levels up from the worktrees metadata folder
          const mainRepo = path.resolve(gitDir, '..', '..');
          if (fs.existsSync(path.join(mainRepo, '.ai'))) {
            return mainRepo;
          }
        }
      }
    } catch {
      // Fall through to traversal
    }
  }

  // 4. Upward traversal fallback (climb until we find .ai or filesystem root)
  let prev = '';
  while (current && current !== prev) {
    if (fs.existsSync(path.join(current, '.ai'))) {
      return current;
    }
    prev = current;
    current = path.dirname(current);
  }

  return path.resolve(startDirArg || process.cwd());
}

/**
 * Creates a directory junction (Windows) or symlink (Unix) linking .ai/
 * from the main project root into the newly created worktree so path-relative
 * agent tools continue to work seamlessly.
 */
export function linkWorktreeAiDirectory(worktreeDir: string, rootDir: string): boolean {
  const rootAi = path.join(rootDir, '.ai');
  const targetAi = path.join(worktreeDir, '.ai');

  if (!fs.existsSync(rootAi) || fs.existsSync(targetAi)) {
    return false;
  }

  try {
    const isWindows = process.platform === 'win32';
    fs.symlinkSync(rootAi, targetAi, isWindows ? 'junction' : 'dir');
    return true;
  } catch {
    // If symlinks fail (restricted permissions), we can copy or rely on resolveProjectRoot
    return false;
  }
}
