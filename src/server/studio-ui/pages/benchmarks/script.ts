// Benchmarks view script.
export const benchmarksScript = String.raw`  // ─── View 4: Synthetic benchmarks ──────────────────────────────────────────
  var SCENARIOS = [
    { id: 'concurrency', label: 'Multi-Agent Concurrency' },
    { id: 'telemetry', label: 'Telemetry Engine' },
    { id: 'governor', label: 'Governor Invariants' },
    { id: 'verification', label: 'Gatekeeper' },
    { id: 'e2e_pipeline', label: 'E2E Lifecycle' }
  ];

  function renderBenchmarks() {
    var running = !!pipe.busy.bench;
    var runBtn = '<button class="btn primary" type="button" data-act="bench-run"' + (running ? ' disabled' : '') + '>' +
      (running ? '<span class="spinner" aria-hidden="true"></span>Running…' : ICON.play + 'Run Benchmark') + '</button>';
    var head = panelHead('Synthetic Benchmarks', 'Sandboxed stress runs of plan locking, telemetry, the contract governor, the verification gatekeeper and the full agent lifecycle.', runBtn);
    if (!pipe.loaded.benchmarks) return head + '<div class="card section" aria-hidden="true"><div class="skeleton tall"></div></div><div class="scenario-grid" aria-hidden="true">' + skeletonCards(5, 'scenario') + '</div>';
    if (pipe.errors.benchmarks && !pipe.report) return head + errorCard('benchmark report', pipe.errors.benchmarks, 'benchmarks');
    var r = pipe.report;
    if (!r) {
      return head + '<div class="card state" aria-busy="' + running + '"><div class="state-icon">' + (running ? '<span class="spinner" aria-hidden="true"></span>' : ICON.gauge) + '</div>' +
        '<h2>' + (running ? 'Running benchmark matrix…' : 'No benchmark report yet') + '</h2>' +
        '<p>' + (running ? 'Scenarios run in throwaway sandboxes; this usually takes a few seconds.' : 'Run the synthetic matrix to measure throughput and score all five pipeline scenarios. Results are cached in .ai/benchmark_report.json.') + '</p></div>';
    }
    return head + staleNote('benchmarks') + benchHero(r, running) + '<div class="scenario-grid">' + scenarioCards(r) + '</div>';
  }

  function benchHero(r, running) {
    var s = r.summary || {};
    var env = r.environment || {};
    var meta = [];
    if (r.timestamp) meta.push('Ran ' + esc(fmtDate(r.timestamp)));
    if (env.platform) meta.push(esc(env.platform + (env.arch ? ' ' + env.arch : '')));
    if (env.nodeVersion) meta.push('Node ' + esc(env.nodeVersion));
    if (env.cpuCount) meta.push(env.cpuCount + ' CPUs');
    var score = clampPct(s.score);
    return '<section class="card hero' + (running ? ' is-running' : '') + '" aria-labelledby="hero-h" aria-busy="' + running + '">' +
      '<div><h2 class="eyebrow" id="hero-h">Average throughput</h2>' +
      '<div class="hero-value">' + num(Math.round(s.averageThroughputOpsPerSec || 0)) + '<span class="badge badge-accent">ops/sec</span></div>' +
      '<p class="hero-meta">' + meta.join(' · ') + '</p></div>' +
      '<dl class="hero-stats">' +
        '<div><dt>Score</dt><dd class="' + (score < 100 ? 'text-danger' : '') + '">' + score + '%</dd></div>' +
        '<div><dt>Scenarios passed</dt><dd>' + num(s.passedScenarios) + '/' + num(s.totalScenarios) + '</dd></div>' +
        '<div><dt>Total duration</dt><dd>' + fmtMs(s.totalDurationMs) + '</dd></div>' +
        '<div><dt>Operations</dt><dd>' + num(s.totalOperations) + '</dd></div>' +
      '</dl></section>';
  }

  function scenarioCards(r) {
    var byId = {}, known = {};
    (r.scenarios || []).forEach(function (s) { byId[s.id] = s; });
    var cards = SCENARIOS.map(function (meta) { known[meta.id] = true; return scenarioCard(meta.label, byId[meta.id]); });
    (r.scenarios || []).forEach(function (s) { if (!known[s.id]) cards.push(scenarioCard(s.name || s.id, s)); });
    return cards.join('');
  }

  function scenarioCard(label, s) {
    if (!s) {
      return '<article class="card scenario is-idle"><header class="scenario-head"><h3>' + esc(label) + '</h3><span class="badge badge-neutral">Not run</span></header>' +
        '<p class="muted">Not part of the last run. Run the full matrix to score it.</p></article>';
    }
    var total = (s.assertionsPassed || 0) + (s.assertionsFailed || 0);
    var passed = s.status === 'passed';
    var score = total ? Math.round((s.assertionsPassed || 0) / total * 100) : (passed ? 100 : 0);
    var details = Object.keys(s.details || {}).slice(0, 4).map(function (k) {
      var v = s.details[k];
      // Lists (e.g. invariant names) get a full-width row of chips instead of a cramped value column.
      if (Array.isArray(v)) {
        return '<dt class="wide">' + esc(humanize(k)) + '</dt><dd class="wide">' + v.map(function (item) { return '<span class="chip">' + esc(detailValue(item)) + '</span>'; }).join('') + '</dd>';
      }
      return '<dt>' + esc(humanize(k)) + '</dt><dd>' + esc(detailValue(v)) + '</dd>';
    }).join('');
    var errors = (s.errors || []).length ? '<ul class="scenario-errors">' + s.errors.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul>' : '';
    return '<article class="card scenario"><header class="scenario-head"><h3>' + esc(label) + '</h3>' +
      '<span class="badge badge-' + (passed ? 'success' : 'danger') + '">' + (passed ? 'Passed' : 'Failed') + '</span></header>' +
      (s.name && s.name !== label ? '<p class="scenario-sub">' + esc(s.name) + '</p>' : '') +
      '<div class="metrics"><div><span class="metric-v">' + score + '%</span><span class="metric-l">Score</span></div>' +
      '<div><span class="metric-v">' + fmtMs(s.durationMs) + '</span><span class="metric-l">Latency</span></div>' +
      '<div><span class="metric-v">' + num(Math.round(s.throughputOpsPerSec || 0)) + '</span><span class="metric-l">ops/sec</span></div></div>' +
      progressBar(score, 'sc-' + s.id, label + ' score', passed ? 'success' : 'danger') +
      (details ? '<dl class="details">' + details + '</dl>' : '') + errors + '</article>';
  }

  function runBenchmark() {
    if (pipe.busy.bench) return;
    pipe.busy.bench = true;
    repaint('benchmarks');
    postJson('/api/pipeline/benchmarks/run', {}).then(function (r) {
      if (r.report) { pipe.report = r.report; pipe.errors.benchmarks = null; pipe.loaded.benchmarks = true; }
      var s = r.report && r.report.summary;
      toast('Benchmark finished' + (s ? ': score ' + clampPct(s.score) + '%, ' + s.passedScenarios + '/' + s.totalScenarios + ' scenarios passed' : ''), 'ok');
    }, function (e) {
      toast('Benchmark run failed: ' + e.message);
    }).then(function () {
      pipe.busy.bench = false;
      repaint('benchmarks');
    });
  }

  Studio.registerPage('benchmarks', {
    deps: ['benchmarks'],
    render: function () { return renderBenchmarks(); },
    actions: { 'bench-run': function () { runBenchmark(); } }
  });
`;
