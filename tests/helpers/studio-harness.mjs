// Runs the Studio shell helpers and one page script in node:vm, so page tests need no DOM.
// Load with `npx tsx`: the Studio sources are imported straight from TypeScript.
import vm from 'node:vm';
import { pureScript, wrapPage } from '../../src/server/studio-ui/shell/pure.ts';
import { pages } from '../../src/server/studio-ui/pages/index.ts';

export const NOW = Date.parse('2026-09-30T12:00:00.000Z');

/** A fresh Studio (shell helpers only). `now` fixes the clock used by fmt.ago. */
export function createStudio({ now = NOW } = {}) {
  const ctx = vm.createContext({ Date, Math, JSON, Object, Array, String, Number, isNaN, isFinite, parseInt });
  vm.runInContext(pureScript, ctx, { filename: 'studio-shell.js' });
  const order = pages.map((p) => ({ id: p.id, group: p.group, label: p.label, icon: p.icon }));
  vm.runInContext(`Studio.order = ${JSON.stringify(order)}; Studio.now = function () { return ${now}; };`, ctx);
  return ctx;
}

/** Evaluates an expression in the Studio context and returns a plain value. */
export function run(ctx, code) {
  return vm.runInContext(code, ctx);
}

/** Builds the client model from fixture API slices and stores it on Studio. */
export function loadModel(ctx, api) {
  ctx.__api = api;
  vm.runInContext('Studio.setModel(Studio.buildModel(__api));', ctx);
  return vm.runInContext('Studio.model', ctx);
}

/** Registers one page script and returns the HTML its render() gives for the fixture data. */
export function renderPage(pageId, api, { state, width = 1200, now = NOW } = {}) {
  const page = pages.find((p) => p.id === pageId);
  if (!page) throw new Error(`No page module "${pageId}"`);
  const ctx = createStudio({ now });
  loadModel(ctx, api);
  if (state) Object.assign(ctx.Studio.state, state);
  vm.runInContext(wrapPage(page.script), ctx, { filename: `page-${pageId}.js` });
  ctx.__width = width;
  return vm.runInContext(
    `(function () { var def = Studio.pages['${pageId}'];
      return def.render({ model: Studio.model, state: Studio.state, fmt: Studio.fmt, ui: Studio.ui, width: __width }); })()`,
    ctx,
  );
}
