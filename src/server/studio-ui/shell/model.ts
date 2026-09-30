// Pure client model: joins plan, telemetry, runs and escalations into one object per refresh.
export const modelScript = String.raw`  // ─── Studio client model: buildModel(api) is pure ──────────────────────────
  var RUN_ACTIVE = { spawning_worktree: 1, running: 1, verifying: 1, merging: 1 };
  function isRunActive(run) { return !!run && !!RUN_ACTIVE[run.status]; }

  /** Text before the first colon, at most 46 characters. */
  function shortName(name) {
    var head = String(name || '').split(':')[0].replace(/^\s+|\s+$/g, '');
    if (head.length <= 46) return head;
    return head.slice(0, 44).replace(/[\s,&]+\S*$/, '') + '…';
  }

  function toTime(value) {
    var t = value ? Date.parse(value) : NaN;
    return isNaN(t) ? null : t;
  }

  function positive(n) { return typeof n === 'number' && isFinite(n) && n > 0 ? n : null; }

  /** Last non-empty line of a log tail, without colour codes. */
  function lastLine(text) {
    var lines = String(text || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n/);
    for (var i = lines.length - 1; i >= 0; i--) {
      var line = lines[i].replace(/^\s+|\s+$/g, '');
      if (line) return line.length > 240 ? line.slice(0, 240) + '…' : line;
    }
    return null;
  }

  function attemptsOf(task, running) {
    var cb = task.circuitBreaker || {};
    var attempt = (cb.consecutiveFailures || 0) + (running ? 1 : 0);
    if (!attempt && task.status === 'blocked') {
      var m = /(\d+)\s+(?:fix\s+)?attempts?/i.exec(task.notes || '');
      attempt = m ? Number(m[1]) : 0;
    }
    return attempt || null;
  }

  function buildTask(t, milestoneId, index) {
    var b = index.breakdown[t.id] || null;
    var run = index.run[t.id] || null;
    var esc1 = index.escalation[t.id] || null;
    var running = t.status === 'in_progress';
    var startT = b ? toTime(b.startedAt) : null;
    if (startT == null && run && isRunActive(run)) startT = toTime(run.startedAt);
    var cost = b && b.actual ? positive(b.actual.costUsd) : null;
    if (cost == null && b && b.estimated) cost = positive(b.estimated.costUsd);
    return {
      id: t.id,
      title: t.title || t.id,
      description: t.description || '',
      status: t.status,
      agent: t.assignedSubagent || null,
      deps: t.dependencies || [],
      files: t.targetFiles || [],
      verify: t.verificationCommand || '',
      milestoneId: milestoneId,
      children: [],
      waitingOn: [],
      isAvailable: !!t.isAvailable,
      reason: t.status === 'blocked' && t.notes ? String(t.notes).replace(/^\s+|\s+$/g, '') || null : null,
      attempt: attemptsOf(t, running),
      maxAttempts: (t.circuitBreaker && t.circuitBreaker.maxThreshold) || 3,
      startT: startT,
      endT: t.status === 'completed' && b ? toTime(b.completedAt) : null,
      durationMs: b ? positive(b.durationMs) : null,
      checkMs: b && b.verification ? positive(b.verification.durationMs) : null,
      costUsd: cost,
      run: run,
      latestLog: lastLine(index.logTail[t.id]),
      escalation: esc1,
      hasProposal: !!(esc1 && esc1.proposedPatch)
    };
  }

  function indexApi(api) {
    var index = { breakdown: {}, run: {}, escalation: {}, logTail: api.logTail || {} };
    ((api.telemetry && api.telemetry.taskBreakdowns) || []).forEach(function (b) {
      if (b && b.taskId) index.breakdown[b.taskId] = b;
    });
    (api.runs || []).forEach(function (r) {
      var have = r && index.run[r.taskId];
      if (r && r.taskId && (!have || (isRunActive(r) && !isRunActive(have)))) index.run[r.taskId] = r;
    });
    (api.escalations || []).forEach(function (e) {
      var pending = e && (!e.status || e.status === 'pending_review');
      if (pending && e.taskId && !index.escalation[e.taskId]) index.escalation[e.taskId] = e;
    });
    return index;
  }

  function finishMilestone(m) {
    m.total = m.tasks.length;
    m.done = m.tasks.filter(function (t) { return t.status === 'completed'; }).length;
    var ends = m.tasks.map(function (t) { return t.endT || 0; });
    m.lastEndT = Math.max.apply(null, [0].concat(ends)) || null;
    m.workMs = m.tasks.reduce(function (sum, t) { return sum + (t.durationMs || 0); }, 0);
    var costs = m.tasks.filter(function (t) { return t.costUsd != null; });
    m.costUsd = costs.length ? costs.reduce(function (sum, t) { return sum + t.costUsd; }, 0) : null;
  }

  function linkTasks(tasks, byId) {
    tasks.forEach(function (t) {
      t.deps.forEach(function (d) {
        var parent = byId[d];
        if (parent && parent.children.indexOf(t.id) === -1) parent.children.push(t.id);
        if (!parent || parent.status !== 'completed') t.waitingOn.push(d);
      });
    });
  }

  function needsYouItems(tasks, byId, escalations) {
    var seen = {}, items = [];
    var add = function (t) {
      seen[t.id] = true;
      items.push({ taskId: t.id, task: t, escalation: t.escalation, hasProposal: t.hasProposal,
        kind: t.status === 'blocked' ? 'stuck' : 'question' });
    };
    tasks.forEach(function (t) { if (t.status === 'blocked') add(t); });
    (escalations || []).forEach(function (e) {
      var pending = e && (!e.status || e.status === 'pending_review');
      if (pending && byId[e.taskId] && !seen[e.taskId]) add(byId[e.taskId]);
    });
    return items;
  }

  function summaryOf(api, milestones, tasks) {
    var act = api.telemetry && api.telemetry.summary && api.telemetry.summary.actual;
    var st = api.status && api.status.telemetry;
    var pick = function (a, b) { return a != null && isFinite(a) ? a : (b != null && isFinite(b) ? b : null); };
    var contracts = api.status && api.status.contracts;
    var done = tasks.filter(function (t) { return t.status === 'completed'; }).length;
    return {
      spendUsd: pick(act && act.spendUsd, st && st.actualSpendUsd),
      cacheHitRate: pick(act && act.cacheHitRate, st && st.cacheHitRate),
      cacheSavingsUsd: pick(act && act.cacheSavingsUsd, null),
      contractsPresent: contracts ? Object.keys(contracts).filter(function (k) { return contracts[k]; }).length : null,
      contractsTotal: 5,
      milestonesTotal: milestones.length,
      milestonesDone: milestones.filter(function (m) { return m.total > 0 && m.done === m.total; }).length,
      tasksTotal: tasks.length,
      tasksDone: done,
      tasksLeft: tasks.length - done
    };
  }

  /** api = { milestones, status, telemetry, runs, escalations, logTail }, the raw slices from the server. */
  function buildModel(api) {
    api = api || {};
    var index = indexApi(api);
    var tasks = [], byId = {};
    var milestones = (api.milestones || []).map(function (m, i) {
      var list = (m.tasks || []).map(function (t) {
        var task = buildTask(t, m.id, index);
        byId[task.id] = task;
        tasks.push(task);
        return task;
      });
      return { id: m.id, name: m.name || m.id, short: shortName(m.name || m.id), status: m.status, idx: i, tasks: list };
    });
    linkTasks(tasks, byId);
    milestones.forEach(finishMilestone);
    var active = null;
    milestones.some(function (m) {
      var open = m.tasks.some(function (t) { return t.status !== 'completed'; });
      if (open) active = m.id;
      return open;
    });
    if (!active && milestones.length) active = milestones[milestones.length - 1].id;
    return {
      milestones: milestones,
      tasks: tasks,
      byId: byId,
      activeMilestoneId: active,
      running: tasks.filter(function (t) { return t.status === 'in_progress'; }),
      stuck: tasks.filter(function (t) { return t.status === 'blocked'; }),
      needsYou: needsYouItems(tasks, byId, api.escalations),
      summary: summaryOf(api, milestones, tasks)
    };
  }

  /** Stores the model and keeps the shared milestone selection valid. */
  Studio.setModel = function (model) {
    Studio.model = model;
    var S = Studio.state;
    var known = model.milestones.some(function (m) { return m.id === S.milestoneId; });
    if (!known) S.milestoneId = model.activeMilestoneId;
  };
  Studio.buildModel = buildModel;

`;
