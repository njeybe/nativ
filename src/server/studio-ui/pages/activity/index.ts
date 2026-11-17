import type { PageModule } from '../types.js';
import { ICON_PATHS } from '../../shell/icons.js';
import { activityScript } from './script.js';
import { activityCss } from './styles.js';

export const activityPage: PageModule = {
  id: 'activity',
  group: 'now',
  label: 'Activity',
  icon: ICON_PATHS.activity,
  css: activityCss,
  script: activityScript,
};
