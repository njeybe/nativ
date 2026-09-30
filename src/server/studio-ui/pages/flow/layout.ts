// Plan layout: rounds, lanes, links and the highlight set. Pure, no DOM.
export const flowLayoutScript = String.raw`  var FLOW = { W: 206, H: 58, GX: 52, GY: 10, PAD: 14, LX: 128, TOP: 30 };

  function flowAgentKey(t) { return t.agent || 'unassigned'; }

  function flowGraph(m) {
    var ids = {};
    m.tasks.forEach(function (t) { ids[t.id] = t; });
    var depsIn = function (id) {
      return ids[id].deps.filter(function (d) { return ids[d] && d !== id; });
    };
    var depth = {}, anc = {};
    function getD(id, seen) {
      if (depth[id] != null) return depth[id];
      if (seen[id]) return 0;
      seen[id] = true;
      var d = 0;
      depsIn(id).forEach(function (p) { d = Math.max(d, 1 + getD(p, seen)); });
      delete seen[id];
      depth[id] = d;
      return d;
    }
    function getA(id, seen) {
      if (anc[id]) return anc[id];
      if (seen[id]) return {};
      seen[id] = true;
      var out = {};
      depsIn(id).forEach(function (p) {
        out[p] = true;
        var up = getA(p, seen);
        Object.keys(up).forEach(function (k) { out[k] = true; });
      });
      delete seen[id];
      anc[id] = out;
      return out;
    }
    m.tasks.forEach(function (t) { getD(t.id, {}); getA(t.id, {}); });
    var edges = [], kids = {};
    m.tasks.forEach(function (t) {
      depsIn(t.id).forEach(function (d) {
        var implied = depsIn(t.id).some(function (e) { return e !== d && getA(e, {})[d]; });
        edges.push({ from: d, to: t.id, implied: implied });
        (kids[d] = kids[d] || []).push(t.id);
      });
    });
    return { depth: depth, anc: function (id) { return getA(id, {}); }, edges: edges, kids: kids };
  }

  function flowPlace(m, g) {
    var lanes = [], cells = {};
    m.tasks.forEach(function (t) {
      var a = flowAgentKey(t);
      if (lanes.indexOf(a) === -1) lanes.push(a);
      var k = a + '|' + g.depth[t.id];
      (cells[k] = cells[k] || []).push(t);
    });
    var rounds = Math.max.apply(null, m.tasks.map(function (t) { return g.depth[t.id]; })) + 1;
    var laneY = {}, laneH = {}, y = FLOW.TOP;
    lanes.forEach(function (l) {
      var stack = 1;
      for (var r = 0; r < rounds; r++) stack = Math.max(stack, (cells[l + '|' + r] || []).length);
      laneY[l] = y;
      laneH[l] = FLOW.PAD * 2 + stack * FLOW.H + (stack - 1) * FLOW.GY;
      y += laneH[l];
    });
    var pos = {};
    Object.keys(cells).forEach(function (k) {
      var bits = k.split('|'), r = Number(bits[1]);
      cells[k].forEach(function (t, i) {
        pos[t.id] = { x: FLOW.LX + 20 + r * (FLOW.W + FLOW.GX), y: laneY[bits[0]] + FLOW.PAD + i * (FLOW.H + FLOW.GY), round: r + 1 };
      });
    });
    return { lanes: lanes, laneY: laneY, laneH: laneH, pos: pos, rounds: rounds,
      width: FLOW.LX + 20 + rounds * (FLOW.W + FLOW.GX), height: y };
  }

  /** Everything the Plan view draws for one milestone. */
  function flowLayout(m) {
    var g = flowGraph(m);
    var L = flowPlace(m, g);
    L.edges = g.edges;
    L.kids = g.kids;
    L.anc = g.anc;
    L.hidden = g.edges.filter(function (e) { return e.implied; }).length;
    return L;
  }

  /** The task, everything it needs and everything it unblocks, or null when it is not drawn. */
  function flowFocusSet(L, id) {
    if (!id || !L.pos[id]) return null;
    var hot = {}, down = {}, stack = [id];
    hot[id] = true;
    Object.keys(L.anc(id)).forEach(function (k) { hot[k] = true; });
    while (stack.length) {
      (L.kids[stack.pop()] || []).forEach(function (c) {
        if (down[c]) return;
        down[c] = true;
        hot[c] = true;
        stack.push(c);
      });
    }
    return hot;
  }

`;
