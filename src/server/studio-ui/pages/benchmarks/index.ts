import type { PageModule } from '../types.js';
import { ICON_PATHS } from '../../shell/icons.js';
import { benchmarksCss } from './styles.js';
import { benchmarksScript } from './script.js';

export const benchmarksPage: PageModule = {
  id: 'benchmarks',
  group: 'system',
  label: 'Benchmarks',
  icon: ICON_PATHS.benchmarks,
  css: benchmarksCss,
  script: benchmarksScript,
};
