// Runner console drawer and worktree diff tab.
export const consoleScript = String.raw`  // ─── Live runner console drawer ────────────────────────────────────────────
  var RC_STEPS = ['Worktree', 'Claude', 'Verify', 'Merge'];
  var RC_STAGE = { spawning_worktree: 0, running: 1, verifying: 2, merging: 3 };
  var RC_MAX_NODES = 3000;
  var rc = { taskId: null, autoscroll: true, minimized: false, stage: 0, ticker: null, backfilled: false, tab: 'logs', diffSeq: 0, diffTimer: null, heal: null };

  /** Minimal SGR parser: escapes the chunk, then maps the colors agents actually emit. */
  var ANSI_CLASS = {
    '0': null, '39': null, '1': 'rc-bold', '2': 'rc-fg-muted', '90': 'rc-fg-muted',
    '31': 'rc-fg-danger', '91': 'rc-fg-danger', '32': 'rc-fg-ok', '92': 'rc-fg-ok',
    '33': 'rc-fg-warn', '93': 'rc-fg-warn', '34': 'rc-fg-info', '94': 'rc-fg-info',
    '36': 'rc-fg-info', '96': 'rc-fg-info'
  };
  function ansiToHtml(text, fallbackClass) {
    var out = '', open = 0, cls = fallbackClass || '';
    var parts = String(text == null ? '' : text).split(/\x1b\[([0-9;]*)m/);
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        var codes = parts[i].split(';');
        for (var c = 0; c < codes.length; c++) {
          var code = codes[c] || '0';
          if (!Object.prototype.hasOwnProperty.call(ANSI_CLASS, code)) continue;
          while (open > 0) { out += '</span>'; open--; }
          cls = ANSI_CLASS[code] ? ANSI_CLASS[code] : (fallbackClass || '');
        }
        continue;
      }
      // Other CSI sequences (cursor moves, clears) carry no meaning in a log pane.
      var chunk = parts[i].replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
      if (!chunk) continue;
      if (cls) { out += '<span class="' + cls + '">' + esc(chunk) + '</span>'; }
      else out += esc(chunk);
    }
    while (open > 0) { out += '</span>'; open--; }
    return out;
  }

  function rcStepper(run) {
    var status = run ? run.status : null;
    var stage = RC_STAGE[status] != null ? RC_STAGE[status] : rc.stage;
    var settled = !!status && !RUN_ACTIVE[status];
    var failed = status === 'failed' || status === 'aborted';
    if (RC_STAGE[status] != null) rc.stage = stage;
    return RC_STEPS.map(function (label, i) {
      var cls = 'rc-step';
      // Never dispatched (e.g. opened from a proposal banner): no phase is active.
      if (!status) return '<li class="' + cls + '">' + esc(label) + '</li>';
      if (status === 'completed') cls += ' is-done';
      else if (settled && failed) cls += i < stage ? ' is-done' : (i === stage ? ' is-failed' : '');
      else if (i < stage) cls += ' is-done';
      else if (i === stage) cls += ' is-active';
      return '<li class="' + cls + '">' + esc(label) + '</li>';
    }).join('<li class="rc-sep" aria-hidden="true">&#8250;</li>');
  }

  function syncConsole() {
    var run = rc.taskId ? runFor(rc.taskId) : null;
    var task = rc.taskId ? taskById(rc.taskId) : null;
    $('rc-task').textContent = rc.taskId || '–';
    $('rc-title').textContent = task ? task.title : '';
    $('rc-steps').innerHTML = rcStepper(run);
    $('rc-abort').disabled = !isRunActive(run);
    $('rc-elapsed').textContent = mmss(elapsedOf(run) || 0);
    $('rc-bytes').textContent = formatBytes((run && run.logBytes) || 0);
    var gate = 'Idle';
    if (run && run.verification) gate = run.verification.success ? 'Passed' : 'Failed';
    else if (run && run.status === 'verifying') gate = 'Running';
    $('rc-gate').textContent = gate;
    // Native runs report grounded usage; cli runs have none to show.
    var usage = run && run.usage;
    $('rc-spend-wrap').hidden = !usage;
    $('rc-cache-wrap').hidden = !usage;
    if (usage) {
      $('rc-spend').textContent = usdSpend(usage.costUsd);
      $('rc-cache').textContent = Math.round((Number(usage.cacheHitRate) || 0) * 100) + '%';
    }
    var exit = '';
    if (run && !isRunActive(run)) {
      exit = RUN_LABEL[run.status] || run.status;
      if (typeof run.exitCode === 'number') exit += ' (exit ' + run.exitCode + ')';
      if (run.error) exit += ' · ' + run.error;
    }
    $('rc-exit').textContent = exit;
  }

  function rcTick() {
    clearInterval(rc.ticker);
    rc.ticker = setInterval(function () {
      var run = rc.taskId ? runFor(rc.taskId) : null;
      if (!rc.taskId || !isRunActive(run)) { clearInterval(rc.ticker); rc.ticker = null; return; }
      $('rc-elapsed').textContent = mmss(elapsedOf(run) || 0);
    }, 1000);
  }

  function appendConsole(html) {
    var body = $('rc-body');
    var stick = rc.autoscroll || body.scrollTop + body.clientHeight >= body.scrollHeight - 4;
    var frag = document.createElement('span');
    frag.innerHTML = html;
    body.appendChild(frag);
    while (body.childElementCount > RC_MAX_NODES) body.removeChild(body.firstChild);
    if (stick) body.scrollTop = body.scrollHeight;
  }

  function loadConsoleLogs(taskId) {
    return api('/api/pipeline/tasks/logs?taskId=' + encodeURIComponent(taskId) + '&tailLines=500').then(function (body) {
      if (rc.taskId !== taskId) return;
      $('rc-body').innerHTML = body.log ? ansiToHtml(body.log) : '<span class="rc-empty">No output captured yet.</span>';
      $('rc-body').scrollTop = $('rc-body').scrollHeight;
      rc.backfilled = true;
      syncConsole();
    }, function () {
      if (rc.taskId !== taskId) return;
      $('rc-body').innerHTML = '<span class="rc-empty">Waiting for the runner to emit output…</span>';
      rc.backfilled = true;
    });
  }

  // ─── Console tab 2: worktree git diff (GET /api/pipeline/worktrees/diff) ───
  function diffToHtml(diff) {
    return String(diff).split('\n').map(function (line) {
      var cls = '';
      if (/^(diff --git|\+\+\+ |--- )/.test(line)) cls = /^diff --git/.test(line) ? 'df-file' : 'df-meta';
      else if (/^@@/.test(line)) cls = 'df-hunk';
      else if (/^\+/.test(line)) cls = 'df-add';
      else if (/^-/.test(line)) cls = 'df-del';
      else if (/^(index |new file mode|deleted file mode|similarity |rename |Binary files)/.test(line)) cls = 'df-meta';
      return cls ? '<span class="' + cls + '">' + esc(line) + '</span>' : esc(line) + '\n';
    }).join('');
  }

  function setDiffState(summary, files, bodyHtml, count) {
    $('rc-diff-summary').innerHTML = summary;
    $('rc-diff-files').innerHTML = (files || []).map(function (f) { return '<li title="' + esc(f) + '">' + esc(f) + '</li>'; }).join('');
    $('rc-diff-files').hidden = !(files && files.length);
    $('rc-diff-body').innerHTML = bodyHtml;
    $('rc-diff-count').textContent = count == null ? '–' : String(count);
  }

  function loadConsoleDiff(taskId) {
    var seq = ++rc.diffSeq;
    $('rc-diff-refresh').disabled = true;
    if (!$('rc-diff-body').textContent) setDiffState('Loading worktree changes…', [], '<span class="rc-empty">Reading git status…</span>', null);
    return api('/api/pipeline/worktrees/diff?taskId=' + encodeURIComponent(taskId)).then(function (body) {
      if (seq !== rc.diffSeq || rc.taskId !== taskId) return;
      var files = Array.isArray(body.filesChanged) ? body.filesChanged : [];
      var summary = '<code>' + esc(body.branch || '') + '</code> · ' + (body.hasChanges ? files.length + ' uncommitted file' + (files.length === 1 ? '' : 's') : 'working tree clean');
      setDiffState(summary, files, body.diff ? diffToHtml(body.diff) : '<span class="rc-empty">No uncommitted changes in this worktree yet.</span>', files.length);
    }, function (e) {
      if (seq !== rc.diffSeq || rc.taskId !== taskId) return;
      var missing = e.code === 'WORKTREE_NOT_FOUND';
      setDiffState(missing ? 'No isolated worktree' : 'Could not load the diff',
        [], '<span class="rc-empty">' + esc(missing ? 'This task has no agent worktree. Dispatch it with Isolated Worktree on, or run nativ worktree create ' + taskId + '.' : e.message) + '</span>', null);
    }).then(function () {
      if (seq === rc.diffSeq) $('rc-diff-refresh').disabled = false;
    });
  }

  /** Throttled refresh (at most every 2s) while an agent streams output or git state changes. */
  function queueConsoleDiff() {
    if (!rc.taskId || rc.tab !== 'diff' || rc.minimized || rc.diffTimer) return;
    var id = rc.taskId;
    rc.diffTimer = setTimeout(function () {
      rc.diffTimer = null;
      if (rc.taskId === id && rc.tab === 'diff') loadConsoleDiff(id);
    }, 2000);
  }

  function setConsoleTab(tab, focus) {
    if (tab === 'heal' && $('rc-tab-heal').hidden) tab = 'logs';
    rc.tab = tab;
    ['logs', 'diff', 'heal'].forEach(function (name) {
      var btn = $('rc-tab-' + name);
      var on = name === tab;
      btn.setAttribute('aria-selected', String(on));
      btn.setAttribute('tabindex', on ? '0' : '-1');
    });
    $('rc-body').hidden = tab !== 'logs';
    $('rc-diff').hidden = tab !== 'diff';
    $('rc-heal').hidden = tab !== 'heal';
    $('rc-autoscroll').hidden = tab !== 'logs';
    $('rc-clear').hidden = tab !== 'logs';
    if (tab === 'diff' && rc.taskId) loadConsoleDiff(rc.taskId);
    if (tab === 'heal') renderHeal();
    if (focus) $('rc-tab-' + tab).focus();
  }

  /** Console tabs in DOM order, skipping the proposal tab while it is hidden. */
  function visibleConsoleTabs() {
    return ['logs', 'diff', 'heal'].filter(function (name) { return !$('rc-tab-' + name).hidden; });
  }

`;
