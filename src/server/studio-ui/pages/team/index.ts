import type { PageModule } from '../types.js';
import { ICON_PATHS } from '../../shell/icons.js';

// Placeholder: a later task replaces this folder with the real page.
const script = String.raw`  Studio.registerPage('team', {
    deps: ['tasks', 'telemetry', 'runs'],
    render: function (ctx) {
      return '<div class="page-head"><div><h1>Team</h1><p>Each agent in plain terms: what it did, how long it took, what it cost.</p></div></div>' +
        ctx.ui.empty('Team is coming soon', 'This page is being rebuilt.');
    }
  });
`;

export const teamPage: PageModule = {
  id: 'team',
  group: 'project',
  label: 'Team',
  icon: ICON_PATHS.team,
  css: '',
  script,
};
