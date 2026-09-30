// Plan view: swimlanes per agent, one column per round, bezier links inside the milestone.
export const flowPlanScript = String.raw`  function flowWires(L, hot, showAll) {
    return L.edges.filter(function (e) { return showAll || !e.implied; }).map(function (e) {
      var a = L.pos[e.from], b = L.pos[e.to];
      var x1 = a.x + FLOW.W, y1 = a.y + FLOW.H / 2, x2 = b.x, y2 = b.y + FLOW.H / 2;
      var dx = Math.max(28, (x2 - x1) / 2);
      var on = hot && hot[e.from] && hot[e.to];
      return '<path class="wire' + (on ? ' hot' : '') + (e.implied ? ' implied' : '') + '" data-from="' + ui.esc(e.from) +
        '" data-to="' + ui.esc(e.to) + '" d="M' + x1 + ' ' + y1 + ' C' + (x1 + dx) + ' ' + y1 + ', ' + (x2 - dx) + ' ' + y2 + ', ' + x2 + ' ' + y2 + '"/>';
    }).join('');
  }

  function flowBands(m, L) {
    return L.lanes.map(function (l) {
      var count = m.tasks.filter(function (t) { return flowAgentKey(t) === l; }).length;
      return '<div class="lane-band" data-lane="' + ui.esc(l) + '" style="top:' + L.laneY[l] + 'px;height:' + L.laneH[l] + 'px">' +
        '<div class="lane-label">' + ui.agentChip(l === 'unassigned' ? null : l) + '<span class="faint">' + count + (count === 1 ? ' task' : ' tasks') + '</span></div></div>';
    }).join('');
  }

  function flowRoundHeads(L) {
    var out = '';
    for (var r = 0; r < L.rounds; r++) {
      out += '<div class="round-head" style="left:' + (FLOW.LX + 20 + r * (FLOW.W + FLOW.GX)) + 'px">Round ' + (r + 1) + '</div>';
    }
    return out;
  }

  function flowNodeTime(t) {
    if (t.status === 'in_progress' && t.startT) return '<span data-since="' + t.startT + '">' + ui.esc(fmt.dur(Studio.now() - t.startT)) + '</span>';
    return t.durationMs ? ui.esc(fmt.dur(t.durationMs)) : '';
  }

  function flowNodes(m, L, hot, focusId) {
    return m.tasks.map(function (t) {
      var p = L.pos[t.id];
      var cls = 'node ' + t.status + (hot && hot[t.id] ? ' hot' : '') + (focusId === t.id ? ' sel' : '');
      return '<button type="button" class="' + ui.esc(cls) + '" data-act="flow-focus" data-key="' + ui.esc(t.id) + '" data-id="' + ui.esc(t.id) +
        '" data-round="' + p.round + '" aria-pressed="' + (focusId === t.id) + '" title="' + ui.esc(t.title) + '" style="left:' + p.x + 'px;top:' + p.y +
        'px;width:' + FLOW.W + 'px;height:' + FLOW.H + 'px"><div class="l1">' + ui.statusIcon(t.status) + '<span class="mono faint">' + ui.esc(t.id) +
        '</span><span class="d">' + flowNodeTime(t) + '</span></div><div class="title">' + ui.esc(t.title) + '</div></button>';
    }).join('');
  }

  function flowLegend() {
    var one = function (s) { return '<span>' + ui.statusIcon(s) + Studio.statusLabel(s) + '</span>'; };
    return '<div class="legend">' + ['completed', 'in_progress', 'pending', 'blocked'].map(one).join('') + '</div>';
  }

  function flowPlanTools(L, hot, view) {
    var hint = hot ? '<button type="button" class="btn ghost" data-act="flow-clear">Clear highlight</button>'
      : '<span>Click a task to light up what it needs and what it unblocks</span>';
    var implied = L.hidden ? '<label class="check"><input type="checkbox" data-act="flow-implied"' + (view.implied ? ' checked' : '') +
      '> Show ' + L.hidden + ' implied link' + (L.hidden > 1 ? 's' : '') + '</label>' : '';
    return '<div class="fl-bar">' + flowLegend() + '<span class="right">' + hint + implied + '</span></div>';
  }

  function flowPlan(m, focusId, view) {
    var L = flowLayout(m);
    var hot = flowFocusSet(L, focusId);
    return '<section class="fl-panel" data-mode="plan">' + flowPlanTools(L, hot, view) +
      '<div class="flow-wrap"><div class="canvas' + (hot ? ' focus' : '') + '" style="width:' + L.width + 'px;height:' + (L.height + 10) + 'px">' +
      flowBands(m, L) + flowRoundHeads(L) + '<svg class="wires" width="' + L.width + '" height="' + L.height + '">' +
      flowWires(L, hot, view.implied) + '</svg>' + flowNodes(m, L, hot, hot ? focusId : null) + '</div></div></section>';
  }

`;
