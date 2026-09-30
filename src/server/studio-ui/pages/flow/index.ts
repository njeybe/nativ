import type { PageModule } from '../types.js';
import { ICON_PATHS } from '../../shell/icons.js';

// Placeholder: a later task replaces this folder with the real page.
const script = String.raw`  Studio.registerPage('flow', {
    deps: ['tasks', 'telemetry', 'runs'],
    render: function (ctx) {
      return '<div class="page-head"><div><h1>Flow</h1><p>How the work in one milestone connects and how it actually ran.</p></div></div>' +
        ctx.ui.empty('Flow is coming soon', 'This page is being rebuilt.');
    }
  });
`;

export const flowPage: PageModule = {
  id: 'flow',
  group: 'now',
  label: 'Flow',
  icon: ICON_PATHS.flow,
  css: '',
  script,
};
