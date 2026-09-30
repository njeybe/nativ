import type { PageModule } from '../types.js';
import { ICON_PATHS } from '../../shell/icons.js';
import { flowScript } from './script.js';
import { flowCss } from './styles.js';

export const flowPage: PageModule = {
  id: 'flow',
  group: 'now',
  label: 'Flow',
  icon: ICON_PATHS.flow,
  css: flowCss,
  script: flowScript,
};
