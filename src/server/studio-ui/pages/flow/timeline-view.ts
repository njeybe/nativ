// What happened view: SVG bars from real times, squeezed pauses, summary figures.
export const flowTimelineScript = String.raw`  function flowStat(k, v, s) {
    return '<div><span class="k">' + k + '</span><span class="v">' + v + '</span><span class="s">' + s + '</span></div>';
  }

  function flowStats(s) {
    return '<div class="stats">' +
      flowStat('Start to finish', ui.esc(fmt.dur(s.span)), ui.esc(fmt.day(s.start) + ', ' + fmt.clock(s.start))) +
      flowStat('Agents busy', s.busyPct + '%', ui.esc(fmt.dur(s.busyMs)) + ' of work time') +
      flowStat('Most at once', s.peak, s.peak > 1 ? 'tasks ran side by side' : 'tasks ran one at a time') +
      flowStat('Longest pause', s.longest ? ui.esc(fmt.dur(s.longest)) : 'none', s.longestAt ? 'from ' + ui.esc(fmt.clock(s.longestAt)) : 'no idle stretch') +
      '</div>';
  }

  function flowTicks(tm) {
    var sg = tm.sg, top = TL.TOPY - 6, out = '';
    var nice = [1, 2, 5, 10, 15, 30, 60, 120, 240].map(function (v) { return v * 60000; });
    var step = nice.filter(function (v) { return v * sg.k >= 80; })[0] || nice[nice.length - 1];
    sg.segs.filter(function (s) { return !s.gap; }).forEach(function (s) {
      out += '<line class="grid" x1="' + s.x0 + '" x2="' + s.x0 + '" y1="' + top + '" y2="' + tm.height + '"/><text x="' + (s.x0 + 3) + '" y="14">' + ui.esc(fmt.clock(s.t0)) + '</text>';
      for (var t = Math.ceil(s.t0 / step) * step; t < s.t1; t += step) {
        var tx = sg.X(t);
        if (tx - s.x0 > 44) out += '<line class="grid" x1="' + tx + '" x2="' + tx + '" y1="' + top + '" y2="' + tm.height + '"/><text x="' + (tx + 3) + '" y="14">' + ui.esc(fmt.clock(t)) + '</text>';
      }
    });
    return out;
  }

  function flowGaps(tm) {
    var top = TL.TOPY - 6;
    return tm.sg.segs.filter(function (s) { return s.gap; }).map(function (s) {
      var mid = s.x0 + TL.GW / 2;
      return '<g class="gap-g" data-gap="' + (s.t1 - s.t0) + '"><rect class="gap" x="' + s.x0 + '" y="' + top + '" width="' + TL.GW + '" height="' + (tm.height - top) +
        '"/><line class="gap-line" x1="' + mid + '" x2="' + mid + '" y1="' + top + '" y2="' + tm.height + '"/><text x="' + mid + '" y="26" text-anchor="middle">+' +
        ui.esc(fmt.dur(s.t1 - s.t0).split(' ')[0]) + '</text></g>';
    }).join('');
  }

  function flowLaneBands(tm) {
    return tm.lanes.map(function (l, i) {
      return (i % 2 ? '<rect class="band" x="0" y="' + l.y + '" width="' + tm.width + '" height="' + l.h + '"/>' : '') +
        '<line class="grid" x1="0" x2="' + tm.width + '" y1="' + l.y + '" y2="' + l.y + '"/><text class="lane-t" x="12" y="' + (l.y + 20) + '">' +
        ui.esc(Studio.agentInfo(l.key === 'unassigned' ? null : l.key).label) + '</text>';
    }).join('');
  }

  function flowBar(t, lane, tm) {
    var X = tm.sg.X;
    var x1 = X(t.startT), x2 = Math.max(X(flowEnd(t, tm.now)), x1 + 4), w = x2 - x1;
    var row = lane.place[t.id], by = lane.y + 6 + row * TL.ROWH;
    var cw = t.checkMs && t.status === 'completed' ? Math.min(w, t.checkMs * tm.sg.k) : 0;
    var lx = w > 64 ? x1 + 6 : x2 + 4;
    var took = (t.status === 'in_progress' ? 'running' : 'took ' + fmt.dur(t.durationMs)) + (t.checkMs ? ', check ' + fmt.dur(t.checkMs) : '');
    var tip = ui.esc(t.id + ' · ' + t.title) + '&#10;' + ui.esc(took);
    return '<g><rect class="bar-w ' + ui.esc(t.status) + '" data-task="' + ui.esc(t.id) + '" data-row="' + row + '" x="' + x1 + '" y="' + by +
      '" width="' + w + '" height="21" rx="4"><title>' + tip + '</title></rect>' +
      (cw > 1 ? '<rect class="bar-c" x="' + (x2 - cw) + '" y="' + (by + 17) + '" width="' + cw + '" height="4" rx="1"/>' : '') +
      '<text class="bar-l" x="' + lx + '" y="' + (by + 15) + '">' + ui.esc(t.id) + '</text></g>';
  }

  function flowLegendTl() {
    return '<div class="legend"><span><svg width="22" height="10"><rect x="0" y="0" width="22" height="10" rx="3" fill="color-mix(in srgb, var(--ok) 30%, var(--surface))" stroke="var(--ok)"/></svg>Work</span>' +
      '<span><svg width="22" height="10"><rect x="0" y="6" width="22" height="4" rx="1" fill="var(--ok)"/></svg>Check at the end</span>' +
      '<span><svg width="16" height="12"><rect x="0" y="0" width="16" height="12" fill="var(--surface-2)"/><line x1="8" x2="8" y1="0" y2="12" stroke="var(--line-2)" stroke-dasharray="2 2"/></svg>Long pause, squeezed</span></div>';
  }

  function flowUntimed(list) {
    if (!list.length) return '';
    return '<div class="fl-untimed">Not on the timeline: ' + list.map(function (t) {
      return '<button type="button" class="mono" data-task="' + ui.esc(t.id) + '">' + ui.esc(t.id) + '</button> (' + ui.esc(Studio.statusLabel(t.status).toLowerCase()) + ')';
    }).join(', ') + '</div>';
  }

  function flowTimeline(m, ctx) {
    var tm = flowTimeModel(m, Studio.now(), ctx.width);
    if (!tm) {
      return '<section class="fl-panel" data-mode="timeline">' + ui.empty('No timing recorded for ' + m.id,
        'These tasks ran before Studio started recording start and finish times. The Plan view still shows how they connect.') + '</section>';
    }
    var nowLine = tm.timed.some(function (t) { return t.status === 'in_progress'; })
      ? '<line class="now-line" x1="' + tm.sg.X(tm.now) + '" x2="' + tm.sg.X(tm.now) + '" y1="' + (TL.TOPY - 6) + '" y2="' + tm.height + '"/>' : '';
    var bars = tm.lanes.map(function (l) {
      return l.tasks.map(function (t) { return flowBar(t, l, tm); }).join('');
    }).join('');
    return '<section class="fl-panel" data-mode="timeline">' + flowStats(tm.sum) +
      '<div class="fl-bar">' + flowLegendTl() + '<span class="right">Click a bar for details</span></div>' +
      '<div class="flow-wrap"><svg class="tl" width="' + tm.width + '" height="' + tm.height + '" viewBox="0 0 ' + tm.width + ' ' + tm.height + '">' +
      '<defs><pattern id="fl-stripes" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect class="stripe-a" width="8" height="8"/><rect class="stripe-b" width="4" height="8"/></pattern></defs>' +
      flowLaneBands(tm) + flowGaps(tm) + flowTicks(tm) + nowLine + bars + '</svg></div>' + flowUntimed(tm.untimed) + '</section>';
  }

`;
