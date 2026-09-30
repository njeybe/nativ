// Timeline numbers: bar times, squeezed idle gaps, agent rows and summary figures. Pure.
export const flowTimeModelScript = String.raw`  var TL = { GAP: 15 * 60000, MIN_BAR: 15000, LW: 130, GW: 40, ROWH: 30, TOPY: 30 };

  function flowEnd(t, now) {
    if (t.status === 'in_progress') return Math.max(now, t.startT + 1000);
    if (t.endT && t.endT > t.startT) return t.endT;
    return t.startT + (t.durationMs || TL.MIN_BAR);
  }

  /** Merges sorted [start, end] pairs; touching within slack counts as one stretch. */
  function flowMerge(iv, slack) {
    var out = [];
    iv.forEach(function (p) {
      var last = out[out.length - 1];
      if (last && p[0] - last[1] <= slack) last[1] = Math.max(last[1], p[1]);
      else out.push([p[0], p[1]]);
    });
    return out;
  }

  function flowSummary(timed, now) {
    var iv = timed.map(function (t) { return [t.startT, flowEnd(t, now)]; }).sort(function (a, b) { return a[0] - b[0]; });
    var busy = flowMerge(iv, 0);
    var busyMs = busy.reduce(function (s, p) { return s + p[1] - p[0]; }, 0);
    var last = Math.max.apply(null, iv.map(function (p) { return p[1]; }));
    var span = last - iv[0][0];
    var longest = 0, at = null;
    for (var i = 1; i < busy.length; i++) {
      var g = busy[i][0] - busy[i - 1][1];
      if (g > longest) { longest = g; at = busy[i - 1][1]; }
    }
    var peak = 0;
    iv.forEach(function (p) {
      var c = iv.filter(function (o) { return o[0] <= p[0] && o[1] > p[0]; }).length;
      peak = Math.max(peak, c);
    });
    return { iv: iv, start: iv[0][0], span: span, busyMs: busyMs, busyPct: Math.round(busyMs / (span || 1) * 100),
      peak: peak, longest: longest, longestAt: at };
  }

  /** Time segments left to right: real stretches plus fixed-width bands for idle gaps over 15 minutes. */
  function flowSegments(iv, width) {
    var merged = flowMerge(iv, TL.GAP);
    var plotW = width - TL.LW - 24 - (merged.length - 1) * TL.GW;
    var active = merged.reduce(function (s, p) { return s + p[1] - p[0]; }, 0) || 1;
    var k = Math.max(plotW, 120) / active, segs = [], x = TL.LW;
    merged.forEach(function (p, i) {
      if (i) {
        segs.push({ gap: true, t0: merged[i - 1][1], t1: p[0], x0: x, x1: x + TL.GW });
        x += TL.GW;
      }
      segs.push({ t0: p[0], t1: p[1], x0: x, x1: x + (p[1] - p[0]) * k });
      x += (p[1] - p[0]) * k;
    });
    var X = function (t) {
      var s = segs.filter(function (q) { return t >= q.t0 && t <= q.t1; })[0] || (t < segs[0].t0 ? segs[0] : segs[segs.length - 1]);
      var scale = s.gap ? TL.GW / (s.t1 - s.t0) : k;
      return s.x0 + Math.max(0, Math.min(t, s.t1) - s.t0) * scale;
    };
    return { segs: segs, k: k, X: X, right: x };
  }

  /** Overlapping tasks of one agent go on extra rows. */
  function flowRows(list, now) {
    var rows = [], place = {};
    list.slice().sort(function (a, b) { return a.startT - b.startT; }).forEach(function (t) {
      var r = 0;
      while (r < rows.length && rows[r] > t.startT) r++;
      rows[r] = flowEnd(t, now);
      place[t.id] = r;
    });
    return { count: Math.max(1, rows.length), place: place };
  }

  function flowTimeModel(m, now, outer) {
    var timed = m.tasks.filter(function (t) { return t.startT; });
    if (!timed.length) return null;
    var sum = flowSummary(timed, now);
    var width = Math.max(760, (outer || 1000) - 2);
    var sg = flowSegments(sum.iv, width);
    var lanes = [], y = TL.TOPY;
    m.tasks.forEach(function (t) {
      var a = flowAgentKey(t);
      if (lanes.some(function (l) { return l.key === a; })) return;
      var list = timed.filter(function (o) { return flowAgentKey(o) === a; });
      if (!list.length) return;
      var rows = flowRows(list, now);
      lanes.push({ key: a, y: y, h: rows.count * TL.ROWH + 12, place: rows.place, tasks: list });
      y += rows.count * TL.ROWH + 12;
    });
    return { timed: timed, untimed: m.tasks.filter(function (t) { return !t.startT; }), sum: sum, sg: sg,
      lanes: lanes, width: width, height: y + 8, now: now };
  }

`;
