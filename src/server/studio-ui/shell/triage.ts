// Tier 1 strategist.
export const triageScript = String.raw`  // ─── Tier 1 AI Strategist (/api/pipeline/triage/*, ui_specs.md §5) ─────────
  /** Decision-card selection for the escalation on screen; survives re-renders from live updates. */
  var t1Choice = { escalationId: null, index: 0, custom: '' };

  /** "gemini-3.8-flash" -> "Gemini 3.8 Flash". */
  function modelName(id) {
    return String(id || 'gemini').split('-').map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
  }
  function triageRunningCount() { return Object.keys(pipe.triageRunning).length; }
  /** Pending escalations whose stored Tier 1 verdict asks the product owner to decide. */
  function awaitingDecision() {
    return (pipe.escalations || []).filter(function (e) {
      return e.status === 'pending_review' && e.triage && e.triage.classification === 'REQUIRE_HUMAN_DECISION';
    });
  }
  function lastTriage() {
    if (pipe.triageLast) return pipe.triageLast;
    var newest = null;
    (pipe.escalations || []).forEach(function (e) {
      if (e.triage && (!newest || String(e.triage.evaluatedAt) > String(newest.evaluatedAt))) newest = e.triage;
    });
    return newest;
  }

  function renderTriageChip() {
    var t = pipe.triage;
    var model = (t && t.model) || 'gemini-3.8-flash';
    var waiting = awaitingDecision().length;
    var state = triageRunningCount() ? 'triaging' : waiting ? 'attention' : 'idle';
    var chip = $('t1-chip');
    chip.setAttribute('data-state', state);
    chip.title = state === 'triaging' ? 'Tier 1 AI Strategist is assessing an escalation'
      : state === 'attention' ? waiting + ' escalation' + (waiting === 1 ? ' needs' : 's need') + ' your decision' : 'Tier 1 AI Strategist';
    $('t1-chip-model').textContent = modelName(model);
    $('t1-model').textContent = model;
    var last = lastTriage();
    $('t1-latency').textContent = last ? fmtMs(last.latencyMs) + ' · ' + modelName(last.model || model) : 'No evaluations yet';
    $('t1-key').textContent = pipe.errors.triage && !t ? 'Status unavailable' : !t ? 'Checking' : t.hasApiKey ? 'Configured' : 'Not set (offline rules)';
    var sw = $('t1-auto');
    var on = !!(t && t.autoTriageEnabled);
    sw.setAttribute('aria-checked', String(on));
    sw.textContent = on ? 'ON' : 'OFF';
    sw.disabled = !t || !!pipe.busy.triageConfig;
    var stats = (t && t.stats) || {};
    $('t1-evaluated').textContent = num(stats.totalEvaluated || 0);
    $('t1-resolved').textContent = num(stats.autoResolved || 0);
    $('t1-human').textContent = num(stats.escalatedToHuman || 0);
  }

  function setTriageMenu(open) {
    var menu = $('t1-menu');
    if (menu.hidden === !open) return;
    menu.hidden = !open;
    $('t1-chip').setAttribute('aria-expanded', String(open));
    if (!open) return;
    renderTriageChip();
    fetchPipeline(['triage']);
    ($('t1-auto').disabled ? menu : $('t1-auto')).focus();
  }

  function checkAutoTriage() {
    if (!pipe.triage || !pipe.triage.autoTriageEnabled) return;
    (pipe.escalations || []).forEach(function (e) {
      if (e && e.status === 'pending_review' && !e.triage && !pipe.triageRunning[e.id]) {
        runTriage(e);
      }
    });
  }

  function setAutoTriage(enabled) {
    if (pipe.busy.triageConfig) return;
    pipe.busy.triageConfig = true;
    renderTriageChip();
    postJson('/api/pipeline/triage/config', { autoTriageEnabled: enabled }).then(function (body) {
      pipe.triage = Object.assign({}, pipe.triage || {}, { autoTriageEnabled: !!(body.config && body.config.autoTriageEnabled) });
      toast(enabled ? 'Autonomous Auto-Triage on: fixes Tier 1 proves safe are applied without asking' : 'Autonomous Auto-Triage off: every fix waits for your approval', 'ok');
      if (enabled) checkAutoTriage();
    }, function (e) {
      toast('Could not change Autonomous Auto-Triage: ' + e.message);
    }).then(function () {
      pipe.busy.triageConfig = false;
      renderTriageChip();
      if (rc.tab === 'heal') renderHeal();
    });
  }

  /** Asks the strategist to assess one escalation. The server stores the verdict on the escalation record. */
  function runTriage(escalation) {
    if (!escalation || pipe.triageRunning[escalation.id]) return;
    var taskId = escalation.taskId;
    pipe.triageRunning[escalation.id] = taskId;
    rc.heal = { taskId: taskId, busy: true, result: null };
    renderTriageChip();
    renderHeal();
    refreshUi([]);
    postJson('/api/pipeline/triage/evaluate', { escalationId: escalation.id }).then(function (body) {
      pipe.triageLast = { latencyMs: body.latencyMs, model: body.model };
      t1Choice.escalationId = null; // a re-run may bring new options
      rc.heal = { taskId: taskId, busy: false, result: null, triage: body, escalation: escalation };
      if (body.autoPatchApplied) {
        pipe.triageRecent[taskId] = Date.now();
        setTimeout(function () { delete pipe.triageRecent[taskId]; }, 12000);
        toast('Tier 1 auto-resolved ' + escalation.id + ' in ' + fmtMs(body.latencyMs), 'ok');
      } else if (body.classification === 'REQUIRE_HUMAN_DECISION') {
        toast(escalation.id + ' needs your decision', 'ok');
      }
      // A resolved escalation leaves the pending list; keep its stored verdict (applied patch, unblock) on screen.
      return api('/api/pipeline/escalations?status=all').then(function (list) {
        (list.escalations || []).some(function (e) {
          if (e.id !== escalation.id) return false;
          if (rc.heal && rc.heal.triage === body) rc.heal.escalation = e;
          return true;
        });
      }, function () { /* the evaluate response is enough to render */ });
    }, function (e) {
      rc.heal = { taskId: taskId, busy: false, result: { ok: false, message: 'Tier 1 triage failed: ' + e.message } };
      toast('Tier 1 triage failed for ' + escalation.id + ': ' + e.message);
    }).then(function () {
      delete pipe.triageRunning[escalation.id];
      renderTriageChip();
      renderHeal();
      refreshUi([]);
      return fetchPipeline(['escalations', 'triage', 'status', 'tasks', 'telemetry']);
    });
  }

  /** Verdict for the console task: this tab's latest evaluation first, else the one stored on the escalation. */
  function triageFor(escalation, heal) {
    if (heal && heal.triage) {
      var stored = heal.escalation || escalation;
      return { verdict: (stored && stored.triage) || heal.triage, escalation: stored };
    }
    if (escalation && escalation.triage) return { verdict: escalation.triage, escalation: escalation };
    return null;
  }

  function triageStrip(escalation, hasVerdict) {
    var running = !!pipe.triageRunning[escalation.id];
    var text = running ? 'is assessing this escalation' : hasVerdict ? 'has assessed this escalation. Run it again after the contracts change.'
      : 'can assess this escalation: resolve a safe fix automatically or prepare a decision card for you.';
    return '<div class="t1-strip' + (running ? ' is-triaging' : '') + '" role="status"><span>' + ICON.spark + '<strong>Tier 1 AI Strategist</strong> ' + esc(text) + '</span>' +
      '<button class="rc-btn t1-run" type="button" data-heal="t1-run"' + (running ? ' disabled' : '') + '>' +
      (running ? '<span class="spinner" aria-hidden="true"></span>Triaging…' : hasVerdict ? 'Re-run Triage' : 'Run Tier 1 Triage') + '</button></div>';
  }

  function triageVerdictHtml(v, escalation) {
    var meta = modelName(v.model) + ' in ' + fmtMs(v.latencyMs);
    if (v.classification === 'AUTO_RESOLVE' && v.autoPatchApplied) {
      var patch = (v.resolution && v.resolution.patch) || (escalation.proposedPatch && escalation.proposedPatch.candidate);
      var unblocked = v.unblockedTaskId || (escalation.resolution && escalation.resolution.unblockedTaskId);
      return '<p class="t1-banner is-resolved" role="status">' + ICON.spark + esc('Auto-Resolved by Tier 1 AI Strategist (' + meta + ')') + '</p>' +
        (patch ? '<section class="heal-section"><h4>Applied contract modification</h4><pre class="heal-patch">' + patchLine('+', patch) + '</pre></section>' : '') +
        '<p class="heal-diag"><strong>Auto-unblocking:</strong> ' +
        esc(unblocked ? 'Task ' + unblocked + ' is back in the queue and can be dispatched again.' : 'The task was not blocked, so nothing needed unblocking.') +
        (v.reasoning ? ' ' + esc(v.reasoning) : '') + '</p>';
    }
    if (v.classification === 'AUTO_RESOLVE') {
      var auto = !!(pipe.triage && pipe.triage.autoTriageEnabled);
      var next = escalation.proposedPatch
        ? 'Nothing was written yet. Approve the proposal below' + (auto ? '.' : ', or turn on Autonomous Auto-Triage and run triage again.')
        : 'No contract change is needed. Approve below to unblock the task.';
      return '<p class="t1-banner is-safe" role="status">' + ICON.spark + esc('Tier 1 AI Strategist: safe to resolve (' + meta + ')') + '</p>' +
        '<p class="heal-diag">' + esc((v.reasoning ? v.reasoning + ' ' : '') + next) + '</p>';
    }
    return humanCardHtml(v, escalation, meta);
  }

  /** ui_specs.md §5.2: amber 4-part card. Options are selectable; the footer commits the choice. */
  function humanCardHtml(v, escalation, meta) {
    var card = v.humanCard || {};
    var options = Array.isArray(card.options) ? card.options : [];
    var recorded = escalation.humanDecision || null;
    if (t1Choice.escalationId !== escalation.id) {
      var pick = 0;
      options.some(function (o, i) { if (o.recommended) { pick = i; return true; } return false; });
      if (recorded) options.some(function (o, i) { if (o.id === recorded.optionId) { pick = i; return true; } return false; });
      t1Choice = { escalationId: escalation.id, index: pick, custom: recorded && recorded.instructions ? recorded.instructions : '' };
    }
    var buttons = options.map(function (o, i) {
      var label = String(o.label || 'Option ' + (i + 1));
      var tag = o.recommended && !/recommended/i.test(label) ? ' (Recommended)' : '';
      return '<button class="t1-opt' + (o.recommended ? ' is-recommended' : '') + '" type="button" role="radio" aria-checked="' + (t1Choice.index === i) + '"' +
        ' tabindex="' + (t1Choice.index === i ? '0' : '-1') + '" data-t1-opt="' + i + '"><b>' + esc(label + tag) + '</b><span>' + esc(o.outcome || o.description || '') + '</span></button>';
    }).join('');
    return '<article class="t1-card" aria-label="Human decision required">' +
      '<div class="t1-card-head"><span class="t1-badge">Human Decision Required</span><span class="heal-tag">' + esc(escalation.id) + '</span><span class="t1-meta">' + esc(meta) + '</span></div>' +
      '<ol class="t1-parts">' +
        '<li><h4>What is Happening?</h4><p>' + esc(card.symptom || escalation.summary || '') + '</p></li>' +
        '<li><h4>Why is This Happening?</h4><p>' + esc(card.rootCause || '') + '</p></li>' +
        '<li><h4>Who &amp; What is Affected?</h4><p>' + esc(card.blastRadius || '') + '</p></li>' +
        '<li><h4>Actionable Options &amp; Trade-offs</h4>' +
          '<div class="t1-options" role="radiogroup" aria-label="Decision options">' + buttons + '</div>' +
          '<label class="t1-custom" for="t1-custom">Custom instructions (optional, used instead of the option above)' +
          '<textarea id="t1-custom" maxlength="900" rows="2" placeholder="Tell the agent exactly what to do instead">' + esc(t1Choice.custom) + '</textarea></label>' +
          (recorded ? '<p class="t1-decided">Recorded from the terminal: ' + esc(recorded.label || recorded.optionId) + '</p>' : '') +
        '</li>' +
      '</ol>' +
    '</article>';
  }

  function decisionActions(escalation) {
    return '<div class="heal-actions"><button class="rc-btn reject" type="button" data-heal="t1-dismiss">Dismiss Escalation</button>' +
      '<button class="rc-btn approve" type="button" data-heal="t1-decide">' + (escalation.proposedPatch ? 'Apply Proposal &amp; Unblock' : 'Unblock with This Decision') + '</button></div>';
  }

  /** Sends the card choice (or custom instructions) as the resolution notes the unblocked agent reads. */
  function commitDecision(decision) {
    var escalation = rc.taskId ? escalationFor(rc.taskId) : null;
    var tri = triageFor(escalation, rc.heal && rc.heal.taskId === rc.taskId ? rc.heal : null);
    if (!escalation || !tri) return;
    var options = (tri.verdict.humanCard && tri.verdict.humanCard.options) || [];
    var chosen = options[t1Choice.index];
    var custom = String(t1Choice.custom || '').trim();
    var notes = custom ? 'Product owner instructions: ' + custom
      : chosen ? 'Product owner chose "' + (chosen.label || chosen.id) + '": ' + (chosen.outcome || chosen.description || '') : '';
    resolveEscalation(decision, notes.slice(0, 1000), decision === 'approve' ? 't1-decide' : 't1-dismiss');
  }

`;
