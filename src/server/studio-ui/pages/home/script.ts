// Home page client script: one pure render from the shared model.
export const homeScript = String.raw`  var esc = Studio.ui.esc;
  var RECENT_CAP = 6;

  function head() {
    return '<div class="page-head"><div><h1>Home</h1><p>What needs you, what is running, and what just finished.</p></div></div>';
  }

  function panel(title, right, body) {
    return '<section class="panel"><div class="panel-head"><h2>' + esc(title) + '</h2>' + right + '</div>' + body + '</section>';
  }
  function rightText(text) { return '<span class="right">' + esc(text) + '</span>'; }

  function actBtn(act, id, label, busy) {
    var on = busy === act.slice(5);
    return '<button type="button" class="btn" data-act="' + act + '" data-id="' + esc(id) + '"' + (busy ? ' disabled' : '') + '>' +
      (on ? '<span class="spinner" aria-hidden="true"></span>' : '') + esc(label) + '</button>';
  }

  function needReason(item) {
    var t = item.task;
    if (t.status === 'blocked') return t.reason || 'Paused after 3 attempts.';
    var e = item.escalation || {};
    return e.reason || e.summary || e.details || 'Waiting for your decision.';
  }

  function needItem(item) {
    var t = item.task;
    var busy = Studio.busyAction ? Studio.busyAction(t.id) : null;
    var stuck = t.status === 'blocked';
    var out = '<button type="button" class="btn primary" data-task="' + esc(t.id) + '">' + (stuck ? 'See what failed' : 'Open task') + '</button>';
    if (stuck) out += actBtn('home-start', t.id, 'Try again', busy);
    if (item.hasProposal) out += actBtn('home-proposal', t.id, 'Review proposal', busy);
    else if (item.escalation) out += actBtn('home-ask', t.id, 'Ask the architect', busy);
    return '<div class="need" data-need="' + esc(t.id) + '">' + Studio.ui.statusIcon('blocked') + '<div class="body">' +
      '<div><span class="mono faint">' + esc(t.id) + '</span> · ' + Studio.ui.agentChip(t.agent) + '</div>' +
      '<b style="font-weight:500">' + esc(t.title) + '</b><span class="why">' + esc(needReason(item)) + '</span>' +
      '<div class="row">' + out + '</div></div></div>';
  }

  function needsPanel(model) {
    var n = model.needsYou;
    var body = n.length ? n.map(needItem).join('') :
      '<div class="calm">' + Studio.ui.statusIcon('completed') + 'Nothing needs you. No stuck tasks, questions or proposals.</div>';
    var right = n.length ? n.length + (n.length === 1 ? ' item' : ' items') : 'All clear';
    return panel('Needs you', rightText(right), '<div class="panel-body">' + body + '</div>');
  }

  function lastFinished(model) {
    var done = model.tasks.filter(function (t) { return t.status === 'completed'; });
    var timed = done.filter(function (t) { return t.endT; }).sort(function (a, b) { return b.endT - a.endT; });
    return timed[0] || done[done.length - 1] || null;
  }

  function idleText(model) {
    var last = lastFinished(model);
    if (!last) return 'No agent is working. Last finished nothing yet.';
    var when = last.endT ? ' ' + esc(Studio.fmt.ago(last.endT)) : '';
    return 'No agent is working. Last finished <span class="mono">' + esc(last.id) + '</span>' + when + '.';
  }

  function nowItem(t) {
    var timer = t.startT ? '<span class="timer" data-since="' + t.startT + '">' + Studio.fmt.dur(Studio.now() - t.startT) + '</span>' : '';
    return '<button type="button" class="now" data-task="' + esc(t.id) + '"><div class="l1">' + Studio.ui.statusIcon('in_progress') +
      Studio.ui.agentChip(t.agent) + timer + '</div><div class="title">' + esc(t.title) + '</div>' +
      (t.latestLog ? '<div class="log">' + esc(t.latestLog) + '</div>' : '') + '</button>';
  }

  function nowPanel(model) {
    var r = model.running;
    var body = r.length ? r.map(nowItem).join('') : '<div class="calm">' + idleText(model) + '</div>';
    return panel('Right now', rightText(r.length ? r.length + ' working' : 'Idle'), '<div class="panel-body">' + body + '</div>');
  }

  function figure(k, value, total, sub) {
    return '<div><span class="k">' + esc(k) + '</span><span class="v">' + esc(value) +
      (total == null ? '' : '<small> / ' + esc(total) + '</small>') + '</span><span class="s">' + esc(sub) + '</span></div>';
  }

  function spendNote(s) {
    var parts = [];
    if (s.cacheHitRate != null) parts.push((s.cacheHitRate * 100).toFixed(1) + '% cached');
    if (s.cacheSavingsUsd != null) parts.push('saved about ' + Studio.fmt.money(s.cacheSavingsUsd));
    return parts.length ? parts.join(', ') : 'no spend recorded';
  }

  function stripPanel(model) {
    var s = model.summary;
    var left = s.tasksLeft ? s.tasksLeft + ' left' : 'all done';
    var have = s.contractsPresent;
    var plan = have == null ? 'not checked' : (have >= s.contractsTotal ? 'all present and intact' : (s.contractsTotal - have) + ' missing');
    return '<section class="panel strip">' +
      figure('Milestones', s.milestonesDone, s.milestonesTotal, 'finished') +
      figure('Tasks', s.tasksDone, s.tasksTotal, left) +
      figure('Spend', Studio.fmt.money(s.spendUsd), null, spendNote(s)) +
      figure('Plan files', have == null ? '–' : have, s.contractsTotal, plan) + '</section>';
  }

  function recentTasks(model) {
    return model.tasks.filter(function (t) { return t.status === 'completed' && t.endT; })
      .sort(function (a, b) { return b.endT - a.endT; }).slice(0, RECENT_CAP);
  }

  function finishedRow(t) {
    return '<button type="button" class="row-btn" data-task="' + esc(t.id) + '">' + Studio.ui.statusIcon(t.status) +
      '<span class="mono faint hide-sm">' + esc(t.id) + '</span><span class="t">' + esc(t.title) + '</span>' +
      '<span class="hide-sm">' + Studio.ui.agentChip(t.agent) + '</span>' +
      '<span class="faint num row-right">' + Studio.ui.when(t.endT) + '</span></button>';
  }

  function finishedPanel(model) {
    var list = recentTasks(model);
    var body = list.length ? '<div class="list">' + list.map(finishedRow).join('') + '</div>' :
      Studio.ui.empty('Nothing has finished yet.', '');
    var btn = '<button type="button" class="btn ghost right" data-go="tasks">Open Tasks</button>';
    return panel('Just finished', btn, body);
  }

  function msRow(m) {
    var pct = m.total ? Math.round((m.done / m.total) * 100) : 0;
    return '<button type="button" class="ms-row" data-ms="' + esc(m.id) + '"><span class="mono faint">' + esc(m.id) + '</span>' +
      '<span class="t" title="' + esc(m.name) + '">' + esc(m.short) + '</span>' +
      '<span class="bar"><i style="width:' + pct + '%"></i></span>' +
      '<span class="num faint" style="font-size:12px;text-align:right">' + m.done + '/' + m.total + '</span></button>';
  }

  function milestonesPanel(model) {
    var list = model.milestones.slice().reverse();
    var body = list.length ? '<div class="list">' + list.map(msRow).join('') + '</div>' :
      Studio.ui.empty('No milestones yet.', 'The plan has no milestones.');
    return panel('Milestones', rightText('newest first'), body);
  }

  function skeleton() {
    var bar = function (w) { return '<div class="skel" style="width:' + w + '"></div>'; };
    var block = '<div class="skel-block">' + bar('40%') + bar('100%') + bar('80%') + '</div>';
    return head() + '<div class="home-top">' + block + block + '</div>' +
      '<div class="skel-strip">' + block + block + block + block + '</div>' +
      '<div class="home-top">' + block + block + '</div>';
  }

  function render(ctx) {
    var model = ctx.model;
    return head() +
      '<div class="home-top">' + needsPanel(model) + nowPanel(model) + '</div>' +
      stripPanel(model) +
      '<div class="home-top">' + finishedPanel(model) + milestonesPanel(model) + '</div>';
  }

  function forward(name) {
    return function (el) { Studio.taskAction(name, el.getAttribute('data-id')); };
  }

  Studio.registerPage('home', {
    deps: ['status', 'tasks', 'telemetry', 'runs', 'escalations'],
    render: render,
    skeleton: skeleton,
    actions: { 'home-start': forward('start'), 'home-proposal': forward('proposal'), 'home-ask': forward('ask') }
  });
`;
