// Pipeline data store, fetching, and the model rebuild that follows every change.
export const pipelineStateScript = String.raw`  // ─── Pipeline state ────────────────────────────────────────────────────────
  var PIPE_PATHS = {
    status: '/api/pipeline/status',
    tasks: '/api/pipeline/tasks',
    worktrees: '/api/pipeline/worktrees',
    benchmarks: '/api/pipeline/benchmarks',
    runs: '/api/pipeline/tasks/runs',
    telemetry: '/api/pipeline/telemetry/detailed',
    escalations: '/api/pipeline/escalations?status=pending_review',
    triage: '/api/pipeline/triage/status'
  };
  var ALL_PARTS = ['status', 'tasks', 'worktrees', 'benchmarks', 'runs', 'telemetry', 'escalations', 'triage'];
  var REDUCED_MOTION = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  var pipe = {
    status: null,
    milestones: [],
    worktrees: [],
    runs: [],
    report: null,
    telemetry: null,
    escalations: [],
    triage: null,
    triageRunning: {},
    triageRecent: {},
    triageLast: null,
    logTail: {},
    loaded: {},
    errors: {},
    busy: {},
    syncedAt: null
  };

  function allTasks() {
    var out = [];
    (pipe.milestones || []).forEach(function (m) { (m.tasks || []).forEach(function (t) { out.push(t); }); });
    return out;
  }
  function taskById(id) {
    var found = null;
    allTasks().some(function (t) { if (t.id === id) { found = t; return true; } return false; });
    return found;
  }

  function setProjectName(name) {
    if (!name) return;
    var el = $('project-name');
    if (el) { el.textContent = name; el.hidden = false; }
    document.title = 'Nativ Studio · ' + name;
  }

  function fetchPipeline(parts) {
    return Promise.all(parts.map(function (part) {
      return api(PIPE_PATHS[part]).then(function (body) {
        applyPipeline(part, body);
        pipe.errors[part] = null;
      }, function (e) {
        pipe.errors[part] = e.message;
      }).then(function () { pipe.loaded[part] = true; });
    })).then(function () {
      pipe.syncedAt = new Date();
      refreshUi(parts);
    });
  }

  function applyPipeline(part, body) {
    if (part === 'status') {
      pipe.status = body.pipeline || null;
      if (pipe.status) setProjectName(pipe.status.projectName);
    } else if (part === 'tasks') {
      pipe.milestones = Array.isArray(body.milestones) ? body.milestones : [];
      setProjectName(body.projectName);
    } else if (part === 'worktrees') {
      pipe.worktrees = Array.isArray(body.worktrees) ? body.worktrees : [];
    } else if (part === 'runs') {
      pipe.runs = Array.isArray(body.runs) ? body.runs : [];
    } else if (part === 'benchmarks') {
      pipe.report = body.report || null;
    } else if (part === 'telemetry') {
      pipe.telemetry = { summary: body.summary || {}, taskBreakdowns: Array.isArray(body.taskBreakdowns) ? body.taskBreakdowns : [] };
    } else if (part === 'escalations') {
      pipe.escalations = Array.isArray(body.escalations) ? body.escalations : [];
      syncHealTab();
      renderTriageChip();
    } else if (part === 'triage') {
      pipe.triage = body;
      renderTriageChip();
    }
  }

  /** Rebuilds the client model from the raw slices. */
  function rebuildModel() {
    Studio.setModel(buildModel({
      milestones: pipe.milestones,
      status: pipe.status,
      telemetry: pipe.telemetry,
      runs: pipe.runs,
      escalations: pipe.escalations,
      logTail: pipe.logTail
    }));
  }

  /** Newest pending escalation for a task (the list arrives newest first). */
  function escalationFor(taskId) {
    var found = null;
    (pipe.escalations || []).some(function (e) { if (e.taskId === taskId && e.status === 'pending_review') { found = e; return true; } return false; });
    return found;
  }

  /** The main (non-agent) worktree is the workspace root and carries the active branch. */
  function mainWorktree() {
    var main = null;
    pipe.worktrees.some(function (w) { if (!w.isAgentWorktree) { main = w; return true; } return false; });
    return main;
  }

  /** 1234 becomes "1.2k" so the sidebar badge stays small. */
  function compactNum(n) {
    if (!isFinite(n)) return '–';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(Math.round(n));
  }

  /** Newest Just-finished style helpers live in pages; here only what the runner tools need. */
  var RUN_LABEL = {
    spawning_worktree: 'Worktree', running: 'Claude Running', verifying: 'Verifying', merging: 'Merging',
    completed: 'Run completed', failed: 'Run failed', aborted: 'Run aborted'
  };
  function runFor(taskId) {
    var found = null;
    (pipe.runs || []).some(function (r) { if (r.taskId === taskId) { found = r; return true; } return false; });
    return found;
  }
  function upsertRun(run) {
    if (!run || !run.taskId) return;
    pipe.runs = [run].concat((pipe.runs || []).filter(function (r) { return r.taskId !== run.taskId; }));
  }
  function elapsedOf(run) {
    if (!run || !run.startedAt) return null;
    var ms = isRunActive(run) ? Date.now() - Date.parse(run.startedAt) : run.durationMs;
    return typeof ms === 'number' && isFinite(ms) && ms >= 0 ? ms : null;
  }
  /** mm:ss elapsed time shown in the console drawer. */
  function mmss(ms) {
    var total = Math.floor((ms || 0) / 1000);
    var mm = Math.floor(total / 60), ss = total % 60;
    return (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
  }

`;
