// Worktrees view script.
export const worktreesScript = String.raw`  // ─── View 3: Agent worktrees ───────────────────────────────────────────────
  function shortPath(p) {
    var parts = String(p || '').split(/[\\/]+/).filter(Boolean);
    return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : String(p || '');
  }

  function worktreeTaskStatus(w) {
    if (w.taskStatus) return w.taskStatus;
    var task = w.taskId ? taskById(w.taskId) : null;
    return task ? task.status : null;
  }

  function wtStatus(w, status) {
    if (!w.isAgentWorktree) return ['neutral', 'main'];
    if (status === 'completed') return ['ok', 'ready to merge'];
    if (status === 'in_progress') return ['run', 'agent working'];
    if (status === 'blocked') return ['err', 'blocked'];
    if (status === 'pending') return ['neutral', 'open'];
    return ['neutral', 'stale'];
  }

  function wtChanges(w) {
    var n = w.changedFiles != null ? w.changedFiles : w.files;
    return n != null ? esc(String(n)) + ' files' : '<span class="muted">-</span>';
  }

  function wtActions(w, status) {
    var id = esc(w.taskId);
    var canMerge = w.mergeEligible != null ? !!w.mergeEligible : status === 'completed';
    var why = w.mergeBlockedReason || 'Available once the task is completed';
    var busy = pipe.busy['wt:' + w.taskId];
    if (busy) {
      return '<button class="btn small" type="button" disabled><span class="spinner" aria-hidden="true"></span>' +
        (busy === 'merge' ? 'Merging...' : 'Deleting...') + '</button>';
    }
    return '<button class="btn small" type="button" data-act="wt-diff" data-key="' + id +
      '" aria-label="Inspect diff for ' + id + '">View changes</button>' +
      '<button class="btn small primary" type="button" data-act="wt-merge" data-key="' + id +
      '" aria-label="Merge ' + id + ' to main"' + (canMerge ? '' : ' disabled title="' + esc(why) + '"') +
      '>Merge</button>' +
      '<button class="btn small danger" type="button" data-act="wt-remove" data-key="' + id +
      '" aria-label="Delete workspace for ' + id + '">Remove</button>';
  }

  function worktreeRow(w) {
    var status = worktreeTaskStatus(w);
    var task = w.taskId ? taskById(w.taskId) : null;
    var st = wtStatus(w, status);
    var actions = w.isAgentWorktree && w.taskId ? wtActions(w, status) : '<span class="muted">-</span>';
    var title = task ? task.title : '';
    return '<tr class="wt-row"><td class="wt-task">' + (w.taskId ? '<code>' + esc(w.taskId) + '</code>' : '') +
      '<span class="wt-title" title="' + esc(title) + '">' + esc(title) + '</span></td>' +
      '<td><code>' + esc(w.branch) + '</code></td>' +
      '<td><span class="wt-dot" data-tone="' + st[0] + '"></span>' + esc(st[1]) + '</td>' +
      '<td class="wt-num">' + wtChanges(w) + '</td>' +
      '<td><div class="row-actions">' + actions + '</div></td></tr>';
  }

  function renderWorktrees() {
    var head = panelHead('Worktrees', 'Isolated git workspaces for tasks.');
    if (!pipe.loaded.worktrees) return head + '<div class="section" aria-hidden="true"><div class="skeleton"></div><div class="skeleton short"></div></div>';
    if (pipe.errors.worktrees && !pipe.worktrees.length) return head + errorCard('worktrees', pipe.errors.worktrees, 'worktrees');
    var rows = pipe.worktrees.filter(function (w) { return w.isAgentWorktree; });
    if (!rows.length) return head + staleNote('worktrees') + '<div class="state"><p>No worktrees open.</p></div>';
    return head + staleNote('worktrees') + '<table class="grid wt-table"><thead><tr>' +
      '<th scope="col">Task</th><th scope="col">Branch</th><th scope="col">Status</th>' +
      '<th scope="col">Changes</th><th scope="col">Actions</th>' +
      '</tr></thead><tbody>' + rows.map(worktreeRow).join('') + '</tbody></table>';
  }

  function confirmWorktree(action, taskId) {
    var w = null;
    pipe.worktrees.some(function (x) { if (x.taskId === taskId) { w = x; return true; } return false; });
    var branch = w ? w.branch : 'agent/task-' + taskId;
    if (action === 'merge') {
      confirmDialog({
        title: 'Merge to Main',
        body: 'Merge ' + branch + ' into the main workspace? Automated tests will run first and reject the merge if tests fail.',
        confirmLabel: 'Merge to Main'
      }, function () { runWorktreeAction('merge', taskId); });
    } else {
      confirmDialog({
        title: 'Delete workspace',
        body: 'Remove the workspace folder for ' + taskId + ' and delete branch ' + branch + '? Uncommitted work will be removed.',
        confirmLabel: 'Delete Workspace',
        danger: true
      }, function () { runWorktreeAction('remove', taskId); });
    }
  }

  function runWorktreeAction(action, taskId) {
    var key = 'wt:' + taskId;
    if (pipe.busy[key]) return;
    pipe.busy[key] = action;
    repaint('worktrees');
    postJson('/api/pipeline/worktrees/action', { action: action, taskId: taskId }).then(function (r) {
      toast(r.message || (action === 'merge' ? 'Merged workspace for ' : 'Deleted workspace for ') + taskId, 'ok');
    }, function (e) {
      toast((action === 'merge' ? 'Merge rejected for ' : 'Could not delete workspace for ') + taskId + ': ' + e.message);
    }).then(function () {
      delete pipe.busy[key];
      return fetchPipeline(['worktrees', 'tasks', 'status']);
    });
  }

  Studio.registerPage('worktrees', {
    deps: ['worktrees', 'tasks'],
    render: function () { return renderWorktrees(); },
    actions: {
      'wt-diff': function (el) { openConsole(el.getAttribute('data-key'), false, 'diff'); },
      'wt-merge': function (el) { confirmWorktree('merge', el.getAttribute('data-key')); },
      'wt-remove': function (el) { confirmWorktree('remove', el.getAttribute('data-key')); }
    }
  });
`;
