import type { PageModule } from '../types.js';
import { ICON_PATHS } from '../../shell/icons.js';

// Placeholder: a later task replaces this folder with the real page.
const script = String.raw`  Studio.registerPage('tasks', {
    deps: ['tasks', 'runs', 'escalations'],
    render: function (ctx) {
      return '<div class="page-head"><div><h1>Tasks</h1><p>The work of one milestone, by state.</p></div></div>' +
        ctx.ui.empty('Tasks is coming soon', 'This page is being rebuilt.');
    }
  });
`;

export const tasksPage: PageModule = {
  id: 'tasks',
  group: 'now',
  label: 'Tasks',
  icon: ICON_PATHS.tasks,
  css: '',
  script,
};
