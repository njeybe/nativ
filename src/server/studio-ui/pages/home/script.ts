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
    return e.reason || e.summary || e.details || 'Needs your decision.';
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

  // The copied command stops before the choice: the human types nativ or codebase.
  function copyCommand(command) { return String(command).replace(/nativ\|codebase$/, ''); }

  function styleItem(item) {
    var files = item.count === 1 ? 'file' : 'files';
    return '<div class="need" data-need="' + esc(item.key) + '"><div class="body">' +
      '<div class="l1"><b>Code style decision</b><span class="mono">' + esc(item.rule) + '</span></div>' +
      '<span class="why">Code style: ' + esc(item.title) + ', ' + item.count + ' ' + files + '</span>' +
      '<code class="mono cmd">' + esc(item.command) + '</code></div>' +
      '<div class="acts"><span class="copy-wrap"><span class="tooltip">Copied!</span>' +
      '<button type="button" class="btn" data-act="home-copy-style" data-cmd="' +
      esc(copyCommand(item.command)) + '">Copy</button></span></div></div>';
  }

  // ─── Plan change rows (ui_specs.md#plan-change-rows) ───
  var REASON_LONG = 110;
  var CLAMP = 'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden';
  var DECISION_WORD = { approve: 'Approve', reject: 'Reject' };
  var DECISION_BUSY = { approve: 'Approving...', reject: 'Rejecting...' };
  var DECISION_DONE = { approve: ' approved', reject: ' rejected' };

  function planUi(id) {
    if (!pipe.planUi[id]) pipe.planUi[id] = { confirm: null, busy: null, more: false };
    return pipe.planUi[id];
  }

  function planWords(c) {
    var b = c.change || {};
    var id = c.taskId;
    if (b.drop) return 'Drop ' + id + (b.drop.replacedBy ? ', replaced by ' + b.drop.replacedBy : '');
    var parts = [];
    if ((b.addDependencies || []).length) parts.push('add ' + b.addDependencies.join(', '));
    if ((b.removeDependencies || []).length) parts.push('remove ' + b.removeDependencies.join(', '));
    if (b.release && !parts.length && b.notes == null) return 'Release ' + id;
    if (b.release) parts.push('release');
    if (b.notes != null) parts.push('new notes');
    return id + ': ' + parts.join(', ');
  }

  function planEffects(c) {
    var list = (c.effects && c.effects.rewired) || [];
    return list.map(function (r) {
      return '<span class="why">' + esc(r.taskId + ' will wait on ' + r.to + ' instead of ' + r.from) + '</span>';
    }).join('');
  }

  function planReason(c, ui) {
    var text = String(c.reason || '');
    var clamp = ui.more ? '' : ' style="' + CLAMP + '"';
    var long = text.length > REASON_LONG;
    return '<span class="why"' + clamp + '>' + esc(text) + '</span>' + (long ?
      '<button type="button" class="btn link" data-act="home-plan-more" data-id="' + esc(c.id) + '">' +
      (ui.more ? 'Show less' : 'Show more') + '</button>' : '');
  }

  function planCommand(c) { return 'nativ plan approve ' + c.id; }

  function planNoKey(c) {
    var cmd = planCommand(c);
    return '<code class="mono cmd">' + esc(cmd) + '</code>' +
      '<span class="copy-wrap"><span class="tooltip">Copied!</span>' +
      '<button type="button" class="btn" data-act="home-copy-style" data-cmd="' + esc(cmd) + '">Copy</button></span>' +
      '<span class="why">Open Studio from your terminal to decide here.</span>';
  }

  function planBtn(act, c, label, cls, disabled) {
    return '<button type="button" class="btn' + (cls ? ' ' + cls : '') + '" data-act="' + act + '" data-id="' +
      esc(c.id) + '"' + (disabled ? ' disabled' : '') + '>' + esc(label) + '</button>';
  }

  function planKeyed(c, ui) {
    var failed = !!(c.check && c.check.ok === false);
    if (ui.busy) {
      var a = ui.busy === 'approve' ? DECISION_BUSY.approve : 'Approve';
      var r = ui.busy === 'reject' ? DECISION_BUSY.reject : 'Reject';
      return planBtn('home-plan-ask-approve', c, a, 'primary', true) + planBtn('home-plan-ask-reject', c, r, '', true);
    }
    if (ui.confirm) {
      return '<span class="why">' + esc(DECISION_WORD[ui.confirm] + ' ' + c.id + '?') + '</span>' +
        planBtn('home-plan-confirm', c, 'Confirm', 'primary') + planBtn('home-plan-cancel', c, 'Cancel', '');
    }
    return planBtn('home-plan-ask-approve', c, 'Approve', 'primary', failed) +
      planBtn('home-plan-ask-reject', c, 'Reject', '');
  }

  function planItem(item) {
    var c = item.change;
    var ui = planUi(c.id);
    var bad = c.check && c.check.ok === false;
    var why = bad ? c.check.reason || 'This change no longer applies.' : '';
    var fail = bad ? '<span class="why" style="color:var(--danger)">' + esc(why) + '</span>' : '';
    var by = c.proposedBy ? '<span class="why" style="color:var(--fg-3)">' +
      esc('Proposed by ' + c.proposedBy) + '</span>' : '';
    return '<div class="need" data-need="' + esc(item.key) + '"><div class="body">' +
      '<div class="l1"><b>Plan change</b><span class="mono">' + esc(c.id) + '</span></div>' +
      '<span class="why">' + esc(planWords(c)) + '</span>' + planReason(c, ui) + by + planEffects(c) + fail + '</div>' +
      '<div class="acts">' + (pipe.session.human ? planKeyed(c, ui) : planNoKey(c)) + '</div></div>';
  }

  function planChangeById(id) {
    return pipe.planChanges.filter(function (c) { return c.id === id; })[0] || null;
  }

  function askPlan(decision) {
    return function (el) { planUi(el.getAttribute('data-id')).confirm = decision; Studio.repaint('home'); };
  }
  function cancelPlan(el) { planUi(el.getAttribute('data-id')).confirm = null; Studio.repaint('home'); }
  function morePlan(el) {
    var ui = planUi(el.getAttribute('data-id'));
    ui.more = !ui.more;
    Studio.repaint('home');
  }

  function confirmPlan(el) {
    var id = el.getAttribute('data-id');
    var c = planChangeById(id);
    var ui = planUi(id);
    if (!c || ui.busy || !ui.confirm) return;
    var decision = ui.confirm;
    ui.busy = decision;
    Studio.repaint('home');
    postJson('/api/pipeline/plan-changes/decide', { id: id, decision: decision, seen: c.seen }).then(function () {
      pipe.planChanges = pipe.planChanges.filter(function (x) { return x.id !== id; });
      delete pipe.planUi[id];
      toast(id + DECISION_DONE[decision], 'ok');
    }, function (e) {
      ui.busy = null;
      ui.confirm = null;
      toast(e.message || 'Could not decide ' + id);
    }).then(function () {
      return fetchPipeline(['planChanges', 'tasks', 'status', 'escalations']);
    });
  }

  function needItem(item) {
    if (item.kind === 'style') return styleItem(item);
    if (item.kind === 'plan') return planItem(item);
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

  function readyTasks(model) {
    return model.tasks.filter(Studio.status.isReady);
  }

  function dispatchBtn(id, label, cls) {
    return '<button type="button" class="btn' + (cls ? ' ' + cls : '') + '" data-act="home-dispatch" data-id="' +
      esc(id) + '">' + esc(label) + '</button>';
  }

  function taskCells(t) {
    return '<span class="mono id">' + esc(t.id) + '</span>' +
      '<button type="button" class="t link" data-task="' + esc(t.id) + '">' + esc(t.title) + '</button>' +
      '<span class="agent">' + esc(Studio.agentInfo(t.agent).label) + '</span>';
  }

  function runRow(t) {
    var since = t.startT ? ' data-since="' + t.startT + '">' + Studio.fmt.dur(Studio.now() - t.startT) : '>';
    var row = '<div class="row run-row">' + taskCells(t) +
      '<span class="state">Running</span>' +
      '<span class="mono num timer"' + since + '</span></div>';
    var log = '<span class="mono log">' + esc(t.latestLog || '') + '</span>';
    var watch = t.run ? '<button type="button" class="btn" data-act="home-console" data-id="' +
      esc(t.id) + '">Watch live</button>' : '';
    return row + '<div class="row sub-row">' + log + watch + '</div>';
  }

  function nowRunning(model) {
    var r = model.running;
    if (r.length) return section('running', 'Now running', rightText(r.length + ' running'), r.map(runRow).join(''));
    var next = readyTasks(model)[0];
    var btn = next ? dispatchBtn(next.id, 'Dispatch ' + next.id, 'primary') : '';
    return section('running', 'Now running', '', '<div class="row calm"><span>No agent is running.</span>' + btn + '</div>');
  }

  function nextRow(t) {
    var end = Studio.status.isReady(t) ? dispatchBtn(t.id, 'Dispatch') :
      '<span class="wait">' + esc(Studio.status.waitText(t)) + '</span>';
    return '<div class="row next-row">' + taskCells(t) + end + '</div>';
  }

  function upNext(model) {
    var list = model.tasks.filter(function (t) { return t.status === 'pending'; });
    var ready = list.filter(Studio.status.isReady);
    var waiting = list.filter(function (t) { return !Studio.status.isReady(t); });
    var rows = ready.concat(waiting).slice(0, UP_NEXT_CAP);
    var body = rows.length ? rows.map(nextRow).join('') :
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

  // One event per task that has started or finished; the state word comes from its status now.
  function activityEvents(model) {
    var out = [];
    model.tasks.forEach(function (t) {
      var at = t.status === 'completed' ? (t.endT || t.startT) : t.startT;
      if (at) out.push({ at: at, task: t });
    });
    return out.sort(function (a, b) { return b.at - a.at; }).slice(0, ACTIVITY_CAP);
  }

  function activityState(t) {
    var word = Studio.status.word(Studio.status.bucket(t));
    var took = t.status === 'completed' && t.durationMs ? ', took ' + Studio.fmt.dur(t.durationMs) : '';
    return word + took;
  }

  function activityRow(e) {
    var t = e.task;
    return '<div class="row act-row" data-event="' + esc(t.id) + '"><span class="mono num when">' +
      Studio.ui.when(e.at) + '</span><button type="button" class="t link" data-task="' + esc(t.id) + '">' +
      esc(t.title) + '</button><span class="state">' + esc(activityState(t)) + '</span></div>';
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

  function copyStyle(el) { copyText(el.getAttribute('data-cmd'), el); }

  function forward(name) {
    return function (el) { Studio.taskAction(name, el.getAttribute('data-id')); };
  }

  Studio.registerPage('home', {
    deps: ['status', 'tasks', 'telemetry', 'runs', 'escalations', 'planChanges', 'session'],
    render: render,
    skeleton: skeleton,
    actions: {
      'home-start': forward('start'), 'home-proposal': forward('proposal'), 'home-ask': forward('ask'),
      'home-console': forward('logs'), 'home-copy-style': copyStyle, 'home-dispatch': forward('dispatch'),
      'home-plan-ask-approve': askPlan('approve'), 'home-plan-ask-reject': askPlan('reject'),
      'home-plan-cancel': cancelPlan, 'home-plan-confirm': confirmPlan, 'home-plan-more': morePlan
    }
  });
`;
