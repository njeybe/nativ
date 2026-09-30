// Toasts and formatting helpers.
export const toastsFormatScript = String.raw`  // ─── Toasts ────────────────────────────────────────────────────────────────
  function hintFor(message) {
    var m = String(message || '');
    if (/ECONNREFUSED|ETIMEDOUT|timeout|EHOSTUNREACH/i.test(m)) return 'Check that the database server is running and the host/port are reachable from this machine.';
    if (/ENOTFOUND|getaddrinfo/i.test(m)) return 'The hostname could not be resolved. Verify the host in your connection string.';
    if (/password|authentication|access denied/i.test(m)) return 'Credentials were rejected. Re-enter the connection string in Connection Settings.';
    if (/unable to open database file/i.test(m)) return 'The SQLite file was not found. Check the path relative to where nativ was started.';
    if (/not configured|NOT_CONNECTED/i.test(m)) return 'Open Connection Settings to connect a database.';
    if (/default credentials|UNAUTHENTICATED|PERMISSION_DENIED/i.test(m)) return 'For Firestore, run "gcloud auth application-default login" or connect to the emulator instead.';
    if (/Server selection timed out|MongoServerSelectionError/i.test(m)) return 'MongoDB did not respond. Check the host, port, and network access list.';
    return '';
  }

  function toast(message, kind) {
    var el = document.createElement('div');
    el.className = 'toast' + (kind === 'ok' ? ' ok' : '');
    var hint = kind === 'ok' ? '' : hintFor(message);
    el.innerHTML = '<div class="t-body"><div>' + esc(message) + '</div>' + (hint ? '<div class="t-hint">' + esc(hint) + '</div>' : '') +
      '</div><button type="button" aria-label="Dismiss">×</button>';
    el.querySelector('button').addEventListener('click', function () { el.remove(); });
    $('toasts').appendChild(el);
    setTimeout(function () { el.remove(); }, kind === 'ok' ? 3500 : 8000);
  }

  function flashCopied(button) {
    var wrap = button.parentElement;
    var tip = wrap && wrap.querySelector('.tooltip');
    if (!tip) return;
    tip.classList.add('show');
    setTimeout(function () { tip.classList.remove('show'); }, 1200);
  }

  function copyText(text, button) {
    var done = function () { flashCopied(button); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    ta.remove();
  }

  // ─── Formatting ────────────────────────────────────────────────────────────
  function num(n) {
    if (n == null || n === '' || isNaN(n)) return '–';
    return Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 });
  }
  function usd(n) {
    if (n == null || isNaN(n)) return '–';
    n = Number(n);
    return '$' + (n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3));
  }
  function fmtMs(ms) {
    if (ms == null || isNaN(ms)) return '–';
    if (ms < 1000) return Math.round(ms) + ' ms';
    if (ms < 60000) return (ms / 1000).toFixed(2) + ' s';
    return Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
  }
  function clampPct(v) { return Math.max(0, Math.min(100, Math.round(Number(v) || 0))); }
  /** Telemetry stores the gatekeeper pass rate as a 0..1 ratio; tolerate a 0..100 percentage too. */
  function passRatePct(v) {
    if (v == null || isNaN(v)) return null;
    return clampPct(v <= 1 ? v * 100 : v);
  }
  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    try { return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return d.toLocaleString(); }
  }
  function humanize(key) {
    var words = String(key).replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
    words = words.replace(/ ms$/, ' (ms)').replace(/ usd$/, ' (USD)');
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  function detailValue(v) {
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (typeof v === 'number') return num(v);
    if (Array.isArray(v)) return v.map(String).join(', ');
    if (v && typeof v === 'object') return JSON.stringify(v);
    return String(v == null ? '–' : v);
  }

`;
