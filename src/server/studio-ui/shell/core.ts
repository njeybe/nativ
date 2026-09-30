// Script opening, DOM lookup, fetch helpers and the icons used by the kept tools.
export const coreScript = String.raw`<script>
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var ICON = {
    spark: '<svg class="icon t1-spark" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5l1.6 4.9 4.9 1.6-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z"/></svg>',
    check: '<svg class="icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>',
    x: '<svg class="icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
    shield: '<svg class="icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.8l5.2 2.1v3.7c0 3.1-2.2 5.6-5.2 6.6-3-1-5.2-3.5-5.2-6.6V3.9z"/><path d="M5.6 8.1l1.7 1.7 3.2-3.3"/></svg>',
    play: '<svg class="icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.5 2.8v10.4L13 8z"/></svg>',
    alert: '<svg class="icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg>',
    branch: '<svg class="icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-11.2 7.4"/></svg>',
    gauge: '<svg class="icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 16a8 8 0 1 1 16 0"/><path d="M12 16l4-5"/></svg>'
  };

  function formatBytes(n) {
    if (n == null) return 'unknown';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  function api(path, options) {
    return fetch(path, options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        // DB routes answer { error: { code, message } }; pipeline routes answer { ok: false, error: "..." }.
        if (!res.ok || body.ok === false) {
          var message = typeof body.error === 'string' ? body.error : (body.error && body.error.message) || body.message;
          var err = new Error(message || ('Request failed (' + res.status + ')'));
          err.code = (body.error && body.error.code) || body.code;
          err.status = res.status;
          throw err;
        }
        return body;
      });
    });
  }

  function postJson(path, body) {
    return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  function openDialog(dlg) {
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }

`;
