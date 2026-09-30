// Routing, shell-wide click handling, theme toggle and live timers.
export const routerScript = String.raw`  // ─── Router and shell-wide events ──────────────────────────────────────────
  function pageIds() { return Studio.order.map(function (p) { return p.id; }); }

  function setView(view) {
    Studio.state.view = view;
    Studio.order.forEach(function (p) {
      var el = $('panel-' + p.id);
      if (el) el.hidden = p.id !== view;
      if (p.id === view) $('crumb-view').textContent = p.label;
    });
    if (location.hash !== '#' + view && window.history && history.replaceState) history.replaceState(null, '', '#' + view);
    paintChrome();
    var def = Studio.pages[view];
    if (def && def.onShow) def.onShow();
    paintPage(view);
  }

  Studio.go = function (view, opts) {
    opts = opts || {};
    if (!Studio.pages[view]) return;
    var S = Studio.state;
    if (!opts.keepDetail) closeDetail(true);
    if (opts.milestoneId) S.milestoneId = opts.milestoneId;
    S.focusTaskId = opts.focusTaskId || null;
    setView(view);
    if (opts.scroll !== false) window.scrollTo(0, 0);
  };

  window.addEventListener('hashchange', function () {
    var v = Studio.resolveHash(location.hash, pageIds());
    if (v !== Studio.state.view) Studio.go(v);
  });

  function currentActions() {
    var def = Studio.pages[Studio.state.view];
    return (def && def.actions) || {};
  }

  $('main').addEventListener('click', function (e) {
    var t = e.target;
    var task = t.closest('[data-task]');
    if (task) { openDetail(task.getAttribute('data-task')); return; }
    var go = t.closest('[data-go]');
    if (go) { Studio.go(go.getAttribute('data-go')); return; }
    var ms = t.closest('[data-ms]');
    if (ms) { Studio.go('tasks', { milestoneId: ms.getAttribute('data-ms') }); return; }
    var act = t.closest('[data-act]');
    if (!act || act.disabled) return;
    var name = act.getAttribute('data-act');
    var handler = currentActions()[name];
    if (handler) handler(act, pageCtx($('panel-' + Studio.state.view)));
    else if (name === 'retry' && PIPE_PATHS[act.getAttribute('data-key')]) fetchPipeline([act.getAttribute('data-key')]);
  });
  $('side-nav').addEventListener('click', function (e) {
    var go = e.target.closest('[data-go]');
    if (go) Studio.go(go.getAttribute('data-go'));
  });

  $('main').addEventListener('change', function (e) {
    if (!e.target.hasAttribute || !e.target.hasAttribute('data-ms-select')) return;
    Studio.state.milestoneId = e.target.value;
    Studio.state.focusTaskId = null;
    repaintFor(null);
  });

  $('banner-retry').addEventListener('click', function () {
    fetchPipeline(ALL_PARTS);
    connectEvents();
  });

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('nativ-studio:theme', theme); } catch (e) { /* private mode */ }
  }
  $('btn-theme').addEventListener('click', function () {
    var root = document.documentElement;
    var dark = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
    var cur = root.getAttribute('data-theme') || (dark ? 'dark' : 'light');
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  });

  // Live timers: any element with data-since counts up from that moment.
  setInterval(function () {
    var now = Studio.now();
    document.querySelectorAll('[data-since]').forEach(function (el) {
      el.textContent = fmt.dur(now - Number(el.getAttribute('data-since')));
    });
  }, 1000);

  Studio.api = api;
  Studio.postJson = postJson;
  Studio.toast = function (message, kind) { toast(message, kind); };

`;
