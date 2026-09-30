// Pure task detail panel markup: sections and actions depend on the task status.
export const detailViewScript = String.raw`  // ─── Task detail panel (pure) ───────────────────────────────────────────────
  var BUSY_LABEL = { 'task-start': 'Starting…', 'task-dispatch': 'Dispatching…', 'task-abort': 'Stopping…', 'task-ask': 'Asking…' };

  function dBtn(act, label, opts) {
    opts = opts || {};
    var busy = opts.busy === act;
    var off = opts.disabled || (opts.busy && !busy);
    return '<button type="button" class="btn' + (opts.primary ? ' primary' : '') + (opts.danger ? ' danger' : '') + '" data-act="' + act + '"' +
      (off || busy ? ' disabled' : '') + (opts.title ? ' title="' + esc(opts.title) + '"' : '') + '>' +
      (busy ? '<span class="spinner" aria-hidden="true"></span>' + BUSY_LABEL[act] : esc(label)) + '</button>';
  }

  function depChip(model, id) {
    var x = model.byId[id];
    if (!x) return '<span class="chip mono">' + esc(id) + '</span>';
    return '<button type="button" class="chip" data-task="' + esc(id) + '">' + ui.statusIcon(x.status) +
      '<span class="mono">' + esc(id) + '</span></button>';
  }

  function detailActions(t, env) {
    var b = env.busy ? 'task-' + env.busy : null;
    if (t.status === 'blocked') {
      var out = dBtn('task-output', 'Show check output', { primary: true, busy: b }) + dBtn('task-start', 'Try again', { busy: b });
      if (t.hasProposal) return out + dBtn('task-proposal', 'Review proposal', { busy: b });
      if (t.escalation) out += dBtn('task-ask', 'Ask the architect', { busy: env.triaging ? 'task-ask' : b });
      return out;
    }
    if (t.status === 'in_progress') {
      var live = t.run && isRunActive(t.run);
      return dBtn('task-logs', 'Open live logs', { busy: b }) +
        dBtn('task-abort', 'Stop', { danger: true, busy: b, disabled: !live, title: live ? '' : 'No runner is attached to this task' });
    }
    if (t.status === 'pending' && !t.waitingOn.length) {
      return dBtn('task-start', 'Start', { primary: true, busy: b }) + dBtn('task-dispatch', 'Dispatch', { busy: b });
    }
    return '';
  }

  function detailTook(t) {
    if (t.status === 'in_progress' && t.startT) {
      return '<span data-since="' + t.startT + '">' + fmt.dur(Studio.now() - t.startT) + '</span> so far';
    }
    var check = t.checkMs ? ' <span class="faint">(check ' + fmt.dur(t.checkMs) + ')</span>' : '';
    return fmt.dur(t.durationMs) + check;
  }

  function detailFacts(t, model) {
    var m = model.milestones.filter(function (x) { return x.id === t.milestoneId; })[0];
    var ms = m ? '<button type="button" class="chip" data-ms="' + esc(m.id) + '"><span class="mono">' + esc(m.id) + '</span>' + esc(m.short) + '</button>' : '–';
    return '<dl class="kv"><dt>Milestone</dt><dd>' + ms + '</dd><dt>Agent</dt><dd>' + ui.agentChip(t.agent) + '</dd>' +
      '<dt>Started</dt><dd class="num">' + esc(fmt.full(t.startT)) + '</dd><dt>Took</dt><dd class="num">' + detailTook(t) + '</dd>' +
      '<dt>Est. cost</dt><dd class="num">' + esc(fmt.money(t.costUsd)) + '</dd></dl>';
  }

  function chipList(label, html) { return '<div><div class="dlabel">' + label + '</div><div class="chips">' + html + '</div></div>'; }

  /** env = { busy: running action key or null, triaging: bool }. Returns the drawer content. */
  Studio.detailHtml = function (id, env) {
    env = env || {};
    var model = Studio.model, t = model && model.byId[id];
    if (!t) return '';
    var reason = t.status === 'blocked'
      ? '<div class="reason">' + esc(t.reason || 'Paused after ' + (t.attempt || t.maxAttempts) + ' of ' + t.maxAttempts + ' attempts.') + '</div>' : '';
    var step = t.status === 'in_progress'
      ? '<div><div class="dlabel">Latest step</div><div class="code wrap">' + esc(t.latestLog || 'No output yet.') + '</div></div>' : '';
    var actions = detailActions(t, env);
    var files = t.files.map(function (f) { return '<span class="chip mono">' + esc(f) + '</span>'; }).join('') || '<span class="faint">None listed.</span>';
    return '<div class="drawer-head">' + ui.statusIcon(t.status) + '<span class="mono faint">' + esc(t.id) + '</span>' +
      ui.pill(t.status) + '<button type="button" class="btn ghost close" data-act="close-detail" aria-label="Close">' + ui.icon('x') + '</button></div>' +
      '<div class="drawer-body"><h3>' + esc(t.title) + '</h3>' + reason + (actions ? '<div class="chips">' + actions + '</div>' : '') + step +
      detailFacts(t, model) +
      chipList('Needs first', t.deps.length ? t.deps.map(function (d) { return depChip(model, d); }).join('') : '<span class="faint">Nothing. It can start right away.</span>') +
      chipList('Unblocks', t.children.length ? t.children.map(function (d) { return depChip(model, d); }).join('') : '<span class="faint">No later task depends on this.</span>') +
      chipList('Files it may change', files) +
      '<div><div class="dlabel">How it is checked</div><div class="code">' + esc(t.verify || 'No check command.') + '</div></div>' +
      '<div class="chips"><button type="button" class="btn" data-act="show-flow">' + ui.icon('flow') + 'Show in Flow</button></div></div>';
  };

`;
