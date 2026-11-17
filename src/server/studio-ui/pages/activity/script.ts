// Activity page client script: one lane per agent, then the feed. Reads the shell activity slice.
export const activityScript = String.raw`  var esc = Studio.ui.esc;
  var WIN_KEY = 'nativ-studio:activity-window';
  var CHIPS = [['30m', '30m'], ['2h', '2h'], ['today', 'Today']];
  var STATUS = { active: 'Active', idle: 'Idle', stopped: 'Done', failed: 'Failed', paused: 'Paused' };
  var FEED_SHOW = 50, FEED_KEEP = 200, MIN_GAP = 500;
  var chip = '30m';
  var feed = [];
  var seen = {};

  try {
    var saved = localStorage.getItem(WIN_KEY);
    if (saved === '30m' || saved === '2h' || saved === 'today') chip = saved;
  } catch (e) { /* storage blocked */ }

  function windowMinutes() {
    if (chip === '2h') return 120;
    if (chip === '30m') return 30;
    var now = new Date(Studio.now());
    var start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return Math.max(1, Math.floor((now.getTime() - start) / 60000));
  }

  function windowWords() {
    return chip === '2h' ? 'in the last 2 hours' : chip === 'today' ? 'today' : 'in the last 30 minutes';
  }

  function applyWindow() {
    PIPE_PATHS.activity = '/api/pipeline/activity?windowMinutes=' + windowMinutes();
  }
  applyWindow();

  // Refetch at most once per 500 ms; a later call waits and runs once.
  var lastFetch = 0, waiting = null;
  var baseFetch = fetchPipeline;
  fetchPipeline = function (parts) {
    if (parts.indexOf('activity') < 0) return baseFetch(parts);
    var wait = MIN_GAP - (Date.now() - lastFetch);
    if (parts.length > 1 || wait <= 0) { lastFetch = Date.now(); applyWindow(); return baseFetch(parts); }
    if (!waiting) {
      waiting = setTimeout(function () {
        waiting = null; lastFetch = Date.now(); applyWindow(); baseFetch(['activity']);
      }, wait);
    }
    return Promise.resolve();
  };

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function clockTime(iso) {
    var d = new Date(iso);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function elapsed(ms) {
    var s = Math.max(0, Math.floor((ms || 0) / 1000));
    var h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
    return (h ? pad(h) + ':' : '') + pad(m) + ':' + pad(s % 60);
  }

  function ago(iso) {
    var s = Math.max(0, Math.round((Studio.now() - Date.parse(iso)) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    return Math.round(s / 3600) + 'h ago';
  }

  function head(lanes) {
    var n = lanes.filter(function (l) { return l.status === 'active' || l.status === 'idle'; }).length;
    var chips = CHIPS.map(function (c) {
      var on = c[0] === chip;
      return '<button type="button" class="chip' + (on ? ' on' : '') + '" data-act="act-window" data-w="' + c[0] +
        '" aria-pressed="' + on + '">' + c[1] + '</button>';
    }).join('');
    return '<div class="act-head"><h1>Activity</h1><span class="act-count">' + n + (n === 1 ? ' agent' : ' agents') +
      '</span><div class="chips" role="group" aria-label="Time window">' + chips + '</div></div>';
  }

  function btn(act, label, lane, extra) {
    return '<button type="button" class="act-btn" data-act="' + act + '" data-lane="' + esc(lane.id) + '"' +
      (extra || '') + '>' + label + '</button>';
  }

  function actions(l) {
    var out = '';
    var runner = l.kind === 'runner';
    if (runner && l.task) out += btn('act-console', 'Console', l);
    if (runner && l.task && l.runId) out += btn('act-transcript', 'Transcript', l);
    if (!runner && l.transcriptPath) {
      out += '<span class="tip-wrap">' + btn('act-copy', 'Copy transcript path', l) +
        '<span class="tooltip">Copied</span></span>';
    }
    if (l.task) out += btn('act-changes', 'View changes', l);
    return out ? '<div class="lane-actions">' + out + '</div>' : '';
  }

  function fileLine(l) {
    var f = l.files || { count: 0, top: [] };
    var known = l.tokens && l.tokens.total != null;
    var tok = known ? 'tokens ' + Number(l.tokens.total).toLocaleString('en-US') : 'tokens -';
    var names = (f.top || []).slice(0, 3).map(function (x) {
      var base = String(x.path || '').split('/').pop();
      return '<span class="mono file" title="' + esc(x.path) + '">' + esc(base) +
        ' +' + x.added + ' -' + x.removed + '</span>';
    }).join('');
    return '<div class="lane-l3"><span>' + f.count + (f.count === 1 ? ' file' : ' files') + '</span>' + names +
      '<span class="mono tok">' + esc(tok) + '</span></div>';
  }

  function laneRow(l) {
    var t = l.task;
    var st = STATUS[l.status] ? l.status : 'idle';
    var task = t ? '<span class="mono">' + esc(t.id) + '</span><span class="ttl" title="' +
      esc(t.title || t.id) + '">' +
      esc(t.title || '') + '</span>' : '<span class="none">No task</span>';
    var last = l.last ? '<span class="txt" title="' + esc(l.last.text) + '">' + esc(l.last.text) +
      '</span><span class="ago">' +
      esc(ago(l.last.at)) + '</span>' : '<span class="none">No activity yet</span>';
    return '<section class="lane" data-lane-id="' + esc(l.id) + '"><div class="lane-main">' +
      '<div class="lane-l1"><b class="lbl">' + esc(l.label) + '</b><span class="mono model">' +
      esc(l.model || '-') + '</span>' +
      task + '<span class="st st-' + st + '"><i class="dot"></i>' + STATUS[st] + '</span>' +
      '<span class="mono time">' + elapsed(l.elapsedMs) + '</span></div>' +
      '<div class="lane-l2">' + last + '</div>' + fileLine(l) + '</div>' + actions(l) + '</section>';
  }

  function eventText(e) {
    var d = e.data || {};
    if (e.kind === 'tool') {
      if (d.spawn) return 'Agent ' + d.spawn.agentType;
      var what = d.path || d.program || '';
      var cnt = d.path && (d.added != null || d.removed != null) ? ' +' + (d.added || 0) + ' -' + (d.removed || 0) : '';
      return (d.name || 'tool') + (what ? ' ' + what : '') + cnt;
    }
    if (e.kind === 'verify') return d.pass ? 'verify passed' : 'verify failed';
    return e.kind + ' ' + (d.action || d.status || d.phase || d.rule || '');
  }

  function keyOf(e) { return e.cursor || e.at + e.kind + (e.lane && e.lane.id); }

  function absorb(events) {
    events.forEach(function (e) {
      var key = keyOf(e);
      if (seen[key]) return;
      seen[key] = true;
      feed.push(e);
    });
    if (feed.length > FEED_KEEP) {
      feed.slice(0, feed.length - FEED_KEEP).forEach(function (e) { delete seen[keyOf(e)]; });
      feed = feed.slice(-FEED_KEEP);
    }
  }

  function feedRow(e) {
    var ln = e.lane || {};
    var who = ln.role || ln.agent || ln.agentType || (e.src === 'runner' ? 'runner' : 'main session');
    var text = eventText(e);
    return '<li><span class="mono">' + clockTime(e.at) + '</span>' +
      '<span class="who">' + esc(who) + '</span><span class="mono tid">' + esc(e.task ? e.task.id : '') + '</span>' +
      '<span class="txt" title="' + esc(text) + '">' + esc(text) + '</span></li>';
  }

  function feedHtml() {
    if (!feed.length) return '';
    return '<ol class="feed" aria-label="Recent events">' + feed.slice(-FEED_SHOW).map(feedRow).join('') + '</ol>';
  }

  function emptyHtml() {
    return '<div class="act-empty"><p>No agent activity ' + windowWords() + '.</p>' +
      '<p class="hint">Chat agents are recorded after <span class="mono">nativ setup</span>; ' +
      'Studio runs always are.</p></div>';
  }

  function skeleton() {
    var lane = '<div class="lane"><div class="skel" style="width:60%"></div>' +
      '<div class="skel" style="width:90%"></div>' +
      '<div class="skel" style="width:40%"></div></div>';
    return head([]) + lane + lane + lane;
  }

  function render() {
    var a = pipe.activity;
    var err = pipe.errors.activity;
    if (err && !a.lanes.length) return head([]) + errorCard('activity', err, 'activity');
    absorb(a.events);
    var body = a.lanes.length ? a.lanes.map(laneRow).join('') : emptyHtml();
    return head(a.lanes) + staleNote('activity') + '<div class="lanes">' + body + '</div>' + feedHtml();
  }

  function laneById(el) {
    var id = el.getAttribute('data-lane');
    return pipe.activity.lanes.filter(function (l) { return l.id === id; })[0] || null;
  }

  function showTranscript(l) {
    openConsole(l.task.id, false, 'logs');
    $('rc-body').textContent = 'Loading transcript...';
    api('/api/pipeline/runs/transcript?run=' + encodeURIComponent(l.runId)).then(function (body) {
      if (rc.taskId !== l.task.id) return;
      $('rc-body').textContent = body.text || 'No transcript was recorded for this run.';
    }, function (e) {
      if (rc.taskId === l.task.id) $('rc-body').textContent = 'Could not load the transcript: ' + e.message;
    });
  }

  function setChip(el) {
    chip = el.getAttribute('data-w');
    try { localStorage.setItem(WIN_KEY, chip); } catch (e) { /* storage blocked */ }
    applyWindow();
    fetchPipeline(['activity']);
    Studio.repaint('activity');
  }

  function withLane(fn) { return function (el) { var l = laneById(el); if (l) fn(l, el); }; }

  Studio.registerPage('activity', {
    deps: ['activity'],
    actions: {
      'act-window': setChip,
      'act-console': withLane(function (l) { openConsole(l.task.id, false, 'logs'); }),
      'act-transcript': withLane(showTranscript),
      'act-changes': withLane(function (l) { openConsole(l.task.id, false, 'diff'); }),
      'act-copy': withLane(function (l, el) { copyText(l.transcriptPath, el); })
    },
    render: render,
    skeleton: skeleton
  });
`;
