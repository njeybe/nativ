// Team page client script: one pure render, one table row per agent.
export const teamScript = String.raw`  var esc = Studio.ui.esc;
  var DASH = '–';

  function head() {
    return '<div class="page-head"><div><h1>Team</h1><p>Each agent in plain terms: what it did, how long it took, what it cost.</p></div></div>';
  }

  function sum(list) {
    return list.reduce(function (total, n) { return total + n; }, 0);
  }

  function statsFor(key, tasks) {
    var done = tasks.filter(function (t) { return t.status === 'completed'; });
    var timed = done.filter(function (t) { return t.durationMs; });
    var work = sum(timed.map(function (t) { return t.durationMs; }));
    var costs = tasks.filter(function (t) { return t.costUsd != null; });
    var stamps = tasks.map(function (t) { return t.status === 'in_progress' ? (t.startT || 0) : (t.endT || 0); });
    return {
      agent: key || null,
      total: tasks.length,
      done: done.length,
      work: timed.length ? work : null,
      avg: timed.length ? work / timed.length : null,
      cost: costs.length ? sum(costs.map(function (t) { return t.costUsd; })) : null,
      last: Math.max.apply(null, [0].concat(stamps)) || null,
      running: tasks.filter(function (t) { return t.status === 'in_progress'; })[0] || null,
      stuck: tasks.filter(function (t) { return t.status === 'blocked'; })[0] || null
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

  function chip(task, label) {
    return '<button type="button" class="chip" data-task="' + esc(task.id) + '">' +
      Studio.ui.statusIcon(task.status) + esc(label) + '</button>';
  }

  function rightNow(r) {
    if (r.running) return chip(r.running, r.running.id);
    if (r.stuck) return chip(r.stuck, 'Stuck on ' + r.stuck.id);
    return '<span class="faint">Idle</span>';
  }

  function shareBar(r, max) {
    var info = Studio.agentInfo(r.agent);
    var pct = max ? Math.round((r.total / max) * 100) : 0;
    return '<div class="bar"><i style="width:' + pct + '%;background:var(' + info.token + ')"></i></div>';
  }

  function lastActive(r) {
    return r.last ? Studio.ui.when(r.last) : DASH;
  }

  function row(r, max) {
    return '<tr data-agent="' + esc(r.agent || 'unassigned') + '"><td>' + Studio.ui.agentChip(r.agent) + '</td>' +
      '<td>' + rightNow(r) + '</td>' +
      '<td class="r">' + r.done + '<span class="faint"> / ' + r.total + '</span></td>' +
      '<td class="share">' + shareBar(r, max) + '</td>' +
      '<td class="r">' + (r.avg == null ? DASH : esc(Studio.fmt.dur(r.avg))) + '</td>' +
      '<td class="r">' + (r.work == null ? DASH : esc(Studio.fmt.dur(r.work))) + '</td>' +
      '<td class="r">' + (r.cost == null ? DASH : esc(Studio.fmt.money(r.cost))) + '</td>' +
      '<td class="r faint">' + lastActive(r) + '</td></tr>';
  }

  function table(rows) {
    var max = Math.max.apply(null, rows.map(function (r) { return r.total; }));
    var cols = ['Agent', 'Right now', 'Tasks done', 'Share of work', 'Avg. time', 'Total time', 'Est. cost', 'Last active'];
    var th = cols.map(function (c, i) {
      var cls = i === 3 ? ' class="share"' : (i > 1 ? ' class="r"' : '');
      return '<th' + cls + '>' + c + '</th>';
    }).join('');
    return '<section class="panel table-wrap"><table><thead><tr>' + th + '</tr></thead><tbody>' +
      rows.map(function (r) { return row(r, max); }).join('') + '</tbody></table></section>';
  }

  function defs() {
    return '<section class="panel"><div class="panel-head"><h2>What these columns mean</h2></div><div class="panel-body defs">' +
      '<div><b>Tasks done</b>: finished and checked, out of all tasks given to this agent.</div>' +
      '<div><b>Avg. time</b>: from start to a passing check, for tasks that recorded timing.</div>' +
      '<div><b>Est. cost</b>: estimated from token counts. The real bill is on Home under Spend.</div>' +
      '<div><b>Right now</b>: the task this agent is working on, or the one it is stuck on.</div></div></section>';
  }

  function skeleton() {
    var bar = function (w) { return '<div class="skel" style="width:' + w + '"></div>'; };
    var block = '<div class="skel-block">' + bar('100%') + bar('92%') + bar('74%') + '</div>';
    return head() + block + block;
  }

  function render(ctx) {
    var rows = buildRows(ctx.model);
    if (!rows.length) return head() + '<section class="panel">' + ctx.ui.empty('No tasks yet', 'Agents show up here once the plan has tasks.') + '</section>';
    return head() + table(rows) + defs();
  }

  Studio.registerPage('team', {
    deps: ['tasks', 'telemetry', 'runs'],
    render: render,
    skeleton: skeleton
  });
`;
