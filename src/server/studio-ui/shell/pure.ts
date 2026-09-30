import { formatScript } from './format.js';
import { modelScript } from './model.js';
import { sidebarViewScript } from './sidebar-view.js';
import { paletteViewScript } from './palette-view.js';
import { detailViewScript } from './detail-view.js';

// Everything that needs no DOM; the test harness runs exactly this in node:vm.
export const pureScript = [formatScript, modelScript, sidebarViewScript, paletteViewScript, detailViewScript].join('');

/** Runs a page script in its own function scope with the Studio API. */
export const wrapPage = (script: string): string => `  (function (Studio) {\n${script}\n  })(Studio);\n`;
