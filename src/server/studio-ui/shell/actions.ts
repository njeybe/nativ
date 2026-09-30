// Task actions behind the detail panel and the pages: start, dispatch, stop, logs, proposals.
export const actionsScript = String.raw`  // ─── Task actions ──────────────────────────────────────────────────────────
  /** Plain-language failure text: no stack, one closing period. */
  function plainFail(what, e) {
    return what + ': ' + String((e && e.message) || 'unknown error').replace(/[.\s]+$/, '') + '.';
  }

  function runTaskAction(action, taskId) {
    var key = 'task:' + taskId;
    if (pipe.busy[key]) return;
    pipe.busy[key] = action;
    refreshUi([]);
    postJson('/api/pipeline/tasks/action', { action: action, taskId: taskId }).then(function () {
      toast('Started ' + taskId, 'ok');
    }, function (e) {
      toast(plainFail('Could not start ' + taskId, e));
    }).then(function () {
      delete pipe.busy[key];
      return fetchPipeline(['status', 'tasks', 'worktrees']);
    });
  }

  function askArchitect(taskId) {
    var escalation = escalationFor(taskId);
    if (!escalation) { toast('There is nothing waiting for the architect on ' + taskId + '.'); return; }
    openConsole(taskId, true, 'heal');
    runTriage(escalation);
  }

  var TASK_ACTIONS = {
    start: function (id) { runTaskAction('start', id); },
    dispatch: function (id) { openDispatchDialog(id); },
    abort: function (id) { confirmAbort(id); },
    logs: function (id) { openConsole(id, false, 'logs'); },
    output: function (id) { openConsole(id, false, 'logs'); },
    proposal: function (id) { openConsole(id, false, 'heal'); },
    ask: askArchitect,
    flow: function (id) {
      var t = Studio.model && Studio.model.byId[id];
      if (t) Studio.go('flow', { milestoneId: t.milestoneId, focusTaskId: id, keepDetail: true });
    }
  };
  Studio.taskAction = function (name, taskId) {
    if (TASK_ACTIONS[name]) TASK_ACTIONS[name](taskId);
  };
  /** Name of the action running for a task, or null. */
  Studio.busyAction = function (taskId) { return pipe.busy['task:' + taskId] || null; };

`;
