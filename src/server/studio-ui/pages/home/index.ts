import type { PageModule } from '../types.js';
import { ICON_PATHS } from '../../shell/icons.js';

// Placeholder: a later task replaces this folder with the real page.
const script = String.raw`  Studio.registerPage('home', {
    deps: ['status', 'tasks', 'telemetry', 'runs', 'escalations'],
    render: function (ctx) {
      return '<div class="page-head"><div><h1>Home</h1><p>What needs you, what is running, and what just finished.</p></div></div>' +
        ctx.ui.empty('Home is coming soon', 'This page is being rebuilt.');
    }
  });
`;

export const homePage: PageModule = {
  id: 'home',
  group: 'now',
  label: 'Home',
  icon: ICON_PATHS.home,
  css: '',
  script,
};
