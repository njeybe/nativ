// Live sync over the event stream.
export const syncScript = String.raw`  // ─── Real-time sync: EventSource on /api/events ────────────────────────────
  var live = { mode: 'connecting', es: null, retry: 0, timer: null, lastBeat: 0, sawBeat: false, opened: false };
  var LIVE_TEXT = { connecting: 'Connecting', live: 'Live', offline: 'Reconnecting' };
  // Keys are SSE event names on the wire; values are the pipeline slices each one invalidates.
  var EVENT_PARTS = {
    // .ai/escalation.json writes (circuit-breaker trips, resolutions) arrive as plan changes.
    'plan_change': ['status', 'tasks', 'worktrees', 'escalations', 'triage'],
    // The server also reports .ai/benchmark_report.json writes (e.g. a CLI "nativ bench") as telemetry changes.
    'telemetry_change': ['status', 'benchmarks', 'telemetry'],
    'benchmark_change': ['benchmarks'],
    'worktree_change': ['worktrees']
  };

  function setLive(mode, detail) {
    live.mode = mode;
    var el = $('live');
    el.setAttribute('data-state', mode);
    $('live-label').textContent = LIVE_TEXT[mode];
    el.title = detail || (mode === 'live' ? 'Receiving real-time updates from /api/events' : '');
    paintChrome();
  }

  function flashLive() {
    var dot = $('live-dot');
    dot.classList.remove('flash');
    void dot.offsetWidth;
    dot.classList.add('flash');
  }

  // fs.watch fires several events per write; batch them into one refetch.
  var queuedParts = {}, queueTimer = null;
  function queueRefresh(parts) {
    parts.forEach(function (p) { queuedParts[p] = true; });
    clearTimeout(queueTimer);
    queueTimer = setTimeout(function () {
      var list = Object.keys(queuedParts);
      queuedParts = {};
      fetchPipeline(list);
    }, 150);
  }

  function onStreamEvent(type) {
    live.lastBeat = Date.now();
    if (type === 'heartbeat' || type === 'ping') { live.sawBeat = true; return; }
    var parts = EVENT_PARTS[type];
    if (!parts) return;
    flashLive();
    queueRefresh(parts);
    if (parts.indexOf('worktrees') !== -1) queueConsoleDiff();
  }

  function connectEvents() {
    clearTimeout(live.timer);
    if (typeof window.EventSource !== 'function') {
      setLive('offline', 'This browser has no EventSource support; refreshing every 15 seconds instead.');
      setInterval(function () { fetchPipeline(ALL_PARTS); }, 15000);
      return;
    }
    if (live.es) live.es.close();
    setLive('connecting');
    var es = new EventSource('/api/events');
    live.es = es;
    es.onopen = function () {
      live.retry = 0;
      live.lastBeat = Date.now();
      setLive('live');
      // Catch up on anything written while the stream was down.
      if (live.opened) queueRefresh(ALL_PARTS);
      live.opened = true;
    };
    es.onerror = function () {
      if (es.readyState === EventSource.CLOSED) scheduleReconnect();
      else setLive('connecting', 'Reconnecting to /api/events');
    };
    // Unnamed events may carry the type in a JSON payload: { "type": "plan_change" }.
    es.onmessage = function (e) {
      var type = 'message';
      try { type = JSON.parse(e.data).type || type; } catch (err) { /* plain-text payload */ }
      onStreamEvent(type);
    };
    Object.keys(EVENT_PARTS).concat(['heartbeat', 'ping']).forEach(function (name) {
      es.addEventListener(name, function () { onStreamEvent(name); });
    });
    // Runner events carry a payload, so they bypass the slice-invalidation table.
    es.addEventListener('runner_status', function (e) {
      live.lastBeat = Date.now();
      flashLive();
      onRunnerStatus(parseEventData(e));
    });
    es.addEventListener('runner_log', function (e) {
      live.lastBeat = Date.now();
      onRunnerLog(parseEventData(e));
    });
    // Native engine: one event per API turn with the delta and the run's running total.
    es.addEventListener('runner_token_usage', function (e) {
      live.lastBeat = Date.now();
      flashLive();
      onRunnerUsage(parseEventData(e));
    });
  }

  function parseEventData(e) {
    try { return JSON.parse(e.data); } catch (err) { return null; }
  }

  function scheduleReconnect() {
    if (live.es) { live.es.close(); live.es = null; }
    var delay = Math.min(30000, 1000 * Math.pow(2, live.retry++));
    setLive('offline', 'Live stream unavailable; retrying in ' + Math.round(delay / 1000) + 's');
    clearTimeout(live.timer);
    live.timer = setTimeout(connectEvents, delay);
  }

  // Heartbeat watchdog: armed only once the server has shown it sends heartbeats.
  setInterval(function () {
    if (live.es && live.sawBeat && Date.now() - live.lastBeat > 45000) scheduleReconnect();
  }, 15000);

`;
