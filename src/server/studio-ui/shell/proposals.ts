// Self-healing proposal review.
export const proposalsScript = String.raw`  // ─── Console tab 3: self-healing proposal review (/api/pipeline/escalations) ─
  /** Shows the tab only while the console's task has a pending escalation; keeps the panel in sync. */
  function syncHealTab() {
    var escalation = rc.taskId ? escalationFor(rc.taskId) : null;
    // Keep the tab while a just-finished resolution is still on screen.
    var show = !!escalation || !!(rc.heal && (rc.heal.result || rc.heal.triage) && rc.heal.taskId === rc.taskId);
    $('rc-tab-heal').hidden = !show;
    $('rc-heal-count').hidden = !(escalation && escalation.proposedPatch);
    if (!show && rc.tab === 'heal') setConsoleTab('logs');
    else if (rc.tab === 'heal') renderHeal();
  }

  function patchLine(sign, p) {
    if (!p) return '';
    var value = p.value === undefined ? '' : ' ' + JSON.stringify(p.value);
    return '<span class="' + (sign === '-' ? 'df-del' : 'df-add') + '">' + sign + ' ' + esc(p.operation + ' ' + p.path + value) + '</span>';
  }

  function healBody(escalation, opts) {
    var withActions = !(opts && opts.actions === false);
    var p = escalation.proposedPatch;
    var diag = '<p class="heal-diag"><strong>' + esc(escalation.summary || 'Escalated') + '</strong>' +
      (escalation.details ? '<br>' + esc(escalation.details) : '') + '</p>';
    if (!p) {
      return '<div class="heal-head"><h3>No automatic fix could be proven</h3><span class="heal-tag">' + esc(escalation.id) + '</span></div>' + diag +
        '<p class="heal-diag">' + esc(escalation.recommendedAction || 'Review the affected contracts, then unblock the task or dismiss the escalation.') + '</p>' +
        (withActions ? '<div class="heal-actions"><button class="rc-btn reject" type="button" data-heal="reject">Dismiss</button>' +
        '<button class="rc-btn approve" type="button" data-heal="approve">Approve &amp; Unblock Task</button></div>' : '');
    }
    var proof = p.verificationProof || {};
    var verdict = proof.passed
      ? '<span class="heal-verdict pass">' + ICON.check + 'PASSED in sandbox</span>'
      : '<span class="heal-verdict fail">' + ICON.x + 'NOT VERIFIED</span>';
    var patch = p.kind === 'restore_tests'
      ? (p.files || []).map(function (f) { return '<span class="df-add">+ restore ' + esc(f) + '</span>'; }).join('') +
        (p.commands || []).map(function (c) { return '<span class="df-meta">$ ' + esc(c) + '</span>'; }).join('')
      : patchLine('-', p.original) + patchLine('+', p.candidate);
    var checks = (proof.checks || []).map(function (c) {
      return '<li><span class="' + (c.passed ? 'ok' : 'bad') + '">' + (c.passed ? ICON.check : ICON.x) + '</span><span><b>' + esc(c.name) + '</b> ' + esc(c.detail) + '</span></li>';
    }).join('');
    return '<div class="heal-head"><h3>' + esc(humanize(p.strategy || 'proposal')) + '</h3><span class="heal-tag">' + esc(p.proposalId || escalation.id) + '</span>' + verdict + '</div>' +
      diag + '<p class="heal-diag">' + esc(p.rationale || '') + '</p>' +
      '<div class="heal-grid">' +
        '<section class="heal-section"><h4>' + (p.kind === 'restore_tests' ? 'Restoration plan' : 'Rejected change &#8594; proposed change') + '</h4><pre class="heal-patch">' + patch + '</pre></section>' +
        '<section class="heal-section"><h4>Isolated verification</h4><ul class="heal-checks">' + (checks || '<li>No checks recorded.</li>') + '</ul></section>' +
      '</div>' +
      (withActions ? '<div class="heal-actions"><button class="rc-btn reject" type="button" data-heal="reject">Reject Proposal</button>' +
      '<button class="rc-btn approve" type="button" data-heal="approve"' + (proof.passed ? '' : ' disabled title="Only sandbox-verified proposals can be applied"') + '>Approve &amp; Apply Patch</button></div>' : '');
  }

  function renderHeal() {
    var panel = $('rc-heal');
    // Live updates must not wipe instructions while they are being typed.
    if (document.activeElement && document.activeElement.id === 't1-custom' && panel.contains(document.activeElement)) return;
    var heal = rc.heal && rc.heal.taskId === rc.taskId ? rc.heal : null;
    var result = heal && heal.result ? '<p class="heal-result' + (heal.result.ok ? '' : ' is-error') + '" role="status">' + esc(heal.result.message) + '</p>' : '';
    if (!pipe.loaded.escalations) { panel.innerHTML = '<div class="heal-skel"></div><div class="heal-skel"></div><div class="heal-skel" style="width:60%"></div>'; return; }
    if (pipe.errors.escalations && !pipe.escalations.length) {
      panel.innerHTML = '<p class="heal-result is-error">Could not load escalations: ' + esc(pipe.errors.escalations) + '</p>' +
        '<div class="heal-actions"><button class="rc-btn" type="button" data-heal="retry">Retry</button></div>';
      return;
    }
    var escalation = escalationFor(rc.taskId);
    var tri = triageFor(escalation, heal);
    if (!escalation && !tri) {
      panel.innerHTML = result || '<p class="heal-diag">No pending proposal for this task. When the circuit breaker trips on a third failed attempt, a sandbox-verified fix appears here for review.</p>';
      return;
    }
    var html = result;
    if (escalation) html += triageStrip(escalation, !!tri);
    if (tri) html += triageVerdictHtml(tri.verdict, tri.escalation);
    if (escalation) {
      var deciding = !!tri && tri.verdict.classification === 'REQUIRE_HUMAN_DECISION' && tri.escalation.id === escalation.id;
      html += healBody(escalation, { actions: !deciding }) + (deciding ? decisionActions(escalation) : '');
    }
    panel.innerHTML = html;
    if (heal && heal.busy) panel.querySelectorAll('[data-heal]').forEach(function (b) { b.disabled = true; });
  }

  /** One click resolves: approve applies the proposal and unblocks the task, reject dismisses it. */
  function resolveEscalation(decision, notes, buttonKey) {
    var escalation = rc.taskId ? escalationFor(rc.taskId) : null;
    if (!escalation || (rc.heal && rc.heal.busy)) return;
    var taskId = rc.taskId;
    rc.heal = { taskId: taskId, busy: true, result: null };
    renderHeal();
    var btn = $('rc-heal').querySelector('[data-heal="' + (buttonKey || decision) + '"]');
    if (btn) btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>' + (decision === 'approve' ? 'Applying…' : 'Rejecting…');
    var payload = { escalationId: escalation.id, decision: decision };
    if (notes) payload.notes = notes;
    postJson('/api/pipeline/escalations/resolve', payload).then(function (body) {
      rc.heal = { taskId: taskId, busy: false, result: { ok: true, message: body.message || 'Escalation resolved.' } };
      toast(body.message || 'Escalation resolved', 'ok');
    }, function (e) {
      rc.heal = { taskId: taskId, busy: false, result: { ok: false, message: e.message } };
      toast('Could not ' + decision + ' ' + escalation.id + ': ' + e.message);
    }).then(function () {
      renderHeal();
      return fetchPipeline(['escalations', 'status', 'tasks', 'telemetry', 'triage']);
    });
  }

  /** Per-turn usage from the native engine: fold the running total into the run record. */
  function onRunnerUsage(event) {
    if (!event || !event.taskId || !event.total) return;
    var run = runFor(event.taskId);
    if (run && (!event.runId || run.runId === event.runId)) run.usage = event.total;
    if (rc.taskId === event.taskId) syncConsole();
  }

  function openConsole(taskId, quiet, tab) {
    var drawer = $('runner-console-drawer');
    if (rc.taskId !== taskId) {
      rc.taskId = taskId;
      rc.backfilled = false;
      rc.stage = 0;
      rc.diffSeq++;
      rc.heal = null;
      setDiffState('Uncommitted changes in the task worktree', [], '', null);
      // The run list includes restored history, so no run means no log to fetch (the server would 400).
      if (runFor(taskId)) {
        $('rc-body').innerHTML = '<span class="rc-empty">Loading runner output…</span>';
        loadConsoleLogs(taskId);
      } else {
        $('rc-body').innerHTML = '<span class="rc-empty">No runner has been dispatched for this task yet.</span>';
        rc.backfilled = true;
      }
    }
    rc.minimized = false;
    drawer.hidden = false;
    drawer.classList.remove('is-min');
    $('rc-minimize').textContent = 'Minimize';
    $('rc-minimize').setAttribute('aria-expanded', 'true');
    document.body.classList.add('has-console');
    document.body.classList.remove('has-console-min');
    syncConsole();
    syncHealTab();
    rcTick();
    setConsoleTab(tab || rc.tab);
    if (!quiet) (rc.tab === 'diff' ? $('rc-diff-body') : rc.tab === 'heal' ? $('rc-heal') : $('rc-body')).focus();
  }

  function closeConsole() {
    rc.taskId = null;
    clearInterval(rc.ticker);
    rc.ticker = null;
    clearTimeout(rc.diffTimer);
    rc.diffTimer = null;
    $('runner-console-drawer').hidden = true;
    document.body.classList.remove('has-console', 'has-console-min');
  }

  function toggleConsoleMinimized() {
    rc.minimized = !rc.minimized;
    var drawer = $('runner-console-drawer');
    drawer.classList.toggle('is-min', rc.minimized);
    document.body.classList.toggle('has-console', !rc.minimized);
    document.body.classList.toggle('has-console-min', rc.minimized);
    var btn = $('rc-minimize');
    btn.textContent = rc.minimized ? 'Expand' : 'Minimize';
    btn.setAttribute('aria-expanded', String(!rc.minimized));
    if (!rc.minimized && rc.tab === 'diff' && rc.taskId) loadConsoleDiff(rc.taskId);
  }

  function onRunnerStatus(run) {
    if (!run || !run.taskId) return;
    upsertRun(run);
    if (rc.taskId === run.taskId) {
      syncConsole();
      if (isRunActive(run)) rcTick();
      queueConsoleDiff();
    }
    refreshUi(['runs']);
    if (!RUN_ACTIVE[run.status]) {
      var statusMsg = (RUN_LABEL[run.status] || run.status) + ': ' + run.taskId;
      if (run.error && run.status !== 'completed') statusMsg += ' (' + run.error + ')';
      toast(statusMsg, run.status === 'completed' ? 'ok' : 'err');
      // The agent may have moved the task through "nativ task complete" while it ran.
      queueRefresh(['status', 'tasks', 'worktrees', 'runs']);
    }
  }

  function onRunnerLog(entry) {
    if (!entry || !entry.taskId) return;
    var run = runFor(entry.taskId);
    if (run) run.logBytes = (run.logBytes || 0) + (entry.chunk ? entry.chunk.length : 0);
    feedLogTail(entry);
    if (rc.taskId !== entry.taskId || !rc.backfilled) return;
    var empty = $('rc-body').querySelector('.rc-empty');
    if (empty) $('rc-body').innerHTML = '';
    appendConsole(ansiToHtml(entry.chunk, entry.stream === 'stderr' ? 'rc-fg-warn' : ''));
    $('rc-bytes').textContent = formatBytes((run && run.logBytes) || 0);
    queueConsoleDiff();
  }

`;
