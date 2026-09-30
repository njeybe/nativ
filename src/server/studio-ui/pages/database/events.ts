// Database Studio event wiring.
export const databaseEventsScript = String.raw`  // ─── Events: Database Studio ───────────────────────────────────────────────
  function setDbTab(tab, focus) {
    state.tab = tab;
    renderDb();
    if (focus) $('tab-' + tab).focus();
    if (tab === 'data' && (!state.dataResult || state.dataResult.entity !== state.dataEntity)) {
      fetchDataRecords();
    }
  }

  document.querySelectorAll('.subtab').forEach(function (t) {
    t.addEventListener('click', function () { setDbTab(t.getAttribute('data-tab')); });
    t.addEventListener('keydown', function (e) {
      var order = ['explorer', 'data', 'drift', 'sql'];
      var i = order.indexOf(state.tab);
      if (e.key === 'ArrowRight') { e.preventDefault(); setDbTab(order[(i + 1) % 4], true); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setDbTab(order[(i + 3) % 4], true); }
      else if (e.key === 'Home') { e.preventDefault(); setDbTab('explorer', true); }
      else if (e.key === 'End') { e.preventDefault(); setDbTab('sql', true); }
    });
  });

  document.querySelectorAll('.env-seg-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var mode = btn.getAttribute('data-env-mode');
      if (mode) {
        state.envMode = mode;
        if (mode === 'prod') state.dataEnv = 'prod';
        else if (mode === 'dev') state.dataEnv = 'dev';
        state.dataResult = null;
        renderDb();
        if (state.tab === 'data') fetchDataRecords();
      }
    });
  });

  $('btn-settings').addEventListener('click', openSettings);
  $('btn-export').addEventListener('click', function () {
    var btn = $('btn-export');
    var st = state.status || {};
    var sourceEnv = st.dev && st.dev.connected ? 'dev' : (st.prod && st.prod.connected ? 'prod' : 'dev');
    if (!window.confirm('Export the ' + sourceEnv.toUpperCase() + ' schema (structure only, no credentials or data) to .ai/db_schema.json?\nThis overwrites the tables in the current contract.')) return;
    btn.disabled = true;
    postJson('/api/export-contract', { sourceEnv: sourceEnv }).then(function (r) {
      var n = r.exportedEntitiesCount != null ? r.exportedEntitiesCount : r.exportedTablesCount;
      toast('Exported ' + n + ' ' + entityNoun(st[sourceEnv], true).toLowerCase() + ' to ' + r.filePath, 'ok');
      if (state.diffTarget === 'contract') load(true);
    }, function (e) { toast('Export failed: ' + e.message); }).then(function () { btn.disabled = false; });
  });

  $('view').addEventListener('input', function (e) {
    if (e.target && e.target.id === 'search') {
      state.search = e.target.value;
      var pos = e.target.selectionStart;
      renderDb();
      var s = $('search');
      if (s) { s.focus(); try { s.setSelectionRange(pos, pos); } catch (err) { /* ignore */ } }
    }
    if (e.target && e.target.id === 'data-search') {
      state.dataSearch = e.target.value;
      clearTimeout(state._dataSearchTimeout);
      state._dataSearchTimeout = setTimeout(function () {
        state.dataPage = 1;
        fetchDataRecords();
      }, 350);
    }
  });

  $('view').addEventListener('change', function (e) {
    if (e.target && e.target.id === 'diff-target') { state.diffTarget = e.target.value; load(false); }
    if (e.target && e.target.id === 'data-entity-select') {
      state.dataEntity = e.target.value;
      state.dataPage = 1;
      state.dataSort = '';
      state.dataSearch = '';
      state.dataResult = null;
      fetchDataRecords();
    }
    if (e.target && e.target.id === 'data-limit-select') {
      state.dataLimit = Number(e.target.value);
      state.dataPage = 1;
      fetchDataRecords();
    }
  });

  $('view').addEventListener('mouseover', function (e) {
    var el = e.target.closest && e.target.closest('[data-media]');
    if (el) showThumb(el);
  });
  $('view').addEventListener('mouseout', function (e) {
    var el = e.target.closest && e.target.closest('[data-media]');
    if (el && !el.contains(e.relatedTarget)) hideThumb();
  });
  $('view').addEventListener('focusin', function (e) {
    if (e.target.hasAttribute && e.target.hasAttribute('data-media')) showThumb(e.target);
  });
  $('view').addEventListener('focusout', hideThumb);
  window.addEventListener('scroll', hideThumb, { passive: true });

  $('view').addEventListener('click', function (e) {
    var sortTh = e.target.closest('th.sortable');
    if (sortTh) {
      var col = sortTh.getAttribute('data-sort-col');
      if (col) {
        if (state.dataSort === col) {
          state.dataOrder = state.dataOrder === 'asc' ? 'desc' : 'asc';
        } else {
          state.dataSort = col;
          state.dataOrder = 'asc';
        }
        fetchDataRecords();
        return;
      }
    }

    var el = e.target.closest('button');
    if (!el) return;
    if (el.hasAttribute('data-media')) {
      // Keep the <details> card from toggling when the badge sits in a summary row.
      e.preventDefault();
      openMedia(Number(el.getAttribute('data-media')));
      return;
    }
    var action = el.getAttribute('data-action');
    if (action === 'open-settings') openSettings();
    else if (action === 'copy-sql') copyText(state.sql, el);
    else if (action === 'edit-record') openEditRecordModal(Number(el.getAttribute('data-row')));
    else if (action === 'delete-record') handleDeleteRecord(Number(el.getAttribute('data-row')));
    else if (action === 'preview-url') {
      var url = el.getAttribute('data-url');
      $('media-title').textContent = 'Image Preview';
      $('media-sub').textContent = url;
      $('media-thumb').innerHTML = '<img src="' + esc(url) + '" style="max-width:100%;max-height:300px">';
      $('media-details').innerHTML = '<dt>Source URL</dt><dd><code>' + esc(url) + '</code></dd>';
      openDialog($('media-dialog'));
    }
    else if (action === 'view-json') {
      var raw = el.getAttribute('data-raw');
      toast(raw);
    }

    if (el.id === 'btn-insert-record') openInsertRecordModal();
    else if (el.id === 'btn-data-refresh') fetchDataRecords();
    else if (el.id === 'btn-page-prev') {
      state.dataPage = Math.max(1, state.dataPage - 1);
      fetchDataRecords();
    }
    else if (el.id === 'btn-page-next') {
      state.dataPage++;
      fetchDataRecords();
    }

    var envToggle = el.getAttribute('data-env-toggle');
    if (envToggle) { state.mobileEnv = envToggle; renderDb(); }
  });

  $('btn-save-record').addEventListener('click', handleSaveRecordSubmit);

  $('challenge-input').addEventListener('input', function (e) {
    var val = e.target.value.trim();
    var entity = state.pendingMutation ? state.pendingMutation.entity : '';
    $('btn-confirm-challenge').disabled = (val !== entity);
  });

  $('btn-confirm-challenge').addEventListener('click', function () {
    if (!state.pendingMutation) return;
    var m = state.pendingMutation;
    var inputVal = $('challenge-input').value.trim();
    if (inputVal !== m.entity) return;
    executeMutationDirect(m.action, m.entity, m.pk, m.payload, true, inputVal);
  });

  $('conn-form').addEventListener('click', function (e) {
    var el = e.target.closest('button');
    if (!el) return;
    var toggle = el.getAttribute('data-toggle');
    if (toggle) {
      var input = $('url-' + toggle);
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      el.textContent = show ? 'Hide' : 'Show';
      el.setAttribute('aria-pressed', String(show));
    }
    var pingEnv = el.getAttribute('data-ping');
    if (pingEnv) {
      el.disabled = true;
      ping(pingEnv).then(function (ok) { el.disabled = false; if (ok) load(false).then(renderModalStatus); });
    }
    var copyEnv = el.getAttribute('data-copy-masked');
    if (copyEnv && state.status && state.status[copyEnv]) copyText(state.status[copyEnv].maskedUrl, el);
  });

  ['dev', 'prod'].forEach(function (env) {
    $('engine-' + env).addEventListener('change', function () { setEngineMode(env); });
    $('pengine-' + env).addEventListener('change', function () {
      var port = $('pport-' + env);
      // Swap the port only when it still holds the other engine's default.
      if (!port.value.trim() || port.value.trim() === DEFAULT_PORT.mysql || port.value.trim() === DEFAULT_PORT.postgresql) {
        port.value = DEFAULT_PORT[$('pengine-' + env).value];
      }
    });
    document.querySelector('[data-xampp="' + env + '"]').addEventListener('click', function () { applyXamppDefaults(env); });
  });

  $('btn-save-conn').addEventListener('click', function () {
    var envs = ['dev', 'prod'].filter(hasInput);
    if (!envs.length) { $('conn-dialog').close(); return; }
    var btn = $('btn-save-conn');
    btn.disabled = true;
    Promise.all(envs.map(ping)).then(function (results) {
      btn.disabled = false;
      load(false).then(renderModalStatus);
      if (results.every(Boolean)) { $('conn-dialog').close(); toast('Connections saved to in-memory session', 'ok'); }
    });
  });

  // Clear any typed secrets whenever the modal closes.
  $('conn-dialog').addEventListener('close', function () {
    ['dev', 'prod'].forEach(function (env) {
      var input = $('url-' + env);
      input.value = ''; input.type = 'password';
      $('fsproject-' + env).value = '';
      $('fsemu-' + env).value = '';
      PARAM_FIELDS.forEach(function (f) { $(f + '-' + env).value = ''; });
      var t = document.querySelector('[data-toggle="' + env + '"]');
      if (t) { t.textContent = 'Show'; t.setAttribute('aria-pressed', 'false'); }
    });
  });

`;
