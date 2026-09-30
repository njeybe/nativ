import type { PageModule } from '../types.js';
import { ICON_PATHS } from '../../shell/icons.js';
import { databaseCss } from './styles.js';
import { databaseMarkup } from './markup.js';
import { databaseStateScript, databaseRegisterScript } from './state.js';
import { databaseDataScript } from './data-shell.js';
import { databaseExplorerScript } from './explorer.js';
import { databaseBrowserScript } from './browser.js';
import { databaseDriftScript } from './drift.js';
import { databaseConnectionScript } from './connection.js';
import { databaseEventsScript } from './events.js';

export const databasePage: PageModule = {
  id: 'database',
  group: 'system',
  label: 'Database',
  icon: ICON_PATHS.database,
  css: databaseCss,
  markup: databaseMarkup,
  script: [
    databaseStateScript,
    databaseDataScript,
    databaseExplorerScript,
    databaseBrowserScript,
    databaseDriftScript,
    databaseConnectionScript,
    databaseEventsScript,
    databaseRegisterScript,
  ].join(''),
};
