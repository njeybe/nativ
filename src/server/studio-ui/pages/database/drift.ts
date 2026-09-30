// Database Studio drift and migration script.
export const databaseDriftScript = String.raw`  // ─── Database Studio: drift ────────────────────────────────────────────────
  function riskLevel(d) {
    var s = d.summary;
    if (s.hasDestructiveChanges || s.droppedTablesCount > 0) return 'HIGH';
    if (s.alteredTablesCount > 0) return 'MEDIUM';
    if (s.addedTablesCount > 0) return 'LOW';
    return 'NONE';
  }

  function targetSelect() {
    return '<div class="toolbar"><label for="diff-target" class="muted">Compare Dev against</label>' +
      '<select class="input" id="diff-target"><option value="prod"' + (state.diffTarget === 'prod' ? ' selected' : '') + '>Production database</option>' +
      '<option value="contract"' + (state.diffTarget === 'contract' ? ' selected' : '') + '>.ai/db_schema.json contract</option></select></div>';
  }

  function colCell(c) {
    if (!c) return '<span class="muted">—</span>';
    return esc(c.type) + (c.nullable ? '' : ' NOT NULL') + (c.default != null ? ' <span class="muted">DEFAULT</span> ' + esc(c.default) : '') +
      (c.primaryKey ? ' <span class="badge badge-pk">PK</span>' : '') + (c.isMedia ? ' <span class="badge badge-media">IMAGE</span>' : '') +
      (c.isSubcollection ? ' <span class="badge badge-subcol">SUBCOLLECTION</span>' : '');
  }

  function alteredTableHtml(t) {
    var targetLabel = state.diffTargetUsed === 'contract' ? 'Contract' : 'Prod';
    var rows = [];
    t.addedColumns.forEach(function (c) { rows.push('<tr class="row-added"><td class="mono">' + esc(c.name) + '</td><td><span class="badge badge-added">ADDED</span></td><td class="before mono">' + colCell(null) + '</td><td class="after mono">' + colCell(c) + '</td></tr>'); });
    t.alteredColumns.forEach(function (ch) { rows.push('<tr class="row-altered"><td class="mono">' + esc(ch.name) + '</td><td><span class="badge badge-altered">' + esc(ch.changedFields.join(', ').toUpperCase()) + '</span></td><td class="before mono">' + colCell(ch.before) + '</td><td class="after mono">' + colCell(ch.after) + '</td></tr>'); });
    t.droppedColumns.forEach(function (c) { rows.push('<tr class="row-dropped"><td class="mono">' + esc(c.name) + '</td><td><span class="badge badge-dropped">DROPPED</span></td><td class="before mono">' + colCell(c) + '</td><td class="after mono">' + colCell(null) + '</td></tr>'); });
    var extras = [];
    t.addedIndexes.forEach(function (i) { extras.push('<span class="chip" style="border-color:var(--success)">+ index ' + esc(i.name) + '</span>'); });
    t.droppedIndexes.forEach(function (i) { extras.push('<span class="chip" style="border-color:var(--danger)">− index ' + esc(i.name) + '</span>'); });
    t.addedForeignKeys.forEach(function (f) { extras.push('<span class="chip" style="border-color:var(--success)">+ FK ' + esc(f.column + ' → ' + f.referencedTable + '.' + f.referencedColumn) + '</span>'); });
    t.droppedForeignKeys.forEach(function (f) { extras.push('<span class="chip" style="border-color:var(--danger)">− FK ' + esc(f.column + ' → ' + f.referencedTable + '.' + f.referencedColumn) + '</span>'); });
    return '<details class="table-card" open><summary><span class="tname">' + esc(t.name) + '</span><span class="badge badge-altered">ALTERED</span>' +
      (t.isDestructive ? '<span class="badge badge-dropped">DESTRUCTIVE</span>' : '') + '</summary><div class="table-body">' +
      (rows.length ? '<table class="cols diff-table"><thead><tr><th scope="col">Column</th><th scope="col">Change</th><th scope="col">' + targetLabel + ' (before)</th><th scope="col">Dev (after)</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>' : '') +
      (extras.length ? '<div class="subhead">Indexes &amp; constraints</div><div class="chip-list">' + extras.join('') + '</div>' : '') + '</div></details>';
  }

  function renderDrift() {
    if (!state.diff) {
      return targetSelect() + emptyState('Drift unavailable', state.diffError || 'Connect both databases to compute schema drift.');
    }
    var d = state.diff, s = d.summary, risk = riskLevel(d);
    var targetLabel = state.diffTargetUsed === 'contract' ? 'the contract' : 'Prod';
    var noun = driftNoun(true);
    var html = targetSelect() + '<div class="summary-banner card" role="region" aria-label="Drift summary">' +
      '<div class="stat"><div class="n" style="color:var(--success)">' + s.addedTablesCount + '</div><div class="l">Added ' + noun + '</div></div>' +
      '<div class="stat"><div class="n" style="color:var(--active)">' + s.alteredTablesCount + '</div><div class="l">Altered ' + noun + '</div></div>' +
      '<div class="stat"><div class="n" style="color:var(--danger)">' + s.droppedTablesCount + '</div><div class="l">Dropped ' + noun + '</div></div>' +
      '<div class="stat"><div class="n muted">' + s.unchangedTablesCount + '</div><div class="l">Unchanged</div></div>' +
      '<div class="stat"><div class="n risk-' + risk + '">' + risk + '</div><div class="l">Risk level</div></div></div>';

    if (!s.addedTablesCount && !s.alteredTablesCount && !s.droppedTablesCount) {
      return html + '<div class="empty card"><h3>In sync</h3><p>Dev matches ' + esc(targetLabel) + '. No drift detected.</p></div>';
    }

    if (d.addedTables.length) {
      html += '<section class="section card"><h3><span class="badge badge-added">NEW TABLE</span> Added in Dev (' + d.addedTables.length + ')</h3>' +
        d.addedTables.map(function (t) { return tableCard(t, 'added'); }).join('') + '</section>';
    }
    if (d.alteredTables.length) {
      html += '<section class="section card"><h3><span class="badge badge-altered">ALTERED</span> Altered ' + noun + ' (' + d.alteredTables.length + ')</h3>' +
        d.alteredTables.map(alteredTableHtml).join('') + '</section>';
    }
    if (d.droppedTables.length) {
      html += '<section class="section card"><h3><span class="badge badge-dropped">DROPPED</span> Dropped in Dev (' + d.droppedTables.length + ')</h3>' +
        '<div class="alert-danger" role="alert"><strong>High severity:</strong> these ' + noun + ' exist in ' + esc(targetLabel) +
        ' but not in Dev. Applying this migration would permanently delete them and all their data.</div>' +
        d.droppedTables.map(function (t) { return tableCard(t, 'dropped'); }).join('') + '</section>';
    }
    return html;
  }

  // ─── Migration script (SQL DDL / MongoDB shell / Firestore index JSON) ─────
  function sqlDialect() {
    var st = state.status || {};
    if (state.diffTargetUsed === 'prod' && st.prod && st.prod.connected) return st.prod.engine;
    return (st.dev && st.dev.engine) || 'postgresql';
  }

  function generateScript(d) {
    var dialect = sqlDialect();
    if (dialect === 'mongodb') { var js = generateMongo(d); return { text: js, lang: 'js', count: countStatements(js, 'js') }; }
    if (dialect === 'firestore') return generateFirestore(d);
    var sql = generateSql(d);
    return { text: sql, lang: 'sql', count: countStatements(sql, 'sql') };
  }

  function generateMongo(d) {
    var target = state.diffTargetUsed === 'contract' ? '.ai/db_schema.json' : 'Prod';
    var coll = function (name) { return 'db.getCollection(' + JSON.stringify(name) + ')'; };
    var keySpec = function (i) {
      return '{ ' + i.columns.map(function (c) { return JSON.stringify(c) + ': 1'; }).join(', ') + ' }';
    };
    var createIdx = function (t, i) {
      return coll(t) + '.createIndex(' + keySpec(i) + ', { name: ' + JSON.stringify(i.name) + (i.unique ? ', unique: true' : '') + ' });';
    };
    var out = [
      '// Nativ migration preview: Dev → ' + target + ' (MongoDB shell)',
      '// Generated from structural metadata only. Review carefully; nothing is executed automatically.',
      ''
    ];

    d.addedTables.forEach(function (t) {
      out.push('// [NEW COLLECTION] ' + t.name);
      out.push('db.createCollection(' + JSON.stringify(t.name) + ');');
      (t.indexes || []).forEach(function (i) { out.push(createIdx(t.name, i)); });
      out.push('');
    });

    d.alteredTables.forEach(function (t) {
      out.push('// [ALTERED] ' + t.name + (t.isDestructive ? '  [DESTRUCTIVE]' : ''));
      t.droppedIndexes.forEach(function (i) { out.push(coll(t.name) + '.dropIndex(' + JSON.stringify(i.name) + ');'); });
      t.addedColumns.forEach(function (c) {
        if (c.isSubcollection) { out.push('// + subcollection ' + JSON.stringify(c.name) + ' (Firestore-only concept; model as a separate collection or embedded array in MongoDB)'); return; }
        out.push('// + field ' + JSON.stringify(c.name) + ' (' + c.type + '): schemaless, no DDL needed. Optional backfill:');
        out.push('// ' + coll(t.name) + '.updateMany({ ' + JSON.stringify(c.name) + ': { $exists: false } }, { $set: { ' + JSON.stringify(c.name) + ': null } });');
      });
      t.alteredColumns.forEach(function (ch) {
        out.push('// ~ field ' + JSON.stringify(ch.name) + ': ' + ch.before.type + ' → ' + ch.after.type + ' (' + ch.changedFields.join(', ') + '); convert existing values with a data migration.');
      });
      t.droppedColumns.forEach(function (c) {
        out.push('// [DESTRUCTIVE] removes field data from every document');
        out.push(coll(t.name) + '.updateMany({}, { $unset: { ' + JSON.stringify(c.name) + ': "" } });');
      });
      t.addedIndexes.forEach(function (i) { out.push(createIdx(t.name, i)); });
      out.push('');
    });

    d.droppedTables.forEach(function (t) {
      out.push('// [DESTRUCTIVE: DROPPED] ' + t.name + ': permanently deletes the collection and all documents');
      out.push(coll(t.name) + '.drop();');
      out.push('');
    });

    if (!d.addedTables.length && !d.alteredTables.length && !d.droppedTables.length) out.push('// No schema drift. Nothing to migrate.');
    return out.join('\n').replace(/\n+$/, '\n');
  }

  /** Firestore: deployable index definitions (firestore.indexes.json shape) plus a list of data-migration steps. */
  function generateFirestore(d) {
    var target = state.diffTargetUsed === 'contract' ? '.ai/db_schema.json' : 'Prod';
    var indexes = [], fieldOverrides = [], steps = [], warnings = [];
    var addIndex = function (collection, i) {
      if (i.unique) warnings.push('Firestore has no unique indexes: enforce uniqueness of ' + collection + '.' + i.columns.join('+') + ' (' + i.name + ') in application code or security rules.');
      if (i.columns.length > 1) {
        indexes.push({ collectionGroup: collection, queryScope: 'COLLECTION', fields: i.columns.map(function (f) { return { fieldPath: f, order: 'ASCENDING' }; }) });
      } else if (i.columns.length === 1) {
        fieldOverrides.push({ collectionGroup: collection, fieldPath: i.columns[0], indexes: [{ order: 'ASCENDING', queryScope: 'COLLECTION' }] });
      }
    };

    d.addedTables.forEach(function (t) {
      steps.push({ op: 'createCollection', collection: t.name, note: 'Collections are created implicitly by the first document write.' });
      (t.indexes || []).forEach(function (i) { addIndex(t.name, i); });
    });
    d.alteredTables.forEach(function (t) {
      t.addedColumns.forEach(function (c) {
        steps.push(c.isSubcollection
          ? { op: 'addSubcollection', collection: t.name, subcollection: c.name }
          : { op: 'addField', collection: t.name, field: c.name, type: c.type });
      });
      t.alteredColumns.forEach(function (ch) { steps.push({ op: 'changeField', collection: t.name, field: ch.name, from: ch.before.type, to: ch.after.type, changed: ch.changedFields }); });
      t.droppedColumns.forEach(function (c) { steps.push({ op: 'deleteField', collection: t.name, field: c.name, destructive: true }); });
      t.addedIndexes.forEach(function (i) { addIndex(t.name, i); });
      t.droppedIndexes.forEach(function (i) { steps.push({ op: 'removeIndex', collection: t.name, index: i.name, fields: i.columns }); });
    });
    d.droppedTables.forEach(function (t) {
      steps.push({ op: 'deleteCollection', collection: t.name, destructive: true, note: 'Permanently deletes every document (e.g. firebase firestore:delete --recursive).' });
    });

    var doc = {
      _nativ: 'Preview Dev → ' + target + ' (Firestore). Nothing runs automatically.',
      _deploy: 'indexes + fieldOverrides: firebase deploy --only firestore:indexes; dataMigrations: apply with a script',
      indexes: indexes,
      fieldOverrides: fieldOverrides,
      dataMigrations: steps
    };
    if (warnings.length) doc.warnings = warnings;
    return { text: JSON.stringify(doc, null, 2) + '\n', lang: 'json', count: indexes.length + fieldOverrides.length + steps.length };
  }

  function generateSql(d) {
    var dialect = sqlDialect();
    var BT = String.fromCharCode(96);
    var q = function (name) {
      return dialect === 'mysql' ? BT + String(name).split(BT).join(BT + BT) + BT : '"' + String(name).split('"').join('""') + '"';
    };
    var colDef = function (c) { return q(c.name) + ' ' + c.type + (c.nullable ? '' : ' NOT NULL') + (c.default != null ? ' DEFAULT ' + c.default : ''); };
    var fkDef = function (f) { return 'CONSTRAINT ' + q(f.name) + ' FOREIGN KEY (' + q(f.column) + ') REFERENCES ' + q(f.referencedTable) + ' (' + q(f.referencedColumn) + ')' + (f.onDelete ? ' ON DELETE ' + f.onDelete : ''); };
    var idxDef = function (t, i) { return 'CREATE ' + (i.unique ? 'UNIQUE ' : '') + 'INDEX ' + q(i.name) + ' ON ' + q(t) + ' (' + i.columns.map(q).join(', ') + ');'; };
    var dropIdx = function (t, i) { return dialect === 'mysql' ? 'DROP INDEX ' + q(i.name) + ' ON ' + q(t) + ';' : 'DROP INDEX ' + q(i.name) + ';'; };
    var target = state.diffTargetUsed === 'contract' ? '.ai/db_schema.json' : 'Prod';
    var out = [
      '-- Nativ migration preview: Dev → ' + target + ' (' + (ENGINE_LABEL[dialect] || dialect) + ' dialect)',
      '-- Generated from structural metadata only. Review carefully; nothing is executed automatically.',
      ''
    ];

    d.addedTables.forEach(function (t) {
      var lines = t.columns.map(function (c) { return '  ' + colDef(c); });
      var pks = t.columns.filter(function (c) { return c.primaryKey; }).map(function (c) { return q(c.name); });
      if (pks.length) lines.push('  PRIMARY KEY (' + pks.join(', ') + ')');
      (t.foreignKeys || []).forEach(function (f) { lines.push('  ' + fkDef(f)); });
      out.push('-- [NEW TABLE] ' + t.name);
      out.push('CREATE TABLE ' + q(t.name) + ' (\n' + lines.join(',\n') + '\n);');
      (t.indexes || []).forEach(function (i) { out.push(idxDef(t.name, i)); });
      out.push('');
    });

    d.alteredTables.forEach(function (t) {
      var T = 'ALTER TABLE ' + q(t.name) + ' ';
      out.push('-- [ALTERED] ' + t.name + (t.isDestructive ? '  [DESTRUCTIVE]' : ''));
      t.droppedForeignKeys.forEach(function (f) {
        if (dialect === 'sqlite') out.push('-- SQLite cannot drop constraints in place; rebuild ' + t.name + ' to remove FK ' + f.name);
        else out.push(T + (dialect === 'mysql' ? 'DROP FOREIGN KEY ' : 'DROP CONSTRAINT ') + q(f.name) + ';');
      });
      t.droppedIndexes.forEach(function (i) { out.push(dropIdx(t.name, i)); });
      t.addedColumns.forEach(function (c) { out.push(T + 'ADD COLUMN ' + colDef(c) + ';'); });
      t.alteredColumns.forEach(function (ch) {
        var c = ch.after, f = ch.changedFields;
        if (dialect === 'mysql') { out.push(T + 'MODIFY COLUMN ' + colDef(c) + ';'); return; }
        if (dialect === 'sqlite') { out.push('-- SQLite cannot ALTER COLUMN ' + t.name + '.' + c.name + ' (' + f.join(', ') + '); a table rebuild is required.'); return; }
        if (f.indexOf('type') !== -1) out.push(T + 'ALTER COLUMN ' + q(c.name) + ' TYPE ' + c.type + ' USING ' + q(c.name) + '::' + c.type + ';');
        if (f.indexOf('nullable') !== -1) out.push(T + 'ALTER COLUMN ' + q(c.name) + (c.nullable ? ' DROP NOT NULL;' : ' SET NOT NULL;'));
        if (f.indexOf('default') !== -1) out.push(T + 'ALTER COLUMN ' + q(c.name) + (c.default == null ? ' DROP DEFAULT;' : ' SET DEFAULT ' + c.default + ';'));
        if (f.indexOf('primaryKey') !== -1) out.push('-- Primary key membership changed for ' + t.name + '.' + c.name + '; recreate the PRIMARY KEY constraint manually.');
      });
      t.droppedColumns.forEach(function (c) { out.push('-- [DESTRUCTIVE] drops column data'); out.push(T + 'DROP COLUMN ' + q(c.name) + ';'); });
      t.addedIndexes.forEach(function (i) { out.push(idxDef(t.name, i)); });
      t.addedForeignKeys.forEach(function (f) {
        if (dialect === 'sqlite') out.push('-- SQLite cannot add constraints in place; rebuild ' + t.name + ' to add FK ' + f.column + ' → ' + f.referencedTable);
        else out.push(T + 'ADD ' + fkDef(f) + ';');
      });
      out.push('');
    });

    d.droppedTables.forEach(function (t) {
      out.push('-- [DESTRUCTIVE: DROPPED] ' + t.name + ': permanently deletes the table and all rows');
      out.push('DROP TABLE ' + q(t.name) + ';');
      out.push('');
    });

    if (!d.addedTables.length && !d.alteredTables.length && !d.droppedTables.length) out.push('-- No schema drift. Nothing to migrate.');
    return out.join('\n').replace(/\n+$/, '\n');
  }

  function countStatements(text, lang) {
    if (!text) return 0;
    var comment = lang === 'js' ? /^\s*\/\// : /^\s*--/;
    return text.split('\n').filter(function (l) { return /;\s*$/.test(l) && !comment.test(l); }).length;
  }

  var JS_TOKEN = /(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*")|\b(db|getCollection|createCollection|createIndex|dropIndex|updateMany|drop|true|false|null)\b|(\$[A-Za-z]+)/g;
  var JSON_TOKEN = /("(?:[^"\\\n]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?)/g;

  function highlightScript(text, lang) {
    if (lang === 'sql') return highlightSql(text);
    var html = esc(text).replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    if (lang === 'js') {
      return html.replace(JS_TOKEN, function (m, comment, str, kw, op) {
        if (comment) return '<span class="' + (/DESTRUCTIVE/.test(comment) ? 'd' : 'c') + '">' + comment + '</span>';
        if (str) return '<span class="s">' + str + '</span>';
        if (kw) return '<span class="k">' + kw + '</span>';
        return '<span class="o">' + op + '</span>';
      });
    }
    return html.replace(JSON_TOKEN, function (m, str, colon, lit, num) {
      if (str) return colon ? '<span class="p">' + str + '</span>' + colon : '<span class="' + (/deleteField|deleteCollection/.test(str) ? 'd' : 's') + '">' + str + '</span>';
      if (lit) return '<span class="' + (lit === 'true' ? 'n' : 'k') + '">' + lit + '</span>';
      return '<span class="n">' + num + '</span>';
    });
  }

  var LANG_LABEL = { sql: 'SQL DDL', js: 'MongoDB Shell', json: 'Firestore Index JSON' };

  var SQL_TOKEN = /(--[^\n]*)|('(?:[^']|'')*')|\b(CREATE|TABLE|ALTER|ADD|DROP|COLUMN|CONSTRAINT|PRIMARY|FOREIGN|KEY|REFERENCES|ON|DELETE|INDEX|UNIQUE|NOT|NULL|DEFAULT|SET|TYPE|USING|MODIFY|CASCADE|RESTRICT|NO|ACTION)\b/g;

  function highlightSql(sql) {
    return esc(sql).replace(/&#39;/g, "'").replace(SQL_TOKEN, function (m, comment, str, kw) {
      if (comment) return '<span class="' + (/DESTRUCTIVE/.test(comment) ? 'd' : 'c') + '">' + comment + '</span>';
      if (str) return '<span class="s">' + str + '</span>';
      return '<span class="k">' + kw + '</span>';
    });
  }

  function renderSql() {
    if (!state.diff) return emptyState('No migration to preview', state.diffError || 'Connect Dev and Prod to generate a migration script.');
    var destructive = state.diff.summary.hasDestructiveChanges;
    var lang = state.scriptLang;
    var unit = lang === 'json' ? ' change(s)' : ' statement(s)';
    return '<div class="sql-wrap card"><div class="sql-head"><span class="muted"><span class="lang">' + LANG_LABEL[lang] + '</span>' +
      (destructive ? '<span class="badge badge-dropped">DESTRUCTIVE</span> ' : '') + state.scriptCount + unit + ' · read-only preview</span>' +
      '<span class="copy-wrap"><span class="tooltip">Copied!</span><button class="btn small" type="button" data-action="copy-sql">Copy ' +
      (lang === 'sql' ? 'SQL' : lang === 'js' ? 'Script' : 'JSON') + '</button></span></div>' +
      '<pre class="sql" tabindex="0" aria-label="Migration script (' + LANG_LABEL[lang] + ')"><code>' + highlightScript(state.sql, lang) + '</code></pre></div>';
  }

`;
