// Database Studio explorer and media preview.
export const databaseExplorerScript = String.raw`  // ─── Database Studio: explorer ─────────────────────────────────────────────
  function diffBadges() {
    var map = { dev: {}, prod: {} };
    var d = state.diff;
    if (!d) return map;
    var lower = function (n) { return String(n).toLowerCase(); };
    d.addedTables.forEach(function (t) { map.dev[lower(t.name)] = 'added'; });
    d.alteredTables.forEach(function (t) { map.dev[lower(t.name)] = 'altered'; if (state.diffTargetUsed === 'prod') map.prod[lower(t.name)] = 'altered'; });
    if (state.diffTargetUsed === 'prod') d.droppedTables.forEach(function (t) { map.prod[lower(t.name)] = 'dropped'; });
    return map;
  }

  var BADGE_TEXT = { added: 'NEW TABLE', altered: 'ALTERED', dropped: 'DROPPED' };

  /** IMAGE badge: hover shows a thumbnail tooltip, click opens the media modal. */
  function mediaBadge(t, c) {
    if (!c.isMedia) return '';
    var i = mediaRegistry.push({ table: t.name, field: c.name, type: c.type, media: c.media || null }) - 1;
    return '<button type="button" class="badge badge-media" data-media="' + i + '" aria-label="Preview image field ' + esc(c.name) + '">IMAGE</button>';
  }

  function tableCard(t, badge) {
    var coll = isCollection(t);
    var fkCols = {};
    (t.foreignKeys || []).forEach(function (fk) { fkCols[String(fk.column).toLowerCase()] = fk; });
    var rows = t.columns.map(function (c) {
      var fk = fkCols[String(c.name).toLowerCase()];
      var tags = (c.primaryKey ? '<span class="badge badge-pk">PK</span> ' : '') +
        (fk ? '<span class="badge badge-fk" title="→ ' + esc(fk.referencedTable + '.' + fk.referencedColumn) + '">FK</span> ' : '') +
        (c.isSubcollection ? '<span class="badge badge-subcol">SUBCOLLECTION</span> ' : '') +
        mediaBadge(t, c);
      var typeCell = esc(c.type) + (c.observedTypes ? ' <span class="muted">(' + esc(c.observedTypes.join(' | ')) + ')</span>' : '');
      var lastCell = coll
        ? (c.presence != null ? Math.round(c.presence * 100) + '%' : '<span class="muted">–</span>')
        : (c.default == null ? '<span class="muted">NULL</span>' : esc(c.default));
      return '<tr><td>' + (tags || '<span class="muted">–</span>') + '</td><td class="mono">' + esc(c.name) +
        (fk ? ' <span class="muted">→ ' + esc(fk.referencedTable + '.' + fk.referencedColumn) + '</span>' : '') + '</td><td class="mono">' + typeCell +
        '</td><td>' + (c.nullable ? 'YES' : '<b>NO</b>') + '</td><td class="mono">' + lastCell + '</td></tr>';
    }).join('');
    var idx = (t.indexes || []).length
      ? '<div class="subhead">Indexes</div><ul class="idx-list">' + t.indexes.map(function (i) {
          return '<li><code>' + esc(i.name) + '</code> (' + esc(i.columns.join(', ')) + ')' + (i.unique ? ' <span class="muted">unique</span>' : '') + '</li>';
        }).join('') + '</ul>'
      : '';
    var docMeta = coll && (t.documentCount != null || t.sampledDocuments != null)
      ? '<p class="desc">' + (t.documentCount != null ? '~' + t.documentCount + ' documents' : 'Document count unavailable') +
        (t.sampledDocuments != null ? ' · fields inferred from ' + t.sampledDocuments + ' sampled' : '') + '</p>'
      : '';
    return '<details class="table-card"><summary><span class="tname">' + esc(t.name) + '</span>' +
      (coll ? '<span class="badge badge-collection">COLLECTION</span>' : '') +
      (badge ? '<span class="badge badge-' + badge + '">' + BADGE_TEXT[badge] + '</span>' : '') +
      '<span class="ccount">' + t.columns.length + (coll ? ' fields' : ' cols') + '</span></summary><div class="table-body">' +
      (t.description ? '<p class="desc">' + esc(t.description) + '</p>' : '') + docMeta +
      '<table class="cols"><thead><tr><th scope="col">Key</th><th scope="col">' + (coll ? 'Field' : 'Name') + '</th><th scope="col">Type</th><th scope="col">Nullable</th><th scope="col">' +
      (coll ? 'Presence' : 'Default') + '</th></tr></thead><tbody>' +
      rows + '</tbody></table>' + idx + '</div></details>';
  }

  // ─── Database Studio: media preview ────────────────────────────────────────
  var SOURCE_LABEL = { url: 'Image URL', gcs: 'Cloud Storage URI', base64: 'Base64 string', bytes: 'Binary (Bytes)' };

  function thumbHtml(m) {
    if (m && isPreviewableUrl(m.sampleUrl)) {
      return '<img src="' + esc(m.sampleUrl) + '" alt="" loading="lazy" referrerpolicy="no-referrer" data-thumb>';
    }
    var why = !m ? 'No sample available'
      : m.source === 'gcs' ? 'gs:// URIs need a signed URL to preview'
      : (m.source === 'bytes' || m.source === 'base64') ? 'Binary preview withheld (metadata only)'
      : 'No preview available';
    return '<div class="ph">' + esc(why) + '</div>';
  }

  // Swap broken thumbnails (auth-protected URLs or blocked by the page's content policy) for a note.
  document.addEventListener('error', function (e) {
    var img = e.target;
    if (img && img.tagName === 'IMG' && img.hasAttribute('data-thumb')) {
      var ph = document.createElement('div');
      ph.className = 'ph';
      ph.textContent = 'Preview unavailable (URL needs auth, was redacted, or is blocked by the studio content policy)';
      img.replaceWith(ph);
    }
  }, true);

  function mediaSummary(m) {
    if (!m) return '';
    var parts = [m.mimeType || 'unknown type'];
    if (m.width && m.height) parts.push(m.width + '×' + m.height);
    if (m.sizeBytes != null) parts.push(formatBytes(m.sizeBytes));
    return parts.join(' · ');
  }

  function showThumb(el) {
    var entry = mediaRegistry[Number(el.getAttribute('data-media'))];
    if (!entry) return;
    var pop = $('thumb-pop');
    pop.innerHTML = '<div class="thumb-box">' + thumbHtml(entry.media) + '</div><div class="thumb-meta"><b>' + esc(entry.table + '.' + entry.field) +
      '</b><br>' + esc(mediaSummary(entry.media)) + '</div>';
    pop.hidden = false;
    // Place beside the badge so the field names in the row stay readable; flip left near the edge.
    var r = el.getBoundingClientRect();
    var w = pop.offsetWidth, h = pop.offsetHeight;
    var left = r.right + 12 + w > window.innerWidth ? r.left - w - 12 : r.right + 12;
    var top = Math.min(r.top + r.height / 2 - h / 2, window.innerHeight - h - 8);
    pop.style.left = Math.max(8, left) + 'px';
    pop.style.top = Math.max(8, top) + 'px';
  }

  function hideThumb() {
    var pop = $('thumb-pop');
    if (pop) { pop.hidden = true; pop.innerHTML = ''; }
  }

  function openMedia(index) {
    var entry = mediaRegistry[index];
    if (!entry) return;
    hideThumb();
    var m = entry.media;
    $('media-title').textContent = entry.table + '.' + entry.field;
    $('media-sub').textContent = (m ? SOURCE_LABEL[m.source] || m.source : 'Image field') + ' · ' + entry.type;
    $('media-thumb').innerHTML = thumbHtml(m);
    var rows = [];
    if (m) {
      if (m.sampleUrl) rows.push(['Sample ' + (m.source === 'gcs' ? 'URI' : 'URL'), '<code>' + esc(m.sampleUrl) + '</code>']);
      rows.push(['MIME type', esc(m.mimeType || 'unknown')]);
      rows.push(['Size', esc(m.sizeBytes != null ? formatBytes(m.sizeBytes) : 'unknown')]);
      rows.push(['Dimensions', esc(m.width && m.height ? m.width + ' × ' + m.height + ' px' : 'unknown')]);
      // Base64 is truncated to a short prefix server-side; render it as plain text only.
      if (m.base64Head) rows.push(['Base64 (truncated)', '<code>' + esc(m.base64Head) + '</code>']);
    }
    $('media-details').innerHTML = rows.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + r[1] + '</dd>'; }).join('');
    openDialog($('media-dialog'));
  }

  function paneHtml(env, tables, badges) {
    var s = state.status && state.status[env];
    var title = env === 'dev' ? 'Dev / Staging' : 'Production';
    var q = state.search.trim().toLowerCase();
    var filtered = tables.filter(function (t) {
      if (!q) return true;
      if (t.name.toLowerCase().indexOf(q) !== -1) return true;
      return t.columns.some(function (c) { return c.name.toLowerCase().indexOf(q) !== -1; });
    });
    var body;
    if (!s || !s.connected) {
      body = '<div class="empty" style="padding:28px 12px"><p>' + esc(s && s.error ? s.error : 'No database connected.') + '</p>' +
        '<button class="btn small" type="button" data-action="open-settings">Connect</button></div>';
    } else if (!tables.length) {
      body = '<p class="muted">Connected, but this database has no ' + entityNoun(s, true).toLowerCase() + ' yet.</p>';
    } else if (!filtered.length) {
      body = '<p class="muted">No ' + entityNoun(s, true).toLowerCase() + ' or fields match “' + esc(state.search) + '”.</p>';
    } else {
      body = filtered.map(function (t) { return tableCard(t, badges[t.name.toLowerCase()]); }).join('');
    }
    return '<section class="pane card" aria-labelledby="pane-' + env + '">' +
      '<div class="pane-head"><h2 id="pane-' + env + '"><span class="dot ' + (s && s.connected ? 'on' : 'off') + '"></span>' + title + '</h2>' +
      '<span class="meta">' + (s && s.connected ? esc(s.maskedUrl) : '') + '</span></div>' + body + '</section>';
  }

  function renderExplorer() {
    var st = state.status || {};
    if (!(st.dev && st.dev.connected) && !(st.prod && st.prod.connected)) {
      return emptyState('No database connected', 'No database connected. Click Connection Settings to connect a local or remote database.');
    }
    var badges = diffBadges();
    var panesHtml = '';
    if (state.envMode === 'dev') {
      panesHtml = '<div class="panes panes-full">' + paneHtml('dev', state.schema.devTables || [], badges.dev) + '</div>';
    } else if (state.envMode === 'prod') {
      panesHtml = '<div class="prod-banner"><span><b>Production Focus Active:</b> Browsing production schema and collections. Any data modifications require challenge phrase confirmation.</span>' +
        '<span class="badge badge-prod">PROD</span></div>' +
        '<div class="panes panes-full">' + paneHtml('prod', state.schema.prodTables || [], badges.prod) + '</div>';
    } else {
      panesHtml = '<div class="panes">' + paneHtml('dev', state.schema.devTables || [], badges.dev) + paneHtml('prod', state.schema.prodTables || [], badges.prod) + '</div>';
    }

    return '<div class="toolbar">' +
      '<label class="sr-only" for="search">Search tables, collections and fields</label>' +
      '<input class="input search" id="search" type="search" placeholder="Search tables, collections or fields…" value="' + esc(state.search) + '">' +
      '</div>' + panesHtml;
  }

`;
