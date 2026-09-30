import type { PageModule } from '../types.js';
import { ICON_PATHS } from '../../shell/icons.js';
import { worktreesCss } from './styles.js';
import { worktreesScript } from './script.js';

export const worktreesPage: PageModule = {
  id: 'worktrees',
  group: 'project',
  label: 'Worktrees',
  icon: ICON_PATHS.worktrees,
  css: worktreesCss,
  script: worktreesScript,
};
