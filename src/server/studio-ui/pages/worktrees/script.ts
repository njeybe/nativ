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

  function worktreeBadge(w, status) {
    if (!w.isAgentWorktree) return '<span class="badge badge-neutral">Main workspace</span>';
    if (status === 'completed') return '<span class="badge badge-success">Tests Passed (Ready to merge)</span>';
    if (status === 'in_progress') return '<span class="badge badge-active">Agent working</span>';
    if (status === 'blocked') return '<span class="badge badge-danger">Blocked</span>';
    if (status === 'pending') return '<span class="badge badge-neutral">Pending</span>';
    return '<span class="badge badge-neutral" title="No matching task in the master plan">Untracked</span>';
  }

  function worktreeRow(w) {
    var status = worktreeTaskStatus(w);
    var task = w.taskId ? taskById(w.taskId) : null;
    // The server decides merge eligibility (and why not); fall back to the task status from the plan.
    var canMerge = w.mergeEligible != null ? !!w.mergeEligible : status === 'completed';
    var blockedWhy = w.mergeBlockedReason || 'Available once the task is completed';
    var busy = w.taskId && pipe.busy['wt:' + w.taskId];
    var actions = '<span class="muted">–</span>';
    if (w.isAgentWorktree && w.taskId) {
      actions = busy
        ? '<button class="btn small" type="button" disabled><span class="spinner" aria-hidden="true"></span>' + (busy === 'merge' ? 'Merging…' : 'Deleting…') + '</button>'
        : '<button class="btn small" type="button" data-act="wt-diff" data-key="' + esc(w.taskId) + '" aria-label="' + esc('Inspect diff for ' + w.taskId) + '">Inspect Diff</button>' +
          '<button class="btn small primary" type="button" data-act="wt-merge" data-key="' + esc(w.taskId) + '"' + (canMerge ? '' : ' disabled title="' + esc(blockedWhy) + '"') + '>Merge to Main</button>' +
          '<button class="btn small danger" type="button" data-act="wt-remove" data-key="' + esc(w.taskId) + '">Delete Workspace</button>';
    }
    return '<tr><td data-label="Branch"><code>' + esc(w.branch) + '</code></td>' +
      '<td data-label="Task ID">' + (w.taskId ? '<div><code>' + esc(w.taskId) + '</code>' + (task ? '<div class="cell-sub" title="' + esc(task.title) + '">' + esc(task.title) + '</div>' : '') + '</div>' : '<span class="muted">–</span>') + '</td>' +
      '<td data-label="Workspace Folder"><code class="path" title="' + esc(w.path) + '">' + esc(shortPath(w.path)) + '</code></td>' +
      '<td data-label="Latest Commit"><code>' + esc(String(w.head || '').slice(0, 7) || '–') + '</code></td>' +
      '<td data-label="Status">' + worktreeBadge(w, status) + '</td>' +
      '<td data-label="Actions"><div class="row-actions">' + actions + '</div></td></tr>';
  }

  function renderWorktrees() {
    var head = panelHead('Agent Worktrees', 'Isolated git workspaces for tasks. Changes are tested automatically before merging into your main branch.');
    if (!pipe.loaded.worktrees) return head + '<div class="card section" aria-hidden="true"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton short"></div></div>';
    if (pipe.errors.worktrees && !pipe.worktrees.length) return head + errorCard('worktrees', pipe.errors.worktrees, 'worktrees');
    var rows = pipe.worktrees.slice().sort(function (a, b) { return (a.isAgentWorktree ? 1 : 0) - (b.isAgentWorktree ? 1 : 0); });
    if (!rows.some(function (w) { return w.isAgentWorktree; })) {
      return head + staleNote('worktrees') + '<div class="card state"><div class="state-icon">' + ICON.branch + '</div><h2>No agent worktrees</h2>' +
        '<p>Run <code>nativ worktree create &lt;taskId&gt;</code> to give an agent its own isolated workspace folder for an independent task.</p></div>';
    }
    return head + staleNote('worktrees') + '<div class="card wt-card"><table class="grid"><thead><tr>' +
      '<th scope="col">Branch Name</th><th scope="col">Task ID</th><th scope="col">Workspace Folder</th><th scope="col">Latest Commit</th><th scope="col">Status</th><th scope="col">Actions</th>' +
      '</tr></thead><tbody>' + rows.map(worktreeRow).join('') + '</tbody></table></div>';
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
