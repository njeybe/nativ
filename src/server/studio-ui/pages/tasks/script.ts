// Tasks page: a grouped list by default, or one milestone as four columns (Board).
export const tasksScript = String.raw`  var ui = Studio.ui;
  var CAP = 5;
  var view = { lastMs: null, showAll: false, open: {}, mode: null, filter: 'all', groups: {} };
  var KEY = 'nativ-studio:tasks-view';
  var FILTERS = [['all', 'All'], ['running', 'Running'], ['ready', 'Ready'], ['blocked', 'Blocked'],
    ['done', 'Done']];
  var DOT = { completed: 'ok', in_progress: 'run', blocked: 'bad', ready: 'fg', waiting: 'faint' };
  var LABEL = { completed: 'Done', in_progress: 'Running', blocked: 'Blocked', ready: 'Ready',
    waiting: 'Waiting' };

  function readMode() {
    try { return localStorage.getItem(KEY) === 'board' ? 'board' : 'list'; } catch (e) { return 'list'; }
  }
  function saveMode(mode) {
    try { localStorage.setItem(KEY, mode); } catch (e) { /* private mode */ }
  }

  // Same notion of ready as Home and the sidebar: pending and every dependency done.
  function isReady(model, t) {
    if (t.status !== 'pending') return false;
    return t.isAvailable || t.deps.every(function (d) {
      var dep = model.byId && model.byId[d];
      return !dep || dep.status === 'completed';
    });
  }
  function kindOf(model, t) {
    if (t.status === 'pending') return isReady(model, t) ? 'ready' : 'waiting';
    return t.status;
  }
  function matches(model, t, f) {
    if (f === 'all') return true;
    if (f === 'running') return t.status === 'in_progress';
    if (f === 'blocked') return t.status === 'blocked';
    if (f === 'done') return t.status === 'completed';
    return isReady(model, t);
  }

  function toolbar(model) {
    var chips = FILTERS.map(function (f) {
      var on = view.filter === f[0];
      var n = model.tasks.filter(function (t) { return matches(model, t, f[0]); }).length;
      return '<button type="button" class="tf' + (on ? ' on' : '') + '" data-act="tasks-filter" data-filter="' +
        f[0] + '" aria-pressed="' + on + '">' + f[1] + ' <span class="num">' + n + '</span></button>';
    }).join('');
    var seg = ['list', 'board'].map(function (m) {
      var on = view.mode === m;
      return '<button type="button" class="seg' + (on ? ' on' : '') + '" data-act="tasks-view" data-mode="' +
        m + '" aria-pressed="' + on + '">' + (m === 'list' ? 'List' : 'Board') + '</button>';
    }).join('');
    return '<div class="tbar"><div class="tfilters" role="group" aria-label="Filter tasks">' + chips +
      '</div><div class="tseg" role="group" aria-label="View">' + seg + '</div></div>';
  }

  function timeOf(t, fmt) {
    if (t.status === 'in_progress' && t.startT) return fmt.dur(Studio.now() - t.startT);
    return t.durationMs ? fmt.dur(t.durationMs) : '';
  }

  // Rows use data-tid, not data-task, so the nested Dispatch button gets its own click.
  function listRow(model, t, fmt) {
    var k = kindOf(model, t);
    var id = ui.esc(t.id);
    var go = k === 'ready' ? '<button type="button" class="tdispatch" data-act="tasks-dispatch" data-tid="' +
      id + '">Dispatch</button>' : '';
    return '<div class="trow" role="row" tabindex="0" data-act="tasks-open" data-tid="' + id + '">' +
      '<span class="c-id mono" role="cell">' + id + '</span>' +
      '<span class="c-title" role="cell" title="' + ui.esc(t.title) + '">' + ui.esc(t.title) + '</span>' +
      '<span class="c-agent" role="cell">' + ui.esc(t.agent || '') + '</span>' +
      '<span class="c-status st-' + DOT[k] + '" role="cell"><i class="dot"></i>' + LABEL[k] + go + '</span>' +
      '<span class="c-time mono" role="cell">' + ui.esc(timeOf(t, fmt)) + '</span></div>';
  }

  function isOpen(m) {
    if (view.groups[m.id] != null) return view.groups[m.id];
    return !(m.total > 0 && m.done === m.total);
  }

  var THEAD = '<div class="trow thead" role="row"><span role="columnheader">Id</span>' +
    '<span role="columnheader">Task</span><span class="c-agent" role="columnheader">Agent</span>' +
    '<span role="columnheader">Status</span><span class="c-time" role="columnheader">Time</span></div>';

  function group(model, m, rows, fmt) {
    var open = isOpen(m);
    var body = open ? THEAD + rows.map(function (t) { return listRow(model, t, fmt); }).join('') : '';
    return '<section class="tgroup" role="table" aria-label="' + ui.esc(m.name) + '">' +
      '<button type="button" class="tg-head" data-act="tasks-group" data-group="' + ui.esc(m.id) +
      '" aria-expanded="' + open + '"><span class="chev">' + ui.icon('chev', 2) + '</span>' +
      '<span class="mono faint">' + ui.esc(m.id) + '</span><span class="t">' + ui.esc(m.name) + '</span>' +
      '<span class="num faint">' + m.done + ' of ' + m.total + '</span></button>' + body + '</section>';
  }

  function list(model, fmt) {
    var html = model.milestones.map(function (m) {
      var rows = m.tasks.filter(function (t) { return matches(model, t, view.filter); });
      return rows.length ? group(model, m, rows, fmt) : '';
    }).join('');
    if (html) return '<div class="tlist">' + html + '</div>';
    return '<div class="tempty"><p>No tasks match this filter.</p>' +
      '<button type="button" class="btn" data-act="tasks-clear">Clear filter</button></div>';
  }

  function skeleton() {
    var row = '<div class="trow tskel"><span></span><span></span><span></span><span></span><span></span></div>';
    return '<div class="panel-head"><div class="panel-title"><h1>Tasks</h1></div></div>' +
      '<div class="tlist">' + row + row + row + row + row + '</div>';
  }

  // The pulse strip leaves a filter on Studio.taskFilter; use it once.
  function takeFilter() {
    var f = Studio.taskFilter;
    if (f && FILTERS.some(function (x) { return x[0] === f; })) view.filter = f;
    Studio.taskFilter = null;
  }

  function onlyFiltered(model, m) {
    var copy = Object.assign({}, m);
    copy.tasks = m.tasks.filter(function (t) { return matches(model, t, view.filter); });
    return copy;
  }

  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('keydown', function (e) {
      var el = e.target;
      if (e.key !== 'Enter' || !el || !el.matches || !el.matches('.trow[data-tid]')) return;
      e.preventDefault();
      Studio.taskAction('logs', el.getAttribute('data-tid'));
    });
  }

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
    skeleton: skeleton,
    render: function (ctx) {
      var model = ctx.model;
      if (!view.mode) view.mode = ctx.state.tasksView || readMode();
      takeFilter();
      if (!model.milestones.length) {
        return head(null) + '<div class="tempty"><p>No plan yet. Ask the architect to design one.</p></div>';
      }
      if (view.mode === 'list') return head(null) + toolbar(model) + list(model, ctx.fmt);
      var wanted = ctx.state.milestoneId || model.activeMilestoneId;
      var m = model.milestones.filter(function (x) { return x.id === wanted; })[0];
      if (!m) return head(null) + ui.empty('No milestones yet', 'Add tasks to the plan to see them here.');
      if (view.lastMs !== m.id) { view.lastMs = m.id; view.showAll = false; }
      return head(m) + toolbar(model) + board(onlyFiltered(model, m), ctx.fmt) + others(model, m, ctx.fmt);
    },
    actions: {
      'tasks-view': function (el) {
        view.mode = el.getAttribute('data-mode');
        saveMode(view.mode);
        Studio.repaint('tasks');
      },
      'tasks-filter': function (el) { view.filter = el.getAttribute('data-filter'); Studio.repaint('tasks'); },
      'tasks-clear': function () { view.filter = 'all'; Studio.repaint('tasks'); },
      'tasks-open': function (el) { Studio.taskAction('logs', el.getAttribute('data-tid')); },
      'tasks-dispatch': function (el) { Studio.taskAction('dispatch', el.getAttribute('data-tid')); },
      'tasks-group': function (el, ctx) {
        var id = el.getAttribute('data-group');
        var m = ctx.model.milestones.filter(function (x) { return x.id === id; })[0];
        view.groups[id] = !(m && isOpen(m));
        Studio.repaint('tasks');
      },
      'tasks-more': function () { view.showAll = !view.showAll; Studio.repaint('tasks'); },
      'tasks-hist': function (el) {
        var id = el.getAttribute('data-ms-id');
        view.open[id] = !view.open[id];
        Studio.repaint('tasks');
      }
    }
  });
`;
