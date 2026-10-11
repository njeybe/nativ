// Home page client script: one pure render from the shared model, sections stacked top to bottom.
export const homeScript = String.raw`  var esc = Studio.ui.esc;
  var UP_NEXT_CAP = 6;
  var ACTIVITY_CAP = 8;

  function head() {
    return '<div class="page-head"><h1>Home</h1></div>';
  }

  function section(key, title, right, body) {
    return '<section class="home-sec" data-sec="' + key + '"><div class="sec-head"><h2>' + esc(title) +
      '</h2>' + (right || '') + '</div>' + body + '</section>';
  }
  function rightText(text) { return '<span class="right">' + esc(text) + '</span>'; }

  function actBtn(act, id, label, busy, cls) {
    var on = busy === act.slice(5);
    return '<button type="button" class="btn' + (cls ? ' ' + cls : '') + '" data-act="' + act +
      '" data-id="' + esc(id) + '"' + (busy ? ' disabled' : '') + '>' +
      (on ? '<span class="spinner" aria-hidden="true"></span>' : '') + esc(label) + '</button>';
  }

  function needReason(item) {
    var t = item.task;
    if (t.status === 'blocked') return t.reason || 'Paused after 3 attempts.';
    var e = item.escalation || {};
    return e.reason || e.summary || e.details || 'Waiting for your decision.';
  }

  function needActions(item) {
    var t = item.task;
    var busy = Studio.busyAction ? Studio.busyAction(t.id) : null;
    var stuck = t.status === 'blocked';
    var out = '<button type="button" class="btn" data-task="' + esc(t.id) + '">' +
      (stuck ? 'See what failed' : 'Open task') + '</button>';
    if (stuck) out += actBtn('home-start', t.id, 'Try again', busy);
    if (item.hasProposal) out += actBtn('home-proposal', t.id, 'Review proposal', busy, 'primary');
    else if (item.escalation) out += actBtn('home-ask', t.id, 'Ask the architect', busy, 'primary');
    return out;
  }

  function needItem(item) {
    var t = item.task;
    return '<div class="need" data-need="' + esc(t.id) + '"><div class="body">' +
      '<div class="l1"><b>Human Decision Required</b><span class="mono">' + esc(t.id) + '</span></div>' +
      '<span class="why">' + esc(needReason(item)) + '</span></div>' +
      '<div class="acts">' + needActions(item) + '</div></div>';
  }

  function decisionQueue(model) {
    var n = model.needsYou;
    if (!n.length) return '';
    var count = n.length + (n.length === 1 ? ' item' : ' items');
    return '<section class="home-sec decisions" data-sec="decisions"><div class="sec-head"><h2>Decisions</h2>' +
      rightText(count) + '</div>' + n.map(needItem).join('') + '</section>';
  }

  function isReady(model, t) {
    if (t.status !== 'pending') return false;
    return t.isAvailable || t.deps.every(function (d) {
      var dep = model.byId[d];
      return !dep || dep.status === 'completed';
    });
  }

  function readyTasks(model) {
    return model.tasks.filter(function (t) { return isReady(model, t); });
  }

  function dispatchBtn(id, label, cls) {
    return '<button type="button" class="btn' + (cls ? ' ' + cls : '') + '" data-act="home-dispatch" data-id="' +
      esc(id) + '">' + esc(label) + '</button>';
  }

  function taskCells(t) {
    return '<span class="mono id">' + esc(t.id) + '</span>' +
      '<button type="button" class="t link" data-task="' + esc(t.id) + '">' + esc(t.title) + '</button>' +
      '<span class="agent">' + esc(t.agent || '') + '</span>';
  }

  function runRow(t) {
    var since = t.startT ? ' data-since="' + t.startT + '">' + Studio.fmt.dur(Studio.now() - t.startT) : '>';
    var row = '<div class="row run-row">' + taskCells(t) +
      '<span class="state"><i class="dot run"></i>Running</span>' +
      '<span class="mono num timer"' + since + '</span></div>';
    var log = '<span class="mono log">' + esc(t.latestLog || '') + '</span>';
    return row + '<div class="row sub-row">' + log + '<button type="button" class="btn" data-act="home-console"' +
      ' data-id="' + esc(t.id) + '">Open console</button></div>';
  }

  function nowRunning(model) {
    var r = model.running;
    if (r.length) return section('running', 'Now running', rightText(r.length + ' running'), r.map(runRow).join(''));
    var next = readyTasks(model)[0];
    var btn = next ? dispatchBtn(next.id, 'Dispatch ' + next.id, 'primary') : '';
    return section('running', 'Now running', '', '<div class="row calm"><span>No agent is running.</span>' + btn + '</div>');
  }

  function waitOn(model, t) {
    var open = t.deps.filter(function (d) { var x = model.byId[d]; return x && x.status !== 'completed'; });
    return open[0] || '';
  }

  function nextRow(model, t) {
    var end = isReady(model, t) ? dispatchBtn(t.id, 'Dispatch') :
      '<span class="wait">waits <span class="mono">' + esc(waitOn(model, t)) + '</span></span>';
    return '<div class="row next-row">' + taskCells(t) + end + '</div>';
  }

  function upNext(model) {
    var list = model.tasks.filter(function (t) { return t.status === 'pending'; });
    var ready = list.filter(function (t) { return isReady(model, t); });
    var waiting = list.filter(function (t) { return !isReady(model, t); });
    var rows = ready.concat(waiting).slice(0, UP_NEXT_CAP);
    var body = rows.length ? rows.map(function (t) { return nextRow(model, t); }).join('') :
      '<div class="row calm">Nothing is waiting.</div>';
    return section('next', 'Up next', '', body);
  }

  function milestoneProgress(model) {
    var m = model.milestones.filter(function (x) { return x.id === model.activeMilestoneId; })[0];
    if (!m) return '';
    var pct = m.total ? Math.round((m.done / m.total) * 100) : 0;
    var body = '<div class="row ms-row" data-ms="' + esc(m.id) + '"><span class="mono id">' + esc(m.id) + '</span>' +
      '<span class="t">' + esc(m.name) + '</span><span class="mono num">' + m.done + ' of ' + m.total + '</span></div>' +
      '<div class="progress"><i style="width:' + pct + '%"></i></div>';
    return section('milestone', 'Milestone', '', body);
  }

  function activityEvents(model) {
    var out = [];
    model.tasks.forEach(function (t) {
      if (t.endT) out.push({ at: t.endT, id: t.id, what: 'completed' });
      if (t.startT) out.push({ at: t.startT, id: t.id, what: 'started' });
    });
    return out.sort(function (a, b) { return b.at - a.at; }).slice(0, ACTIVITY_CAP);
  }

  function activityRow(e) {
    return '<div class="row act-row" data-event="' + esc(e.id) + '"><span class="mono num when">' +
      Studio.ui.when(e.at) + '</span><span class="mono id">' + esc(e.id) + '</span><span>' + e.what + '</span></div>';
  }

  function recentActivity(model) {
    var list = activityEvents(model);
    var body = list.length ? list.map(activityRow).join('') : '<div class="row calm">Nothing has happened yet.</div>';
    return section('activity', 'Recent activity', '', body);
  }

  function skeleton() {
    var row = '<div class="row skel-row"><div class="skel"></div></div>';
    return '<div class="home">' + head() + '<section class="home-sec" aria-busy="true">' +
      row + row + row + row + '</section></div>';
  }

  function render(ctx) {
    var model = ctx.model;
    if (!model.milestones.length) {
      return '<div class="home">' + head() +
        '<div class="row calm">No plan yet. Ask the architect to design one.</div></div>';
    }
    return '<div class="home">' + head() + decisionQueue(model) + nowRunning(model) + upNext(model) +
      milestoneProgress(model) + recentActivity(model) + '</div>';
  }

  function forward(name) {
    return function (el) { Studio.taskAction(name, el.getAttribute('data-id')); };
  }

  Studio.registerPage('home', {
    deps: ['status', 'tasks', 'telemetry', 'runs', 'escalations'],
    render: render,
    skeleton: skeleton,
    actions: {
      'home-start': forward('start'), 'home-proposal': forward('proposal'), 'home-ask': forward('ask'),
      'home-console': forward('logs'), 'home-dispatch': forward('dispatch')
    }
  });
`;
