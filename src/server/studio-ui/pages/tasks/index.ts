import type { PageModule } from '../types.js';
import { ICON_PATHS } from '../../shell/icons.js';
import { tasksScript } from './script.js';
import { tasksCss } from './styles.js';

export const tasksPage: PageModule = {
  id: 'tasks',
  group: 'now',
  label: 'Tasks',
  icon: ICON_PATHS.tasks,
  css: tasksCss,
  script: tasksScript,
};
