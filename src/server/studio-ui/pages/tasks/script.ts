// Tasks page: one milestone as four columns, then the other milestones as a history list.
export const tasksScript = String.raw`  var ui = Studio.ui;
  var CAP = 5;
  var view = { lastMs: null, showAll: false, open: {} };

  function head(m) {
    var lead = m ? ui.esc(m.name) : 'The work of one milestone, by state.';
    return '<div class="panel-head"><div class="panel-title"><h1>Tasks</h1><p class="lead">' + lead + '</p></div>' +
      '<div class="panel-actions">' + ui.milestoneSelect() + '</div></div>';
  }

  function byNewest(a, b) { return (b.endT || 0) - (a.endT || 0); }

  function metaHtml(t, fmt) {
    if (t.status === 'completed') {
      return '<span>' + ui.esc(fmt.ago(t.endT)) + '</span>' + (t.durationMs ? '<span>took ' + ui.esc(fmt.dur(t.durationMs)) + '</span>' : '');
    }
    if (t.status === 'in_progress') {
      var live = t.startT ? '<span data-since="' + t.startT + '">' + fmt.dur(Studio.now() - t.startT) + '</span>' : '';
      return '<span class="run">Running ' + live + '</span><span>attempt ' + (t.attempt || 1) + ' of ' + t.maxAttempts + '</span>';
    }
    if (t.status === 'blocked') {
      return '<span class="bad">Paused after ' + (t.attempt || t.maxAttempts) + ' of ' + t.maxAttempts + ' attempts</span>';
    }
    if (t.waitingOn.length) return '<span>Waiting on ' + t.waitingOn.map(ui.esc).join(', ') + '</span>';
    return '<span>Ready to start</span>';
  }

  function card(t, fmt) {
    return '<button type="button" class="tcard ' + ui.esc(t.status) + '" data-task="' + ui.esc(t.id) + '">' +
      '<div class="l1">' + ui.statusIcon(t.status) + '<span class="mono faint">' + ui.esc(t.id) + '</span>' + ui.agentChip(t.agent) + '</div>' +
      '<div class="title">' + ui.esc(t.title) + '</div><div class="meta">' + metaHtml(t, fmt) + '</div></button>';
  }

  function column(label, status, list, shown, empty, extra, fmt) {
    var body = shown.length ? shown.map(function (t) { return card(t, fmt); }).join('') : '<div class="col-empty">' + empty + '</div>';
    return '<div class="col" data-col="' + status + '"><div class="col-head">' + ui.statusIcon(status) + label +
      '<span class="count">' + list.length + '</span></div>' + body + (extra || '') + '</div>';
  }

  function board(m, fmt) {
    var by = function (s) { return m.tasks.filter(function (t) { return t.status === s; }); };
    var done = by('completed').reverse().sort(byNewest);
    var shown = view.showAll ? done : done.slice(0, CAP);
    var more = done.length > CAP
      ? '<button type="button" class="more" data-act="tasks-more">' + (view.showAll ? 'Show fewer' : 'Show all ' + done.length) + '</button>' : '';
    var up = by('pending'), run = by('in_progress'), stuck = by('blocked');
    return '<div class="board">' +
      column('Up next', 'pending', up, up, 'Nothing queued', '', fmt) +
      column('Running', 'in_progress', run, run, 'No task is running', '', fmt) +
      column('Just finished', 'completed', done, shown, 'Nothing finished yet', more, fmt) +
      column('Stuck', 'blocked', stuck, stuck, 'Nothing is stuck', '', fmt) + '</div>';
  }

  function histRow(m, fmt) {
    var open = !!view.open[m.id];
    var full = m.total > 0 && m.done === m.total;
    var tasks = open ? '<div class="hist-tasks">' + m.tasks.slice().reverse().sort(byNewest).map(function (t) {
      return ui.taskRow(t, t.durationMs ? fmt.dur(t.durationMs) : '');
    }).join('') + '</div>' : '';
    return '<div><button type="button" class="hist-row" data-act="tasks-hist" data-ms-id="' + ui.esc(m.id) + '" aria-expanded="' + open + '">' +
      '<span class="chev">' + ui.icon('chev', 2) + '</span><span class="mono faint">' + ui.esc(m.id) + '</span>' +
      '<span class="t">' + ui.esc(m.short) + '</span>' +
      '<span class="status-pill ' + (full ? 'completed' : 'in_progress') + '">' + m.done + '/' + m.total + '</span>' +
      '<span class="faint num small">' + (m.lastEndT ? ui.esc(fmt.day(m.lastEndT)) : 'no timing') + '</span>' +
      '<span class="faint num small">' + (m.workMs ? ui.esc(fmt.dur(m.workMs)) + ' work' : '') + '</span>' +
      '<span class="faint num small">' + (m.costUsd != null ? ui.esc(fmt.money(m.costUsd)) : '') + '</span></button>' + tasks + '</div>';
  }

  function others(model, current, fmt) {
    var list = model.milestones.filter(function (m) { return m.id !== current.id; }).reverse();
    if (!list.length) return '';
    return '<h2 class="section-title">Other milestones</h2><section class="hist">' +
      list.map(function (m) { return histRow(m, fmt); }).join('') + '</section>';
  }

  Studio.registerPage('tasks', {
    deps: ['tasks', 'runs', 'escalations'],
    render: function (ctx) {
      var model = ctx.model;
      var wanted = ctx.state.milestoneId || model.activeMilestoneId;
      var m = model.milestones.filter(function (x) { return x.id === wanted; })[0];
      if (!m) return head(null) + ui.empty('No milestones yet', 'Add tasks to the plan to see them here.');
      if (view.lastMs !== m.id) { view.lastMs = m.id; view.showAll = false; }
      return head(m) + board(m, ctx.fmt) + others(model, m, ctx.fmt);
    },
    actions: {
      'tasks-more': function () { view.showAll = !view.showAll; Studio.repaint('tasks'); },
      'tasks-hist': function (el) {
        var id = el.getAttribute('data-ms-id');
        view.open[id] = !view.open[id];
        Studio.repaint('tasks');
      }
    }
  });
`;
