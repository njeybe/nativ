// Database Studio data loading and shell.
export const databaseDataScript = String.raw`  // ─── View 5: Database Studio — data loading ────────────────────────────────
  function load(fresh) {
    state.loading = true;
    renderDb();
    var q = fresh ? '?refresh=1' : '';
    var diffPath = '/api/diff?target=' + state.diffTarget + (fresh ? '&refresh=1' : '');
    return Promise.all([
      api('/api/status' + q).catch(function (e) { toast(e.message); return null; }),
      api('/api/schema' + q).catch(function (e) { toast(e.message); return { devTables: [], prodTables: [] }; }),
      api(diffPath).then(function (d) { state.diffError = null; return d; }, function (e) { state.diffError = e.message; return null; }),
      api('/api/env-info').catch(function () { return null; })
    ]).then(function (results) {
      state.status = results[0];
      state.schema = results[1];
      state.diff = results[2];
      state.envInfo = results[3];
      state.diffTargetUsed = state.diffTarget;
      state.loading = false;
      if (state.status) {
        ['dev', 'prod'].forEach(function (env) {
          var s = state.status[env];
          if (s && !s.connected && s.error && !/No (Dev|Prod) database configured/.test(s.error)) {
            toast((env === 'dev' ? 'Dev' : 'Prod') + ' connection failed: ' + s.error);
          }
        });
      }
      renderDb();
    });
  }

  // ─── Database Studio: shell ────────────────────────────────────────────────
  /** DB_HOST -> DB_*, PROD_DB_HOST -> PROD_DB_*, PGHOST -> PG*. */
  function keyFamily(key) {
    var m = /^(.*_)[^_]*$/.exec(key);
    return m ? m[1] + '*' : key.slice(0, 2) + '*';
  }

  /** Local-stack hint when fragmented DB_* keys resolve to a server that refuses connections. */
  function fragmentedDiagnostic(s) {
    var cfg = state.envInfo && state.envInfo.fragmentedConfig;
    if (!s || s.connected || !s.synthesized || !cfg) return '';
    if (!/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH/i.test(s.error || '')) return '';
    var keys = cfg.sourceKeys.filter(function (k) { return /HOST|DATABASE|_DB$|DB_NAME$/.test(k); });
    var label = ENGINE_LABEL[cfg.engine] || cfg.engine;
    var action = cfg.engine === 'mysql'
      ? 'Ensure MySQL is started in XAMPP Control Panel.'
      : 'Ensure the PostgreSQL service is running on ' + cfg.host + ':' + cfg.port + '.';
    return 'Detected fragmented ' + label + ' config (' + (keys.length ? keys : cfg.sourceKeys).join(', ') + '). ' + action;
  }

  function statusPill(env, s) {
    var label = env.toUpperCase();
    if (!s) return '<span class="pill"><span class="dot"></span><b>' + label + ':</b> loading…</span>';
    if (!s.connected) {
      var why = /No (Dev|Prod) database configured/.test(s.error || '') ? 'not configured' : 'offline';
      return '<span class="pill" title="' + esc(s.error || '') + '"><span class="dot off"></span><b>' + label + ':</b> ' + why +
        ' <span class="badge badge-offline">OFFLINE</span></span>';
    }
    var sourceBadge = s.synthesized && s.sourceKey
      ? ' <span class="badge badge-synth" title="Assembled in memory from fragmented .env keys">synthesized from ' + esc(keyFamily(s.sourceKey)) + '</span>'
      : s.detectedFromExample && s.sourceKey
        ? ' <span class="badge badge-source" title="Detected in ' + esc(s.exampleFile || '.env.example') + '">via ' + esc(s.sourceKey) + '</span>'
        : (s.sourceKey ? ' <span class="badge badge-source">via ' + esc(s.sourceKey) + '</span>' : '');
    return '<span class="pill" title="' + esc(s.maskedUrl) + '"><span class="dot on"></span><b>' + label + ':</b> ' +
      esc(ENGINE_LABEL[s.engine] || s.engine) + (s.database ? ' · ' + esc(s.database) : '') + ' (' + Math.round(s.pingMs) + 'ms) – ' +
      entityCount(s) + ' ' + entityNoun(s, true) + sourceBadge + ' <span class="badge badge-online">ONLINE</span></span>';
  }

  function renderDbShell() {
    var st = state.status || {};
    $('telemetry').innerHTML = statusPill('dev', st.dev) + statusPill('prod', st.prod);

    var bannerEl = $('diagnostic-banner');
    if (bannerEl) {
      var devS = st.dev;
      var prodS = st.prod;
      var activeS = state.envMode === 'prod' ? prodS : devS;
      var suggestion = fragmentedDiagnostic(activeS) || fragmentedDiagnostic(devS) ||
        (activeS && !activeS.connected && activeS.suggestion) ||
        (devS && !devS.connected && devS.suggestion) ||
        (prodS && !prodS.connected && prodS.suggestion);

      if (!suggestion && state.envInfo && state.envInfo.missingKeys && state.envInfo.missingKeys.length > 0) {
        var missingForActive = state.envInfo.missingKeys.find(function (k) {
          return k.targetEnv === (state.envMode === 'prod' ? 'prod' : 'dev');
        }) || state.envInfo.missingKeys[0];
        if (missingForActive && ((missingForActive.targetEnv === 'dev' && (!devS || !devS.connected)) || (missingForActive.targetEnv === 'prod' && (!prodS || !prodS.connected)))) {
          var engLabel = missingForActive.engine ? ' (' + (ENGINE_LABEL[missingForActive.engine] || missingForActive.engine) + ')' : '';
          suggestion = 'Detected "' + missingForActive.key + '"' + engLabel + ' in ' + (state.envInfo.templateFile || '.env.example') + ', but it is not set in your .env file.';
        }
      }

      if (suggestion && ((!devS || !devS.connected) || (!prodS || !prodS.connected))) {
        bannerEl.innerHTML = '<div class="diagnostic-banner">' +
          '<div class="diagnostic-content">' +
            '<span class="diagnostic-tag">[DIAGNOSTIC]</span> ' +
            '<span class="diagnostic-msg">' + esc(suggestion) + '</span>' +
          '</div>' +
          '<div class="diagnostic-actions">' +
            '<button class="btn small" type="button" id="btn-diag-settings">Open Connection Settings</button>' +
          '</div>' +
        '</div>';
        bannerEl.hidden = false;
        var btnDiag = $('btn-diag-settings');
        if (btnDiag) {
          btnDiag.onclick = function () { openSettings(); };
        }
      } else {
        bannerEl.innerHTML = '';
        bannerEl.hidden = true;
      }
    }

    $('count-explorer').textContent = String((state.schema.devTables || []).length + (state.schema.prodTables || []).length);
    var activeEnv = state.envMode === 'prod' ? 'prod' : 'dev';
    var dataCount = state.dataResult && state.dataResult.totalCount != null
      ? state.dataResult.totalCount
      : ((state.schema[activeEnv + 'Tables'] || []).length);
    $('count-data').textContent = String(dataCount);
    var d = state.diff && state.diff.summary;
    $('count-drift').textContent = d ? String(d.addedTablesCount + d.alteredTablesCount + d.droppedTablesCount) : '–';
    var script = state.diff ? generateScript(state.diff) : { text: '', lang: 'sql', count: 0 };
    state.sql = script.text;
    state.scriptLang = script.lang;
    state.scriptCount = script.count;
    $('count-sql').textContent = String(script.count);
    document.querySelectorAll('.subtab').forEach(function (t) {
      var active = t.getAttribute('data-tab') === state.tab;
      t.setAttribute('aria-selected', active ? 'true' : 'false');
      t.setAttribute('tabindex', active ? '0' : '-1');
    });
    document.querySelectorAll('.env-seg-btn').forEach(function (btn) {
      var m = btn.getAttribute('data-env-mode');
      btn.setAttribute('aria-pressed', String(m === state.envMode));
    });
    $('view').setAttribute('aria-labelledby', 'tab-' + state.tab);
  }

  function renderDb() {
    renderDbShell();
    mediaRegistry = [];
    hideThumb();
    var view = $('view');
    if (state.loading) { view.innerHTML = dbSkeleton(); return; }
    if (state.tab === 'explorer') view.innerHTML = renderExplorer();
    else if (state.tab === 'data') view.innerHTML = renderData();
    else if (state.tab === 'drift') view.innerHTML = renderDrift();
    else view.innerHTML = renderSql();
  }

  function dbSkeleton() {
    var col = '<div class="pane card">' + '<div class="skeleton short"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
    return '<div class="sr-only">Loading database schema…</div><div class="panes" aria-busy="true">' + col + col + '</div>';
  }

  var DB_ICON = '<svg class="icon empty-icon" width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">' +
    '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/></svg>';

  function emptyState(title, text) {
    return '<div class="empty card">' + DB_ICON + '<h3>' + esc(title) + '</h3><p>' + esc(text) + '</p>' +
      '<button class="btn primary" type="button" data-action="open-settings">Connection Settings</button></div>';
  }

`;
