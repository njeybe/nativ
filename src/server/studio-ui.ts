/**
 * Nativ Mission Control Studio: self-contained single-page dashboard.
 * The page is composed from string fragments under ./studio-ui/ in a fixed order.
 * Fragments are String.raw so client regexes keep their backslashes; client code must not
 * contain backticks or the two-character sequence dollar-brace.
 */
import { documentStart, escapeHtml, styleEnd } from './studio-ui/document.js';
import { tokensBaseCss } from './studio-ui/styles/tokens-base.js';
import { shellCss } from './studio-ui/styles/shell.js';
import { consoleCss } from './studio-ui/styles/console.js';
import { strategistCss } from './studio-ui/styles/strategist.js';
import { dialogsCss } from './studio-ui/styles/dialogs.js';
import { responsiveCss } from './studio-ui/styles/responsive.js';
import { pages } from './studio-ui/pages/index.js';
import { markupHead } from './studio-ui/shell/markup-head.js';
import { markupPanels } from './studio-ui/shell/markup-panels.js';
import { markupTools } from './studio-ui/shell/markup-tools.js';
import { coreScript } from './studio-ui/shell/core.js';
import { pureScript, wrapPage } from './studio-ui/shell/pure.js';
import { toastsFormatScript } from './studio-ui/shell/toasts-format.js';
import { pipelineStateScript } from './studio-ui/shell/pipeline-state.js';
import { actionsScript } from './studio-ui/shell/actions.js';
import { paintScript } from './studio-ui/shell/paint.js';
import { dispatchScript } from './studio-ui/shell/dispatch.js';
import { consoleScript } from './studio-ui/shell/console.js';
import { triageScript } from './studio-ui/shell/triage.js';
import { proposalsScript } from './studio-ui/shell/proposals.js';
import { syncScript } from './studio-ui/shell/sync.js';
import { routerScript } from './studio-ui/shell/router.js';
import { detailScript } from './studio-ui/shell/detail.js';
import { paletteScript } from './studio-ui/shell/palette.js';
import { eventsToolsScript } from './studio-ui/shell/events-tools.js';
import { bootScript } from './studio-ui/shell/boot.js';

export interface StudioUiOptions {
  version?: string;
  /** Project name shown in the sidebar; filled from the pipeline API when omitted. */
  projectName?: string;
}

const STYLES = [
  tokensBaseCss,
  shellCss,
  consoleCss,
  strategistCss,
  ...pages.map((p) => p.css),
  dialogsCss,
  responsiveCss,
].join('');

const BODY = [
  markupPanels(pages),
  markupTools,
  coreScript,
  pureScript,
  toastsFormatScript,
  pipelineStateScript,
  actionsScript,
  paintScript,
  dispatchScript,
  consoleScript,
  triageScript,
  proposalsScript,
  ...pages.map((p) => wrapPage(p.script)),
  syncScript,
  routerScript,
  detailScript,
  paletteScript,
  eventsToolsScript,
  bootScript(pages),
].join('');

export function renderStudioHtml(options: StudioUiOptions = {}): string {
  const version = escapeHtml(options.version ?? '1.0.0');
  const projectName = escapeHtml(options.projectName ?? '');
  const projectHidden = projectName ? '' : ' hidden';
  const head = markupHead(version, projectName, projectHidden);
  return documentStart + STYLES + styleEnd + head + BODY;
}
