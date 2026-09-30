// Task detail panel: opens from any data-task, closes with Esc, returns focus to its opener.
export const detailScript = String.raw`  // ─── Task detail panel ─────────────────────────────────────────────────────
  var detail = { opener: null, html: '' };

  function detailEnv(id) {
    var esc1 = escalationFor(id);
    return { busy: Studio.busyAction(id), triaging: !!(esc1 && pipe.triageRunning[esc1.id]) };
  }

  function showDetail(id) {
    var drawer = $('task-drawer');
    var html = Studio.detailHtml(id, detailEnv(id));
    var memo = focusMemo(drawer);
    if (html !== detail.html) { drawer.innerHTML = html; detail.html = html; restoreFocus(drawer, memo); }
    drawer.hidden = false;
    $('scrim').hidden = false;
  }

  function openDetail(id) {
    if (!Studio.model || !Studio.model.byId[id]) return;
    if (!Studio.state.detailTaskId) detail.opener = document.activeElement;
    Studio.state.detailTaskId = id;
    showDetail(id);
    if (!$('task-drawer').contains(document.activeElement)) {
      var close = $('task-drawer').querySelector('[data-act="close-detail"]');
      if (close) close.focus();
    }
  }
  Studio.openTask = openDetail;

  /** Re-renders the open panel after a model change; closes it if the task disappeared. */
  function refreshDetail() {
    var id = Studio.state.detailTaskId;
    if (!id) return;
    if (!Studio.model || !Studio.model.byId[id]) closeDetail(false);
    else showDetail(id);
  }

  function closeDetail(quiet) {
    var S = Studio.state;
    var wasOpen = !!S.detailTaskId;
    S.detailTaskId = null;
    $('task-drawer').hidden = true;
    $('scrim').hidden = true;
    $('task-drawer').innerHTML = '';
    detail.html = '';
    var hadFocus = !!S.focusTaskId;
    S.focusTaskId = null;
    if (quiet) return;
    if (hadFocus) repaintFor(null);
    var opener = detail.opener;
    detail.opener = null;
    if (wasOpen && opener && document.body.contains(opener) && opener.focus) opener.focus();
  }
  Studio.closeDetail = function () { closeDetail(false); };

  $('scrim').addEventListener('click', function () { closeDetail(false); });
  $('task-drawer').addEventListener('click', function (e) {
    var t = e.target;
    var task = t.closest('[data-task]');
    if (task) { openDetail(task.getAttribute('data-task')); return; }
    var ms = t.closest('[data-ms]');
    if (ms) { Studio.go('tasks', { milestoneId: ms.getAttribute('data-ms') }); return; }
    var act = t.closest('[data-act]');
    if (!act || act.disabled) return;
    var name = act.getAttribute('data-act');
    var id = Studio.state.detailTaskId;
    if (name === 'close-detail') closeDetail(false);
    else if (name === 'show-flow') Studio.taskAction('flow', id);
    else if (name.indexOf('task-') === 0) Studio.taskAction(name.slice(5), id);
  });

  // Keep Tab inside the panel while it is open.
  $('task-drawer').addEventListener('keydown', function (e) {
    if (e.key !== 'Tab') return;
    var items = $('task-drawer').querySelectorAll('button:not([disabled]), [href], select, input');
    if (!items.length) return;
    var first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

`;
