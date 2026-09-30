// Command palette: Ctrl+K / Cmd+K / "/" to open, arrows and Enter to pick, Esc to close.
export const paletteScript = String.raw`  // ─── Command palette ───────────────────────────────────────────────────────
  var pal = { open: false, sel: 0, items: [], opener: null };

  function drawPalette() {
    var q = $('pal-q');
    pal.items = Studio.paletteItems(q ? q.value : '');
    if (pal.sel >= pal.items.length) pal.sel = 0;
    $('pal-list').innerHTML = Studio.paletteListHtml(pal.items, pal.sel);
    if (q) q.setAttribute('aria-activedescendant', pal.items.length ? 'pal-opt-' + pal.sel : '');
    var cur = $('pal-opt-' + pal.sel);
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }

  function openPalette() {
    if (pal.open) return;
    pal.open = true;
    pal.sel = 0;
    pal.opener = document.activeElement;
    $('pal').innerHTML = Studio.paletteFrame();
    $('pal').hidden = false;
    drawPalette();
    $('pal-q').focus();
  }

  function closePalette() {
    if (!pal.open) return;
    pal.open = false;
    $('pal').hidden = true;
    $('pal').innerHTML = '';
    if (pal.opener && document.body.contains(pal.opener) && pal.opener.focus) pal.opener.focus();
  }

  function refreshPalette() { if (pal.open) drawPalette(); }

  function pickPalette(i) {
    var it = pal.items[i];
    if (!it) return;
    pal.opener = null;
    closePalette();
    if (it.page) { Studio.go(it.page.id); return; }
    Studio.state.milestoneId = it.task.milestoneId;
    openDetail(it.task.id);
    repaintFor(null);
  }

  $('btn-find').addEventListener('click', openPalette);
  $('pal').addEventListener('click', function (e) {
    var li = e.target.closest('li[data-i]');
    if (li) { pickPalette(Number(li.getAttribute('data-i'))); return; }
    if (e.target.id === 'pal') closePalette();
  });
  $('pal').addEventListener('input', function () { pal.sel = 0; drawPalette(); });

  function typingInField() {
    var a = document.activeElement;
    return !!a && /^(input|select|textarea)$/i.test(a.tagName);
  }

  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'k') {
      e.preventDefault();
      if (pal.open) closePalette(); else openPalette();
      return;
    }
    if (e.key === '/' && !pal.open && !typingInField() && !e.ctrlKey && !e.metaKey) { e.preventDefault(); openPalette(); return; }
    if (pal.open) {
      var n = Math.max(1, pal.items.length);
      if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        pal.sel = (pal.sel + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
        drawPalette();
      } else if (e.key === 'Enter') { e.preventDefault(); pickPalette(pal.sel); }
      return;
    }
    if (e.key === 'Escape' && Studio.state.detailTaskId && !document.querySelector('dialog[open]')) closeDetail(false);
  });

`;
