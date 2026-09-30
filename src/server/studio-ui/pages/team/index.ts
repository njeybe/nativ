import type { PageModule } from '../types.js';
import { ICON_PATHS } from '../../shell/icons.js';
import { teamScript } from './script.js';
import { teamCss } from './styles.js';

export const teamPage: PageModule = {
  id: 'team',
  group: 'project',
  label: 'Team',
  icon: ICON_PATHS.team,
  css: teamCss,
  script: teamScript,
};
