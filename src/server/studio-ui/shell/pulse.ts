// Pulse strip: active milestone plus running, blocked and decision counts under the header.
export const pulseScript = String.raw`  // ─── Pulse strip ───────────────────────────────────────────────────────────
  /** Pure: turns raw counts into the strip's parts. in = { loaded, offline, ms, running, blocked, decisions }. */
  function pulseParts(s) {
    if (s.offline) return { kind: 'offline', text: 'Offline, retrying' };
    if (!s.loaded) return { kind: 'loading', text: '-- -- -- --' };
    var counts = [
      { key: 'running', label: 'running', n: s.running, tone: 'run' },
      { key: 'stuck', label: 'stuck', n: s.blocked, tone: 'bad' },
      { key: 'decisions', label: s.decisions === 1 ? 'decision' : 'decisions', n: s.decisions, tone: 'warn' }
    ];
    counts = counts.filter(function (c) { return c.n > 0; });
    counts.forEach(function (c) { c.zero = false; });
    return { kind: 'ready', ms: s.ms, counts: counts };
  }

  function pulseHtml(p) {
    if (p.kind !== 'ready') {
      return '<span class="pulse-note ' + p.kind + '">' + esc(p.text) + '</span>';
    }
    if (!p.counts.length) return '';
    var out = '<span class="pulse-ms num">' + esc(p.ms) + '</span>';
    p.counts.forEach(function (c) {
      out += '<button type="button" class="pulse-item ' + c.tone + '" data-pulse="' + c.key + '">' +
        '<span class="num">' + c.n + '</span> ' + c.label + '</button>';
    });
    return out;
  }

  function pulseInput() {
    var m = Studio.model;
    var ms = null;
    if (m) m.milestones.forEach(function (x) { if (x.id === m.activeMilestoneId) ms = x; });
    // Same source as the Home decision queue, so the two counts agree.
    var decisions = m && m.needsYou ? m.needsYou : [];
    return {
      loaded: !!(m && pipe.loaded.tasks),
      offline: live.mode === 'offline',
      ms: ms ? ms.id + ' ' + ms.done + '/' + ms.total : '',
      running: m ? m.running.length : 0,
      blocked: m ? m.stuck.length : 0,
      decisions: decisions.length
    };
  }

  var pulseEl = $('pulse');
  function paintPulse() {
    if (!pulseEl) return;
    var html = pulseHtml(pulseParts(pulseInput()));
    if (pulseEl.__html === html) return;
    pulseEl.innerHTML = html;
    pulseEl.hidden = !html;
    pulseEl.__html = html;
  }

  // Studio.taskFilter ('running' or 'stuck') is read by the Tasks page when it opens.
  if (pulseEl) pulseEl.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-pulse]') : null;
    if (!b) return;
    var key = b.getAttribute('data-pulse');
    if (key === 'decisions') { location.hash = '#home'; return; }
    Studio.taskFilter = key;
    location.hash = '#tasks';
  });
  Studio.onPaint(paintPulse);
  paintPulse();

`;
