import { ICON_PATHS, ST_SVG } from './icons.js';

// Pure client core: the Studio object, formatting and small html helpers. No DOM access.
export const formatScript = String.raw`  // ─── Studio client core: state, formatting and html helpers (pure) ─────────
  var Studio = {
    pages: {},
    order: [],
    model: null,
    state: { view: 'home', milestoneId: null, focusTaskId: null, detailTaskId: null },
    icons: ${JSON.stringify(ICON_PATHS)},
    stSvg: ${JSON.stringify(ST_SVG)},
    now: function () { return Date.now(); },
    registerPage: function (id, def) { Studio.pages[id] = def || {}; },
    go: function () {},
    openTask: function () {},
    closeDetail: function () {},
    repaint: function () {},
    toast: function () {},
    taskAction: function () {}
  };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  var BUCKETS = [['next', 'Up next'], ['running', 'Running'], ['done', 'Done'], ['stuck', 'Stuck']];
  var BUCKET_WORD = {};
  BUCKETS.forEach(function (b) { BUCKET_WORD[b[0]] = b[1]; });
  var STATUS_BUCKET = { completed: 'done', in_progress: 'running', pending: 'next', blocked: 'stuck' };
  var STATUS_LABEL = {};
  Object.keys(STATUS_BUCKET).forEach(function (k) { STATUS_LABEL[k] = BUCKET_WORD[STATUS_BUCKET[k]]; });
  var RUN_BUCKET = { spawning_worktree: 'running', running: 'running', verifying: 'running',
    merging: 'running', completed: 'done', failed: 'stuck', aborted: 'next' };

  var status = {
    buckets: BUCKETS,
    isReady: function (t) {
      return t.status === 'pending' && (!!t.isAvailable || !(t.waitingOn || []).length);
    },
    bucket: function (t) {
      if (t.status === 'completed') return 'done';
      if (t.status === 'in_progress') return t.stale ? 'next' : 'running';
      if (t.status === 'blocked') return 'stuck';
      return 'next';
    },
    runBucket: function (run) { return run ? (RUN_BUCKET[run.status] || null) : null; },
    word: function (key) { return BUCKET_WORD[key] || STATUS_LABEL[key] || 'Unknown'; },
    waitText: function (t) {
      if (t.status !== 'pending' || status.isReady(t)) return '';
      var n = (t.waitingOn || []).length;
      return n === 1 ? 'Waits for 1 task' : 'Waits for ' + n + ' tasks';
    }
  };
  var AGENTS = {
    'backend': ['Backend', '--ag-backend'],
    'frontend': ['Frontend', '--ag-frontend'],
    'qa-tester': ['QA tester', '--ag-qa'],
    'flutter-developer': ['Flutter', '--ag-flutter'],
    'architect': ['Architect', '--ag-architect'],
    'devops-agent': ['DevOps', '--ag-devops'],
    'database': ['Database', '--ag-database'],
    'security-auditor': ['Security', '--ag-security'],
    'db-migration': ['DB migration', '--ag-database'],
    'backend-agent': ['Backend', '--ag-backend'],
    'frontend-agent': ['Frontend', '--ag-frontend'],
    'qa-agent': ['QA tester', '--ag-qa'],
    'database-agent': ['Database', '--ag-database']
  };
  /** Label and colour token for an agent id; unknown ids keep their raw id and the neutral colour. */
  function agentInfo(id) {
    var known = AGENTS[id];
    return known ? { label: known[0], token: known[1] } : { label: String(id || 'unassigned'), token: '--fg-3' };
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  var fmt = {
    dur: function (ms) {
      if (ms == null || isNaN(ms)) return '-';
      var s = Math.round(ms / 1000);
      if (s < 60) return s + 's';
      if (s < 3600) return Math.floor(s / 60) + 'm ' + pad2(s % 60) + 's';
      return Math.floor(s / 3600) + 'h ' + pad2(Math.floor((s % 3600) / 60)) + 'm';
    },
    ago: function (t) {
      if (!t) return 'time not recorded';
      var s = Math.round((Studio.now() - t) / 1000);
      if (s < 45) return 'just now';
      if (s < 3600) return Math.round(s / 60) + 'm ago';
      if (s < 86400) return Math.round(s / 3600) + 'h ago';
      return Math.round(s / 86400) + 'd ago';
    },
    clock: function (t) { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); },
    day: function (t) { return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }); },
    full: function (t) {
      if (!t) return 'not recorded';
      return new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    },
    money: function (v) { return v == null || isNaN(v) ? '-' : '$' + Number(v).toFixed(2); }
  };

  /** Grounded spend is small per task: four decimals below a dollar. */
  function usdSpend(n) {
    if (n == null || isNaN(n)) return '-';
    n = Number(n);
    return '$' + (n >= 1 ? n.toFixed(2) : n.toFixed(4));
  }

  /** Wraps inner SVG paths (256-unit box, fill icon) in an svg element. */
  function svgWrap(inner, width) {
    return '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">' + (inner || '') + '</svg>';
  }
  function svgIcon(name, width) { return svgWrap(Studio.icons[name], width); }

  var ui = {
    esc: esc,
    icon: svgIcon,
    svg: svgWrap,
    statusIcon: function (status) {
      var label = STATUS_LABEL[status] || 'Unknown';
      var mark = status === 'in_progress' ? '<span class="pulse"></span>' : (Studio.stSvg[status] || Studio.stSvg.pending);
      return '<span class="st ' + esc(status) + '" title="' + esc(label) + '">' + mark + '</span>';
    },
    agentChip: function (agent) {
      var info = agentInfo(agent);
      return '<span class="agent" style="--c:var(' + info.token + ')"><i></i>' + esc(info.label) + '</span>';
    },
    pill: function (status, text) {
      return '<span class="status-pill ' + esc(status) + '">' + esc(text || STATUS_LABEL[status] || status) + '</span>';
    },
    when: function (t) {
      if (!t) return '<time title="not recorded">time not recorded</time>';
      return '<time datetime="' + new Date(t).toISOString() + '" title="' + esc(fmt.full(t)) + '">' + esc(fmt.ago(t)) + '</time>';
    },
    taskRow: function (task, rightText) {
      var right = rightText != null ? rightText : (task.endT ? fmt.ago(task.endT) : '');
      return '<button type="button" class="row-btn" data-task="' + esc(task.id) + '">' + ui.statusIcon(task.status) +
        '<span class="mono faint hide-sm">' + esc(task.id) + '</span><span class="t">' + esc(task.title) + '</span>' +
        '<span class="hide-sm">' + ui.agentChip(task.agent) + '</span>' +
        '<span class="faint num row-right">' + esc(right) + '</span></button>';
    },
    milestoneSelect: function () {
      var model = Studio.model;
      if (!model) return '';
      var current = Studio.state.milestoneId;
      var opts = model.milestones.slice().reverse().map(function (m) {
        var count = m.done + '/' + m.total + (m.id === model.activeMilestoneId ? ', active' : '');
        var text = m.id + ' ' + m.short + ' (' + count + ')';
        return '<option value="' + esc(m.id) + '"' + (m.id === current ? ' selected' : '') + '>' + esc(text) + '</option>';
      }).join('');
      return '<select class="sel" data-ms-select aria-label="Milestone">' + opts + '</select>';
    },
    empty: function (title, text) {
      return '<div class="ui-empty"><b>' + esc(title) + '</b>' + esc(text || '') + '</div>';
    },
    skeleton: function () {
      var bar = function (w) { return '<div class="skel" style="width:' + w + '"></div>'; };
      return '<div class="skel-head">' + bar('180px') + bar('320px') + '</div>' +
        '<div class="skel-block">' + bar('100%') + bar('92%') + bar('74%') + '</div>' +
        '<div class="skel-block">' + bar('100%') + bar('88%') + bar('60%') + '</div>';
    }
  };

  Studio.fmt = fmt;
  Studio.ui = ui;
  Studio.status = status;
  Studio.agentInfo = agentInfo;
  Studio.statusLabel = function (status) { return STATUS_LABEL[status] || 'Unknown'; };

  var OLD_HASHES = { overview: 'home', canvas: 'flow', pods: 'team' };
  /** Turns a location hash into a page id; old hashes redirect, unknown ones fall back to Home. */
  Studio.resolveHash = function (hash, ids) {
    var h = String(hash || '').replace(/^#/, '');
    if (OLD_HASHES[h]) h = OLD_HASHES[h];
    return ids.indexOf(h) !== -1 ? h : 'home';
  };

`;
