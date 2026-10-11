// Team page client script: one pure render, one roster row per agent.
export const teamScript = String.raw`  var esc = Studio.ui.esc;
  var DASH = '-';

  function head() {
    return '<div class="page-head"><div><h1>Team</h1><p>Who is working on what, and how much each agent has finished.</p></div></div>';
  }

  function statsFor(key, tasks) {
    var done = tasks.filter(function (t) { return t.status === 'completed'; });
    var timed = done.filter(function (t) { return t.durationMs; });
    var costs = tasks.filter(function (t) { return t.costUsd != null; });
    var stamps = tasks.map(function (t) { return t.status === 'in_progress' ? (t.startT || 0) : (t.endT || 0); });
    return {
      agent: key || null,
      total: tasks.length,
      done: done.length,
      work: timed.length ? timed.reduce(function (n, t) { return n + t.durationMs; }, 0) : null,
      cost: costs.length ? costs.reduce(function (n, t) { return n + t.costUsd; }, 0) : null,
      blocked: tasks.filter(function (t) { return t.status === 'blocked'; }).length,
      last: Math.max.apply(null, [0].concat(stamps)) || null,
      running: tasks.filter(function (t) { return t.status === 'in_progress'; })[0] || null
    };
  }

  function buildRows(model) {
    var groups = {};
    var order = [];
    model.tasks.forEach(function (t) {
      var key = t.agent || '';
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(t);
    });
    return order.map(function (k) { return statsFor(k, groups[k]); })
      .sort(function (a, b) { return b.total - a.total; });
  }

  function currentTask(r) {
    var t = r.running;
    if (!t) return '<span class="idle">Idle</span>';
    return '<button type="button" class="cur" data-act="team-open" data-tid="' + esc(t.id) +
      '" title="' + esc(t.title || t.id) + '"><span class="mono">' + esc(t.id) + '</span>' +
      '<span class="ttl">' + esc(t.title || '') + '</span></button>';
  }

  function rate(r) {
    var fin = r.done + r.blocked;
    return fin ? Math.round((r.done / fin) * 100) + '%' : DASH;
  }

  function lastActive(r) {
    return r.last ? Studio.ui.when(r.last) : DASH;
  }

  function row(r) {
    var dot = r.running ? '<i class="run-dot"></i>' : '';
    return '<tr data-agent="' + esc(r.agent || 'unassigned') + '"><td class="who">' + dot +
      esc(r.agent || 'unassigned') + '</td>' +
      '<td>' + currentTask(r) + '</td>' +
      '<td class="mono r">' + r.done + '</td>' +
      '<td class="mono r hide-sm">' + (r.work == null ? DASH : esc(Studio.fmt.dur(r.work))) + '</td>' +
      '<td class="mono r hide-sm">' + (r.cost == null ? DASH : esc(Studio.fmt.money(r.cost))) + '</td>' +
      '<td class="mono r hide-sm">' + rate(r) + '</td>' +
      '<td class="mono r hide-sm">' + lastActive(r) + '</td></tr>';
  }

  function table(rows) {
    var cols = [['Agent', ''], ['Current task', ''], ['Tasks done', 'r'],
      ['Time', 'r hide-sm'], ['Cost', 'r hide-sm'], ['Success rate', 'r hide-sm'], ['Last active', 'r hide-sm']];
    var th = cols.map(function (c) {
      var tip = c[0] === 'Success rate' ? ' title="Completed / (completed + blocked)"' : '';
      return '<th' + tip + (c[1] ? ' class="' + c[1] + '"' : '') + '>' + c[0] + '</th>';
    }).join('');
    return '<div class="roster"><table><thead><tr>' + th + '</tr></thead><tbody>' +
      rows.map(row).join('') + '</tbody></table></div>' + defs();
  }

  function defs() {
    var items = [['Tasks done', 'finished and checked by the gatekeeper.'],
      ['Time', 'total time on completed tasks that recorded timing.'],
      ['Cost', 'estimated from token counts; the real bill is on Home.'],
      ['Current task', 'the task this agent is working on right now.']];
    return '<details class="defs"><summary>What these columns mean</summary>' + items.map(function (i) {
      return '<div><b>' + i[0] + '</b><span>' + i[1] + '</span></div>';
    }).join('') + '</details>';
  }

  function skeleton() {
    var line = function (w) {
      return '<tr><td colspan="6"><div class="skel" style="width:' + w + '"></div></td></tr>';
    };
    var rows = ['92%', '78%', '86%', '70%'].map(line).join('');
    return head() + '<div class="roster"><table><thead>' + line('100%') + '</thead><tbody>' +
      rows + '</tbody></table></div>';
  }

  function render(ctx) {
    var rows = buildRows(ctx.model);
    if (!rows.length) return head() + '<p class="empty">No agents have worked on this project yet.</p>';
    return head() + table(rows);
  }

  Studio.registerPage('team', {
    deps: ['tasks', 'telemetry', 'runs'],
    actions: { 'team-open': function (el) { Studio.taskAction('logs', el.getAttribute('data-tid')); } },
    render: render,
    skeleton: skeleton
  });
`;
