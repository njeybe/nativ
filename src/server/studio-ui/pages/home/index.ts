import type { PageModule } from '../types.js';
import { ICON_PATHS } from '../../shell/icons.js';
import { homeCss } from './styles.js';
import { homeScript } from './script.js';

export const homePage: PageModule = {
  id: 'home',
  group: 'now',
  label: 'Home',
  icon: ICON_PATHS.home,
  css: homeCss,
  script: homeScript,
};
