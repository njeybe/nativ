// Pure command palette logic: what a query finds and how the list is drawn.
export const paletteViewScript = String.raw`  // ─── Command palette (pure) ─────────────────────────────────────────────────
  var PALETTE_MAX = 9;

  function taskHaystack(t) {
    var info = agentInfo(t.agent);
    return [t.id, t.title, t.agent || '', info.label].concat(t.files).join(' ').toLowerCase();
  }

  function emptyQueryTasks(model) {
    var done = model.tasks.filter(function (t) { return t.status === 'completed'; });
    var timed = done.filter(function (t) { return t.endT; }).sort(function (a, b) { return b.endT - a.endT; });
    var rest = done.filter(function (t) { return !t.endT; }).reverse();
    return model.running.concat(model.stuck, timed, rest);
  }

  function matchRank(t, q) {
    var id = t.id.toLowerCase();
    return id === q ? 0 : id.indexOf(q) === 0 ? 1 : 2;
  }

  /** Pages first ("Go to Flow"), then tasks matching id, title, agent id, agent label or any file. */
  Studio.paletteItems = function (query) {
    var model = Studio.model;
    var q = String(query || '').replace(/^\s+|\s+$/g, '').toLowerCase();
    var pages = q ? Studio.order.filter(function (p) { return p.label.toLowerCase().indexOf(q) !== -1; })
      .map(function (p) { return { page: p }; }) : [];
    var tasks = [];
    if (model) {
      tasks = q ? model.tasks.filter(function (t) { return taskHaystack(t).indexOf(q) !== -1; })
        .sort(function (a, b) { return matchRank(a, q) - matchRank(b, q); }) : emptyQueryTasks(model);
    }
    return pages.concat(tasks.map(function (t) { return { task: t }; })).slice(0, PALETTE_MAX);
  };

  Studio.paletteFrame = function () {
    return '<div class="pal" role="dialog" aria-label="Find a task" aria-modal="true">' +
      '<input id="pal-q" type="text" placeholder="Search by task id, title, agent or file" autocomplete="off" ' +
      'role="combobox" aria-expanded="true" aria-controls="pal-list" aria-label="Find a task">' +
      '<ul id="pal-list" role="listbox"></ul>' +
      '<div class="hint"><span>Up and down to move</span><span>Enter to open</span><span>Esc to close</span></div></div>';
  };

  /** Rows for the listbox; sel is the highlighted index. */
  Studio.paletteListHtml = function (items, sel, query) {
    if (!items.length) {
      return '<li class="faint pal-none">No task matches. Try an id like task-31 or a file name.</li>';
    }
    return items.map(function (it, i) {
      var on = ' role="option" id="pal-opt-' + i + '" data-i="' + i + '" aria-selected="' + (i === sel) + '">';
      if (it.page) {
        return '<li' + on + '<span class="pal-ico">' + ui.svg(it.page.icon) + '</span><span class="t">Go to ' + esc(it.page.label) + '</span></li>';
      }
      var t = it.task;
      return '<li' + on + ui.statusIcon(t.status) + '<span class="mono faint hide-sm">' + esc(t.id) + '</span>' +
        '<span class="t">' + esc(t.title) + '</span><span class="hide-sm">' + ui.agentChip(t.agent) + '</span></li>';
    }).join('');
  };

`;
