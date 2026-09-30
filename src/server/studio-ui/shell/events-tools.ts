// Console, strategist chip and dispatch modal event wiring.
export const eventsToolsScript = String.raw`  // ─── Events: live runner console drawer ────────────────────────────────────
  $('rc-autoscroll').addEventListener('click', function () {
    rc.autoscroll = !rc.autoscroll;
    this.setAttribute('aria-pressed', String(rc.autoscroll));
    if (rc.autoscroll) $('rc-body').scrollTop = $('rc-body').scrollHeight;
  });
  $('rc-clear').addEventListener('click', function () {
    $('rc-body').innerHTML = '<span class="rc-empty">Console cleared. New output will stream in here.</span>';
  });
  $('rc-abort').addEventListener('click', function () { if (rc.taskId) confirmAbort(rc.taskId); });
  document.querySelectorAll('.rc-tab').forEach(function (btn) {
    btn.addEventListener('click', function () { setConsoleTab(btn.getAttribute('data-rc-tab')); });
    btn.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      var tabs = visibleConsoleTabs();
      var i = tabs.indexOf(rc.tab);
      setConsoleTab(tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length], true);
    });
  });
  $('rc-diff-refresh').addEventListener('click', function () { if (rc.taskId) loadConsoleDiff(rc.taskId); });
  $('rc-heal').addEventListener('click', function (e) {
    var opt = e.target.closest('[data-t1-opt]');
    if (opt) {
      t1Choice.index = Number(opt.getAttribute('data-t1-opt'));
      $('rc-heal').querySelectorAll('[data-t1-opt]').forEach(function (b) {
        b.setAttribute('aria-checked', String(b === opt));
        b.tabIndex = b === opt ? 0 : -1;
      });
      return;
    }
    var btn = e.target.closest('[data-heal]');
    if (!btn || btn.disabled) return;
    var what = btn.getAttribute('data-heal');
    if (what === 'retry') { pipe.loaded.escalations = false; renderHeal(); fetchPipeline(['escalations']); }
    else if (what === 't1-run') runTriage(rc.taskId ? escalationFor(rc.taskId) : null);
    else if (what === 't1-decide') commitDecision('approve');
    else if (what === 't1-dismiss') commitDecision('reject');
    else resolveEscalation(what);
  });
  $('rc-heal').addEventListener('input', function (e) {
    if (e.target.id === 't1-custom') t1Choice.custom = e.target.value;
  });
  // Decision options form a radio group: arrow keys move the selection.
  $('rc-heal').addEventListener('keydown', function (e) {
    var opt = e.target.closest && e.target.closest('[data-t1-opt]');
    if (!opt || ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(e.key) === -1) return;
    e.preventDefault();
    var all = Array.prototype.slice.call($('rc-heal').querySelectorAll('[data-t1-opt]'));
    var step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : all.length - 1;
    var next = all[(all.indexOf(opt) + step) % all.length];
    next.click();
    next.focus();
  });

  // ─── Events: Tier 1 strategist chip ────────────────────────────────────────
  $('t1-chip').addEventListener('click', function () { setTriageMenu($('t1-menu').hidden); });
  $('t1-auto').addEventListener('click', function () { setAutoTriage(!(pipe.triage && pipe.triage.autoTriageEnabled)); });
  document.addEventListener('click', function (e) {
    if (!$('t1-menu').hidden && !e.target.closest('#t1')) setTriageMenu(false);
  });
  $('t1').addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || $('t1-menu').hidden) return;
    e.stopPropagation();
    setTriageMenu(false);
    $('t1-chip').focus();
  });

  // ─── Events: dispatch modal ────────────────────────────────────────────────
  document.querySelectorAll('input[name="dispatch-engine"], input[name="dispatch-budget"]').forEach(function (input) {
    input.addEventListener('change', syncDispatchEngine);
  });
  $('dispatch-worktree').addEventListener('change', syncDispatchSwitches);
  $('dispatch-verify-gate').addEventListener('change', syncDispatchSwitches);
  $('btn-launch-agent').addEventListener('click', launchDispatch);
  $('dispatch-dialog').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); launchDispatch(); }
  });
  $('dispatch-dialog').addEventListener('close', function () { pendingDispatch = null; });
  $('rc-minimize').addEventListener('click', toggleConsoleMinimized);
  $('rc-close').addEventListener('click', closeConsole);
  $('runner-console-drawer').addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.stopPropagation(); closeConsole(); $('main').focus(); }
  });

  $('btn-confirm-ok').addEventListener('click', function () {
    var fn = pendingConfirm;
    pendingConfirm = null;
    $('confirm-dialog').close();
    if (fn) fn();
  });

`;
