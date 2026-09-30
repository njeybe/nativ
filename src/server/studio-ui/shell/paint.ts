// Painting: pages, sidebar, banner, plus small fragments the kept pages still use.
export const paintScript = String.raw`  // ─── Painting ──────────────────────────────────────────────────────────────
  function cssEsc(v) { return window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/["\\]/g, '\\$&'); }

  function focusMemo(root) {
    var el = document.activeElement;
    if (!el || el === document.body || el === root || !root.contains(el)) return null;
    var sel = null;
    if (el.id) sel = '#' + cssEsc(el.id);
    else if (el.getAttribute('data-act')) {
      sel = '[data-act="' + cssEsc(el.getAttribute('data-act')) + '"]';
      if (el.getAttribute('data-key')) sel += '[data-key="' + cssEsc(el.getAttribute('data-key')) + '"]';
    } else if (el.hasAttribute('data-ms-select')) sel = '[data-ms-select]';
    return sel ? { sel: sel, start: el.selectionStart, end: el.selectionEnd } : null;
  }

  function restoreFocus(root, memo) {
    if (!memo) return;
    var el = root.querySelector(memo.sel);
    if (!el || el.disabled) return;
    el.focus({ preventScroll: true });
    if (memo.start != null && typeof el.setSelectionRange === 'function') {
      try { el.setSelectionRange(memo.start, memo.end); } catch (e) { /* ignore */ }
    }
  }

  /** A page is loading until every server slice it depends on has answered once. */
  function isPageLoading(def) {
    return (def.deps || []).some(function (d) { return PIPE_PATHS[d] && !pipe.loaded[d]; });
  }

  function pageCtx(panel) {
    return { model: Studio.model, state: Studio.state, fmt: fmt, ui: ui, width: panel ? panel.clientWidth : 0 };
  }

  /** Renders one page into its panel; keeps focus and skips the write when nothing changed. */
  function paintPage(id) {
    var def = Studio.pages[id];
    var panel = $('panel-' + id);
    if (!def || !panel || !def.render) return;
    var ctx = pageCtx(panel);
    var html = isPageLoading(def) || !Studio.model ? (def.skeleton ? def.skeleton(ctx) : ui.skeleton()) : def.render(ctx);
    panel.setAttribute('aria-busy', String(isPageLoading(def)));
    if (panel.__html === html) return;
    var memo = focusMemo(panel);
    panel.innerHTML = html;
    panel.__html = html;
    restoreFocus(panel, memo);
  }

  /** Repaints a page (kept pages call this after their own state changes). */
  function repaint(view) {
    if (Studio.state.view !== view) return;
    paintPage(view);
    paintChrome();
  }
  Studio.repaint = function (id) { paintPage(id || Studio.state.view); };

  function repaintFor(parts) {
    var id = Studio.state.view;
    var def = Studio.pages[id];
    if (!def || !def.render) return;
    if (!parts || (def.deps || []).some(function (d) { return parts.indexOf(d) !== -1; })) paintPage(id);
  }

  function paintChrome() {
    var side = $('side-nav');
    var main = mainWorktree();
    var agents = pipe.worktrees.filter(function (w) { return w.isAgentWorktree; }).length;
    var s = pipe.report && pipe.report.summary;
    var navHtml = Studio.sidebarHtml({
      model: Studio.model, view: Studio.state.view,
      worktreeCount: pipe.loaded.worktrees && !pipe.errors.worktrees ? agents : null,
      benchmarkText: s ? compactNum(Number(s.averageThroughputOpsPerSec) || 0) : ''
    });
    if (side.__html !== navHtml) { side.innerHTML = navHtml; side.__html = navHtml; }
    var foot = $('side-foot');
    var footHtml = Studio.sideFootHtml({ root: main ? String(main.path || '') : '', branch: main ? (main.branch || 'detached') : '' });
    if (foot.__html !== footHtml) { foot.innerHTML = footHtml; foot.__html = footHtml; }
    var lost = !!(pipe.errors.tasks || pipe.errors.status) || live.mode === 'offline';
    $('banner').hidden = !lost;
  }

  /** One entry point after data or state changes: model, sidebar, current page, panel, palette. */
  function refreshUi(parts) {
    rebuildModel();
    paintChrome();
    repaintFor(parts);
    refreshDetail();
    refreshPalette();
    backfillLogs();
  }

  var uiTimer = null, uiParts = {};
  function queueUiRefresh(parts) {
    parts.forEach(function (p) { uiParts[p] = true; });
    if (uiTimer) return;
    uiTimer = setTimeout(function () {
      var list = Object.keys(uiParts);
      uiParts = {};
      uiTimer = null;
      refreshUi(list);
    }, 250);
  }

  /** Newest output line per task comes from the live stream and, once, from the log tail. */
  function feedLogTail(entry) {
    pipe.logTail[entry.taskId] = ((pipe.logTail[entry.taskId] || '') + (entry.chunk || '')).slice(-2000);
    queueUiRefresh(['logs']);
  }
  var logAsked = {};
  function backfillLogs() {
    if (!Studio.model) return;
    Studio.model.running.forEach(function (t) {
      if (logAsked[t.id] || pipe.logTail[t.id] != null) return;
      logAsked[t.id] = true;
      api('/api/pipeline/tasks/logs?taskId=' + encodeURIComponent(t.id) + '&tailLines=20').then(function (body) {
        pipe.logTail[t.id] = body.log || '';
        queueUiRefresh(['logs']);
      }, function () { /* no log yet */ });
    });
  }

  // Fragments the kept pages (Worktrees, Benchmarks) still use.
  function panelHead(title, lead, actions) {
    return '<div class="panel-head"><div class="panel-title"><h1>' + title + '</h1>' + (lead ? '<p class="lead">' + lead + '</p>' : '') + '</div>' +
      (actions ? '<div class="panel-actions">' + actions + '</div>' : '') + '</div>';
  }

  function progressBar(pct, key, label, tone) {
    return '<div class="progress' + (tone ? ' ' + tone : '') + '" role="progressbar" aria-label="' + esc(label) + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '">' +
      '<span style="width:' + pct + '%"></span></div>';
  }

  function errorCard(what, message, part) {
    var missing = /No route for|NOT_FOUND|\(404\)/.test(message || '');
    return '<div class="card state state-error" role="alert"><div class="state-icon">' + ICON.alert + '</div>' +
      '<h2>Could not load ' + esc(what) + '</h2><p>' + esc(message) + '</p>' +
      (missing ? '<p>This studio server does not expose the pipeline API yet. Restart it with a nativ build that includes the Mission Control endpoints.</p>' : '') +
      '<button class="btn" type="button" data-act="retry" data-key="' + part + '">Retry</button></div>';
  }

  /** Data is still shown after a failed live refresh; say so instead of silently going stale. */
  function staleNote(part) {
    return pipe.errors[part] ? '<p class="notice" role="status">Showing the last synced data. Refresh failed: ' + esc(pipe.errors[part]) + '</p>' : '';
  }

  function skeletonCards(n, cls) {
    var out = '';
    for (var i = 0; i < n; i++) out += '<div class="card ' + (cls || 'kpi') + '"><div class="skeleton short"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
    return out;
  }

`;
