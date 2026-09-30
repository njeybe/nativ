// Dispatch requests and the dispatch modal.
export const dispatchScript = String.raw`  // ─── Autonomous dispatch: POST /tasks/dispatch and /tasks/abort ────────────
  function runDispatch(taskId, customOptions) {
    var key = 'task:' + taskId;
    if (pipe.busy[key]) return;
    pipe.busy[key] = 'dispatch';
    refreshUi([]);
    var payload = Object.assign({ taskId: taskId }, customOptions || {});
    postJson('/api/pipeline/tasks/dispatch', payload).then(function (body) {
      upsertRun(body && body.run);
      var engine = body && body.run && body.run.engine === 'native' ? 'native engine' : 'CLI runner';
      toast('Dispatched ' + taskId + ' to the ' + engine, 'ok');
      openConsole(taskId, true);
    }, function (e) {
      toast('Could not dispatch ' + taskId + ': ' + e.message);
    }).then(function () {
      delete pipe.busy[key];
      return fetchPipeline(['status', 'tasks', 'runs', 'worktrees']);
    });
  }

  function runAbort(taskId) {
    var key = 'task:' + taskId;
    if (pipe.busy[key]) return;
    pipe.busy[key] = 'abort';
    refreshUi([]);
    postJson('/api/pipeline/tasks/abort', { taskId: taskId, reason: 'Aborted from Nativ Studio' }).then(function () {
      toast('Abort signal sent to ' + taskId, 'ok');
    }, function (e) {
      toast('Could not abort ' + taskId + ': ' + e.message);
    }).then(function () {
      delete pipe.busy[key];
      return fetchPipeline(['status', 'tasks', 'runs']);
    });
  }

  var pendingConfirm = null;
  function confirmDialog(opts, onConfirm) {
    $('confirm-title').textContent = opts.title;
    $('confirm-body').textContent = opts.body;
    var ok = $('btn-confirm-ok');
    ok.textContent = opts.confirmLabel;
    ok.className = 'btn ' + (opts.danger ? 'danger-solid' : 'primary');
    pendingConfirm = onConfirm;
    openDialog($('confirm-dialog'));
  }

  function confirmAbort(taskId) {
    confirmDialog({
      title: 'Abort agent run',
      body: 'Terminate the Claude process tree for ' + taskId + '? The isolated worktree and its branch are left in place so the partial work can be inspected.',
      confirmLabel: 'Abort Run',
      danger: true
    }, function () { runAbort(taskId); });
  }

  // ─── Intelligent dispatch modal (#dispatch-dialog) ─────────────────────────
  var pendingDispatch = null;

  /** Mirrors buildDefaultClaudeCommand() in agent-supervisor.ts so the preview matches what the server runs. */
  function defaultClaudeCommand(t) {
    var prompt = [
      'Execute task ' + t.id + ' (' + t.title + ').',
      t.description ? 'Description: ' + t.description + '.' : '',
      t.verificationCommand ? 'Verify your work using: ' + t.verificationCommand + '.' : '',
      'Start by running: nativ task start ' + t.id + '. When finished and verified, run: nativ task complete ' + t.id + '.',
      'If blocked, follow the Human-Centric Communication Protocol in CLAUDE.md: explain the user experience symptom, root cause in plain English, and clear options without technical jargon.'
    ].filter(Boolean).join(' ');
    // No permission bypass: acceptEdits plus the per-task allowlist the server writes to .nativ/runs/permissions/<task>.json.
    return 'claude -p "' + prompt.replace(/"/g, '\\"') + '" --output-format stream-json --verbose --permission-mode acceptEdits --settings ".nativ/runs/permissions/' + t.id + '.json"';
  }

  function syncDispatchSwitches() {
    var isolated = $('dispatch-worktree').checked;
    var merge = $('dispatch-merge');
    merge.disabled = !isolated || !$('dispatch-verify-gate').checked;
    if (merge.disabled) merge.checked = false;
  }

  function checkedValue(name) {
    var el = document.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : '';
  }

  /**
   * Current Claude models reject a fixed thinking budget, so the native engine maps it onto an
   * effort level (same buckets as thinkingBudgetToEffort in agent-supervisor.ts). Say so here
   * rather than implying an exact token cap.
   */
  function budgetHint(engine, budget) {
    if (engine === 'cli') {
      return budget ? 'Passed to Claude Code as MAX_THINKING_TOKENS=' + budget + '.' : 'Claude Code chooses its own thinking budget.';
    }
    if (!budget) return 'Runs at low effort, the fastest setting (Claude Opus 5.5 cannot switch thinking off entirely).';
    var effort = budget <= 2048 ? 'medium' : budget <= 8192 ? 'high' : budget <= 32768 ? 'xhigh' : 'max';
    return 'Runs at ' + effort + ' effort: the native engine maps token budgets onto effort levels.';
  }

  function syncDispatchEngine() {
    var engine = checkedValue('dispatch-engine') || 'native';
    $('dispatch-command-field').hidden = engine !== 'cli';
    $('dispatch-budget-hint').textContent = budgetHint(engine, Number(checkedValue('dispatch-budget')) || 0);
  }

  function openDispatchDialog(taskId) {
    var t = taskById(taskId);
    if (!t) { runDispatch(taskId); return; }
    var files = t.targetFiles || [];
    pendingDispatch = { taskId: t.id, preview: defaultClaudeCommand(t) };
    $('dispatch-task-id').textContent = t.id;
    $('dispatch-agent').textContent = t.assignedSubagent || 'unassigned';
    $('dispatch-task-title').textContent = t.title || '';
    $('dispatch-files').innerHTML = files.map(function (f) { return '<li class="file" title="' + esc(f) + '">' + esc(f) + '</li>'; }).join('');
    $('dispatch-files').hidden = !files.length;
    $('dispatch-verify').innerHTML = t.verificationCommand ? '<span class="cmd-label">Test command: </span>' + esc(t.verificationCommand) : 'no test command';
    $('dispatch-command').value = pendingDispatch.preview;
    $('dispatch-engine-native').checked = true;
    $('dispatch-budget-none').checked = true;
    syncDispatchEngine();
    $('dispatch-worktree').checked = true;
    $('dispatch-verify-gate').checked = !!t.verificationCommand;
    $('dispatch-verify-gate').disabled = !t.verificationCommand;
    $('dispatch-merge').checked = false;
    $('dispatch-error').textContent = '';
    syncDispatchSwitches();
    openDialog($('dispatch-dialog'));
    $('btn-launch-agent').focus();
  }

  function launchDispatch() {
    if (!pendingDispatch) return;
    var engine = checkedValue('dispatch-engine') || 'native';
    var budget = Number(checkedValue('dispatch-budget')) || 0;
    var command = $('dispatch-command').value.trim();
    if (engine === 'cli' && !command) {
      $('dispatch-error').textContent = 'Enter a runner command, or reopen the dialog to restore the generated one.';
      $('dispatch-command').focus();
      return;
    }
    var opts = {
      runnerEngine: engine,
      useWorktree: $('dispatch-worktree').checked,
      verify: $('dispatch-verify-gate').checked,
      autoMerge: $('dispatch-merge').checked
    };
    // Always sent: 0 ("None") asks for the least thinking, which differs from leaving the model default.
    opts.thinkingBudget = budget;
    // An untouched preview is the server's own default, which may be overridden by NATIV_RUNNER_COMMAND.
    if (engine === 'cli' && command !== pendingDispatch.preview) opts.runnerCommand = command;
    var id = pendingDispatch.taskId;
    pendingDispatch = null;
    $('dispatch-dialog').close();
    runDispatch(id, opts);
  }

`;
