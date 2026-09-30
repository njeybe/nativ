import type { PageModule } from './types.js';
import { homePage } from './home/index.js';
import { tasksPage } from './tasks/index.js';
import { flowPage } from './flow/index.js';
import { teamPage } from './team/index.js';
import { worktreesPage } from './worktrees/index.js';
import { benchmarksPage } from './benchmarks/index.js';
import { databasePage } from './database/index.js';

// Order here is the order of the sidebar and the palette.
export const pages: PageModule[] = [
  homePage,
  tasksPage,
  flowPage,
  teamPage,
  worktreesPage,
  benchmarksPage,
  databasePage,
];
