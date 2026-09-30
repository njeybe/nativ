// Database Studio live data browser.
export const databaseBrowserScript = String.raw`  // ─── Database Studio: live data browser ────────────────────────────────────
  function renderDataCell(val, colName) {
    if (val === null || val === undefined) return '<td class="mono muted">NULL</td>';
    if (typeof val === 'boolean') return '<td class="mono"><b>' + (val ? 'TRUE' : 'FALSE') + '</b></td>';
    if (typeof val === 'string') {
      var isImgUrl = /^https?:\/\//i.test(val) && /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)/i.test(val);
      var isDataImg = /^data:image\//i.test(val);
      if (isImgUrl || isDataImg) {
        return '<td><button type="button" class="cell-preview-btn" data-action="preview-url" data-url="' + esc(val) + '">Preview Image</button> <span class="mono muted" style="font-size:11px">' + esc(val.length > 28 ? val.slice(0, 28) + '…' : val) + '</span></td>';
      }
      var displayStr = val.length > 50 ? val.slice(0, 50) + '…' : val;
      return '<td class="mono" title="' + esc(val) + '">' + esc(displayStr) + '</td>';
    }
    if (typeof val === 'object') {
      var json = JSON.stringify(val);
      var display = json.length > 40 ? json.slice(0, 40) + '…' : json;
      return '<td class="mono cell-expandable" title="Click to expand JSON" data-action="view-json" data-raw="' + esc(json) + '">' + esc(display) + '</td>';
    }
    return '<td class="mono">' + esc(String(val)) + '</td>';
  }

  function renderData() {
    var activeEnv = state.envMode === 'prod' ? 'prod' : 'dev';
    state.dataEnv = activeEnv;
    var s = state.status && state.status[activeEnv];
    if (!s || !s.connected) {
      return emptyState((activeEnv === 'dev' ? 'Dev / Staging' : 'Production') + ' database not connected',
        'Please connect the ' + (activeEnv === 'dev' ? 'Dev' : 'Prod') + ' database in Connection Settings to browse and edit live data.');
    }

    var tables = state.schema[activeEnv + 'Tables'] || [];
    if (!tables.length) {
      return '<div class="empty card"><p>No ' + entityNoun(s, true).toLowerCase() + ' found in this database.</p></div>';
    }

    if (!state.dataEntity || !tables.some(function (t) { return t.name === state.dataEntity; })) {
      state.dataEntity = tables[0].name;
    }

    var currentTable = tables.find(function (t) { return t.name === state.dataEntity; }) || tables[0];
    var isColl = isCollection(currentTable);

    var entityOptions = tables.map(function (t) {
      var sel = t.name === state.dataEntity ? ' selected' : '';
      return '<option value="' + esc(t.name) + '"' + sel + '>' + esc(t.name) + (isCollection(t) ? ' (collection)' : '') + '</option>';
    }).join('');

    var limitOptions = [25, 50, 100].map(function (n) {
      var sel = state.dataLimit === n ? ' selected' : '';
      return '<option value="' + n + '"' + sel + '>' + n + ' / page</option>';
    }).join('');

    var prodBannerHtml = activeEnv === 'prod'
      ? '<div class="prod-banner"><span><b>Production Safeguard Active:</b> Operating on live production data. All mutations require strict challenge phrase confirmation and are recorded to .nativ/prod_audit.log.</span><span class="badge badge-prod">PROD</span></div>'
      : '';

    var toolbar = '<div class="data-toolbar">' +
      '<div class="data-controls">' +
        '<select class="input" id="data-entity-select" aria-label="Table or collection" style="min-width:180px;font-weight:600">' + entityOptions + '</select>' +
        '<input class="input" id="data-search" type="search" aria-label="Search records" placeholder="Search records in ' + esc(state.dataEntity) + '…" value="' + esc(state.dataSearch) + '" style="min-width:200px">' +
        '<select class="input" id="data-limit-select" aria-label="Rows per page">' + limitOptions + '</select>' +
        '<button class="btn" type="button" id="btn-data-refresh">Refresh</button>' +
      '</div>' +
      '<button class="btn primary" type="button" id="btn-insert-record">+ Insert ' + (isColl ? 'Document' : 'Record') + '</button>' +
    '</div>';

    if (state.dataLoading) {
      return prodBannerHtml + toolbar + '<div class="card" style="padding:48px 24px;text-align:center"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
    }

    if (state.dataError) {
      return prodBannerHtml + toolbar + '<div class="alert-danger" style="margin-top:12px"><strong>Query error:</strong> ' + esc(state.dataError) + '</div>';
    }

    var res = state.dataResult;
    if (!res || !res.rows || res.entity !== state.dataEntity) {
      setTimeout(function () { fetchDataRecords(); }, 10);
      return prodBannerHtml + toolbar + '<div class="card" style="padding:48px 24px;text-align:center"><p class="muted">Loading records for ' + esc(state.dataEntity) + '…</p></div>';
    }

    var pk = res.primaryKey || 'id';
    var schemaCols = currentTable.columns.map(function (c) { return c.name; });
    var allKeys = new Set(schemaCols);
    res.rows.forEach(function (r) { Object.keys(r).forEach(function (k) { allKeys.add(k); }); });
    var displayCols = [pk];
    allKeys.forEach(function (k) { if (k !== pk) displayCols.push(k); });

    var thead = '<tr><th class="th-actions" style="width:115px">Actions</th>' + displayCols.map(function (col) {
      var isSorted = state.dataSort === col;
      var sortIcon = isSorted ? (state.dataOrder === 'desc' ? ' ▼' : ' ▲') : '';
      return '<th class="sortable" data-sort-col="' + esc(col) + '">' + esc(col) +
        (col === pk ? ' <span class="badge badge-pk">PK</span>' : '') +
        '<span class="th-sort-icon">' + sortIcon + '</span></th>';
    }).join('') + '</tr>';

    var tbody = '';
    if (res.rows.length === 0) {
      tbody = '<tr><td colspan="' + (displayCols.length + 1) + '" style="text-align:center;padding:32px;color:var(--muted)">No records found' +
        (state.dataSearch ? ' matching "' + esc(state.dataSearch) + '"' : '') + '.</td></tr>';
    } else {
      tbody = res.rows.map(function (row, rowIdx) {
        var actions = '<td class="td-actions">' +
          '<button class="btn small" type="button" data-action="edit-record" data-row="' + rowIdx + '">Edit</button>' +
          '<button class="btn small btn-danger" type="button" data-action="delete-record" data-row="' + rowIdx + '">Delete</button>' +
        '</td>';

        var cells = displayCols.map(function (c) {
          return renderDataCell(row[c], c);
        }).join('');

        return '<tr>' + actions + cells + '</tr>';
      }).join('');
    }

    var start = res.totalCount === 0 ? 0 : (res.page - 1) * res.limit + 1;
    var end = Math.min(res.page * res.limit, res.totalCount);
    var pagination = '<div class="pagination-bar">' +
      '<div>Showing ' + start + '–' + end + ' of ' + res.totalCount + ' ' + (isColl ? 'documents' : 'records') + '</div>' +
      '<div class="pagination-ctrls">' +
        '<button class="btn small" type="button" id="btn-page-prev"' + (res.page <= 1 ? ' disabled' : '') + '>Previous</button>' +
        '<span>Page ' + res.page + ' of ' + Math.max(1, res.totalPages) + '</span>' +
        '<button class="btn small" type="button" id="btn-page-next"' + (res.page >= res.totalPages ? ' disabled' : '') + '>Next</button>' +
      '</div>' +
    '</div>';

    return prodBannerHtml + toolbar + '<div class="data-grid-wrap"><table class="data-table"><thead>' + thead + '</thead><tbody>' + tbody + '</tbody></table></div>' + pagination;
  }

  function fetchDataRecords() {
    if (!state.dataEntity) return;
    state.dataLoading = true;
    state.dataError = null;
    renderDb();

    var params = [
      'env=' + encodeURIComponent(state.dataEnv),
      'entity=' + encodeURIComponent(state.dataEntity),
      'page=' + state.dataPage,
      'limit=' + state.dataLimit
    ];
    if (state.dataSort) params.push('sort=' + encodeURIComponent(state.dataSort));
    if (state.dataOrder) params.push('order=' + encodeURIComponent(state.dataOrder));
    if (state.dataSearch) params.push('search=' + encodeURIComponent(state.dataSearch));

    api('/api/data?' + params.join('&')).then(function (res) {
      state.dataResult = res;
      state.dataLoading = false;
      renderDb();
    }, function (err) {
      state.dataError = err.message;
      state.dataLoading = false;
      renderDb();
    });
  }

  function openInsertRecordModal() {
    var tables = state.schema[state.dataEnv + 'Tables'] || [];
    var table = tables.find(function (t) { return t.name === state.dataEntity; }) || { columns: [] };
    var isColl = isCollection(table);

    $('record-title').textContent = 'Insert ' + (isColl ? 'Document' : 'Record') + ' into ' + state.dataEntity;
    $('record-lead').textContent = 'Target Environment: ' + state.dataEnv.toUpperCase() + '. Specify column values below:';
    $('btn-save-record').textContent = 'Insert ' + (isColl ? 'Document' : 'Record');
    state.editingPk = null;

    var html = '';
    table.columns.forEach(function (col) {
      var isPk = col.primaryKey;
      var fieldLabel = esc(col.name) + (isPk ? ' (Primary Key - Optional/Auto)' : '');
      var placeholder = col.type + (col.default ? ' · default: ' + col.default : '');
      var isLong = /json|map|array|text/i.test(col.type);
      if (isLong) {
        html += '<div class="field field-full"><label><b>' + fieldLabel + '</b></label><textarea class="input" name="' + esc(col.name) + '" placeholder="' + esc(placeholder) + '"></textarea></div>';
      } else {
        html += '<div class="field"><label><b>' + fieldLabel + '</b></label><input class="input" type="text" name="' + esc(col.name) + '" placeholder="' + esc(placeholder) + '"></div>';
      }
    });
    $('record-fields').innerHTML = html || '<p class="muted">No schema columns defined.</p>';
    openDialog($('record-dialog'));
  }

  function openEditRecordModal(rowIndex) {
    if (!state.dataResult || !state.dataResult.rows[rowIndex]) return;
    var row = state.dataResult.rows[rowIndex];
    var pkCol = state.dataResult.primaryKey || 'id';
    var pkVal = row[pkCol];
    state.editingPk = pkVal;

    var tables = state.schema[state.dataEnv + 'Tables'] || [];
    var table = tables.find(function (t) { return t.name === state.dataEntity; }) || { columns: [] };
    var isColl = isCollection(table);

    $('record-title').textContent = 'Edit ' + (isColl ? 'Document' : 'Record') + ' (' + pkCol + ' = ' + pkVal + ')';
    $('record-lead').textContent = 'Target Environment: ' + state.dataEnv.toUpperCase() + '. Primary key is locked for single-record isolation:';
    $('btn-save-record').textContent = 'Save Changes';

    var html = '';
    html += '<div class="field field-full"><label><b>' + esc(pkCol) + ' (Primary Key - Locked)</b></label><input class="input" type="text" name="' + esc(pkCol) + '" value="' + esc(pkVal) + '" disabled style="opacity:.65"></div>';

    var displayedCols = new Set([pkCol]);
    table.columns.forEach(function (col) {
      if (col.name === pkCol) return;
      displayedCols.add(col.name);
      var val = row[col.name];
      var valStr = val == null ? '' : typeof val === 'object' ? JSON.stringify(val) : String(val);
      var isLong = /json|map|array|text/i.test(col.type) || valStr.length > 50;
      if (isLong) {
        html += '<div class="field field-full"><label><b>' + esc(col.name) + ' (' + esc(col.type) + ')</b></label><textarea class="input" name="' + esc(col.name) + '">' + esc(valStr) + '</textarea></div>';
      } else {
        html += '<div class="field"><label><b>' + esc(col.name) + ' (' + esc(col.type) + ')</b></label><input class="input" type="text" name="' + esc(col.name) + '" value="' + esc(valStr) + '"></div>';
      }
    });

    Object.keys(row).forEach(function (k) {
      if (displayedCols.has(k)) return;
      var val = row[k];
      var valStr = val == null ? '' : typeof val === 'object' ? JSON.stringify(val) : String(val);
      html += '<div class="field"><label><b>' + esc(k) + '</b></label><input class="input" type="text" name="' + esc(k) + '" value="' + esc(valStr) + '"></div>';
    });

    $('record-fields').innerHTML = html;
    openDialog($('record-dialog'));
  }

  function parseInputValue(raw) {
    if (raw === '') return null;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
    if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);
    if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
      try { return JSON.parse(raw); } catch (e) { return raw; }
    }
    return raw;
  }

  function handleSaveRecordSubmit() {
    var form = $('record-form');
    var inputs = form.querySelectorAll('input, textarea');
    var data = {};
    inputs.forEach(function (inp) {
      if (inp.name && !inp.disabled) {
        var v = inp.value.trim();
        if (v !== '') data[inp.name] = parseInputValue(v);
      }
    });

    if (state.editingPk !== null) {
      dispatchMutation('UPDATE', state.dataEntity, state.editingPk, { updates: data });
    } else {
      dispatchMutation('INSERT', state.dataEntity, null, { record: data });
    }
  }

  function handleDeleteRecord(rowIndex) {
    if (!state.dataResult || !state.dataResult.rows[rowIndex]) return;
    var row = state.dataResult.rows[rowIndex];
    var pkCol = state.dataResult.primaryKey || 'id';
    var pkVal = row[pkCol];
    if (pkVal === undefined || pkVal === null) return;

    if (state.dataEnv === 'prod') {
      dispatchMutation('DELETE', state.dataEntity, pkVal, {});
    } else {
      if (window.confirm('Delete record ' + pkVal + ' from ' + state.dataEntity + '?')) {
        api('/api/data', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ env: state.dataEnv, entity: state.dataEntity, primaryKey: pkVal })
        }).then(function () {
          toast('Record deleted successfully', 'ok');
          fetchDataRecords();
        }, function (err) {
          toast('Delete failed: ' + err.message);
        });
      }
    }
  }

  function dispatchMutation(action, entity, pk, payload) {
    if (state.dataEnv === 'prod') {
      state.pendingMutation = { action: action, entity: entity, pk: pk, payload: payload };
      $('challenge-desc').textContent = 'Action: ' + action + ' on entity "' + entity + '"' + (pk != null ? ' (PK: ' + pk + ')' : '') + '.';
      $('challenge-target-name').textContent = entity;
      var input = $('challenge-input');
      input.value = '';
      $('btn-confirm-challenge').disabled = true;
      openDialog($('challenge-dialog'));
      input.focus();
    } else {
      executeMutationDirect(action, entity, pk, payload, false, '');
    }
  }

  function executeMutationDirect(action, entity, pk, payload, confirmProd, challengePhrase) {
    var method = action === 'INSERT' ? 'POST' : action === 'UPDATE' ? 'PUT' : 'DELETE';
    var body = Object.assign({
      env: state.dataEnv,
      entity: entity
    }, payload);
    if (pk != null) body.primaryKey = pk;
    if (confirmProd) {
      body.confirmProd = true;
      body.challengePhrase = challengePhrase;
    }

    api('/api/data', {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function () {
      if (confirmProd) {
        toast('Production ' + action.toLowerCase() + ' executed. Logged to .nativ/prod_audit.log', 'ok');
        $('challenge-dialog').close();
      } else {
        toast(action + ' executed successfully', 'ok');
      }
      $('record-dialog').close();
      fetchDataRecords();
    }, function (err) {
      toast(action + ' failed: ' + err.message);
    });
  }

`;
