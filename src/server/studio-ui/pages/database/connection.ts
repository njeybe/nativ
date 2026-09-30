// Database Studio connection modal.
export const databaseConnectionScript = String.raw`  // ─── Database Studio: connection modal ─────────────────────────────────────
  function renderModalStatus() {
    ['dev', 'prod'].forEach(function (env) {
      var s = state.status && state.status[env];
      $('mdot-' + env).className = 'dot ' + (s && s.connected ? 'on' : 'off');
      $('current-' + env).innerHTML = s && s.maskedUrl
        ? 'Current: <code>' + esc(s.maskedUrl) + '</code><span class="copy-wrap"><span class="tooltip">Copied!</span><button class="btn small" type="button" data-copy-masked="' + env + '">Copy</button></span>'
        : 'Current: <span class="muted">not configured</span>';
    });
  }

  function renderTemplateChips() {
    var host = $('conn-template-chips');
    if (!host) return;
    if (!state.envInfo || !state.envInfo.templateFound || !state.envInfo.detectedKeys || state.envInfo.detectedKeys.length === 0) {
      host.innerHTML = '';
      host.hidden = true;
      return;
    }
    var html = '<div class="template-helper-box">' +
      '<div class="template-helper-label">Discovered in <code>' + esc(state.envInfo.templateFile || '.env.example') + '</code>:</div>' +
      '<div class="template-chips">';
    state.envInfo.detectedKeys.forEach(function (dk) {
      var eng = dk.engine ? ' (' + (ENGINE_LABEL[dk.engine] || dk.engine) + ')' : '';
      var statusDot = dk.isConfiguredInEnv ? '<span class="chip-dot on"></span>' : '<span class="chip-dot off"></span>';
      var title = dk.isConfiguredInEnv ? 'Configured in .env' : 'Missing in .env';
      html += '<button type="button" class="btn small template-chip" data-template-key="' + esc(dk.key) + '" data-template-engine="' + esc(dk.engine || '') + '" data-template-env="' + esc(dk.targetEnv) + '" title="' + title + '">' +
        statusDot + esc(dk.key) + eng +
      '</button>';
    });
    html += '</div></div>';
    host.innerHTML = html;
    host.hidden = false;

    host.querySelectorAll('.template-chip').forEach(function (btn) {
      btn.onclick = function () {
        var key = btn.getAttribute('data-template-key');
        var eng = btn.getAttribute('data-template-engine');
        var targetEnv = btn.getAttribute('data-template-env') || 'dev';
        // Fragmented component keys (DB_HOST, DB_PORT, ...) map to the parameter form, not a URL.
        var isComponent = /(^|_)(HOST|HOSTNAME|SERVER|PORT|USER|USERNAME|PASS|PASSWORD|DATABASE|NAME|CONNECTION|DRIVER)$/i.test(key) && eng !== 'mongodb' && eng !== 'firestore' && eng !== 'sqlite';
        $('engine-' + targetEnv).value = eng === 'firestore' ? 'firestore' : isComponent ? 'form' : 'url';
        setEngineMode(targetEnv);
        if (isComponent) {
          if (eng === 'mysql' || eng === 'postgresql') $('pengine-' + targetEnv).value = eng;
          $('phost-' + targetEnv).focus();
        } else {
          $((eng === 'firestore' ? 'fsproject-' : 'url-') + targetEnv).focus();
        }
        toast('Selected ' + key + ' for ' + targetEnv.toUpperCase());
      };
    });
  }

  function openSettings() {
    renderModalStatus();
    renderTemplateChips();
    ['dev', 'prod'].forEach(function (env) { $('result-' + env).textContent = ''; $('result-' + env).className = 'result'; });
    openDialog($('conn-dialog'));
  }

  function isFirestoreMode(env) { return $('engine-' + env).value === 'firestore'; }
  function isFormMode(env) { return $('engine-' + env).value === 'form'; }

  var PARAM_FIELDS = ['phost', 'pport', 'puser', 'ppass', 'pdb'];
  var DEFAULT_PORT = { mysql: '3306', postgresql: '5432' };

  function setEngineMode(env) {
    var fs = isFirestoreMode(env);
    var form = isFormMode(env);
    $('url-' + env).hidden = fs || form;
    document.querySelector('[data-toggle="' + env + '"]').hidden = fs || form;
    $('fsproject-' + env).hidden = !fs;
    $('fsemu-' + env).hidden = !fs;
    $('params-' + env).hidden = !form;
    $('result-' + env).textContent = '';
  }

  /** Quick-fill for a stock XAMPP install: MySQL on 127.0.0.1:3306 as root with an empty password. */
  function applyXamppDefaults(env) {
    $('engine-' + env).value = 'form';
    setEngineMode(env);
    $('pengine-' + env).value = 'mysql';
    $('phost-' + env).value = '127.0.0.1';
    $('pport-' + env).value = '3306';
    $('puser-' + env).value = 'root';
    $('ppass-' + env).value = '';
    $('pdb-' + env).focus();
  }

  function hasInput(env) {
    if (isFirestoreMode(env)) return !!$('fsproject-' + env).value.trim();
    if (isFormMode(env)) return !!$('phost-' + env).value.trim();
    return !!$('url-' + env).value.trim();
  }

  /** Parameter form: sent as the contract's components payload; the server assembles the URL in memory. */
  function componentsBody(env) {
    var engine = $('pengine-' + env).value;
    var host = $('phost-' + env).value.trim();
    var port = $('pport-' + env).value.trim() || DEFAULT_PORT[engine];
    if (!host) return { error: 'Enter a host, e.g. 127.0.0.1.' };
    if (!/^[A-Za-z0-9._:\[\]-]{1,253}$/.test(host)) return { error: 'Host must be a hostname or IP address.' };
    if (!/^\d{1,5}$/.test(port) || +port < 1 || +port > 65535) return { error: 'Port must be a number between 1 and 65535.' };
    var components = { engine: engine, host: host, port: +port };
    var user = $('puser-' + env).value.trim();
    var password = $('ppass-' + env).value;
    var database = $('pdb-' + env).value.trim();
    if (user) components.user = user;
    if (password) components.password = password;
    if (database) components.database = database;
    return { body: { env: env, engine: engine, components: components } };
  }

  /** Builds the /api/connect body. Firestore is sent as a firestore:// URL plus the contract's firestoreConfig. */
  function connectBody(env) {
    if (isFormMode(env)) return componentsBody(env);
    if (!isFirestoreMode(env)) {
      var url = $('url-' + env).value.trim();
      return url ? { body: { env: env, connectionUrl: url } } : { error: 'Enter a connection string first.' };
    }
    var projectId = $('fsproject-' + env).value.trim();
    var emulatorHost = $('fsemu-' + env).value.trim();
    if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(projectId)) return { error: 'Enter a valid Firestore project ID (lowercase letters, digits, hyphens).' };
    if (emulatorHost && !/^[A-Za-z0-9.\-\[\]:]+:\d{2,5}$/.test(emulatorHost)) return { error: 'Emulator host must look like localhost:8080.' };
    var firestoreUrl = 'firestore://' + encodeURIComponent(projectId) + (emulatorHost ? '?emulator=' + emulatorHost : '');
    var config = { projectId: projectId };
    if (emulatorHost) config.emulatorHost = emulatorHost;
    return { body: { env: env, engine: 'firestore', connectionUrl: firestoreUrl, firestoreConfig: config } };
  }

  function ping(env) {
    var out = $('result-' + env);
    var req = connectBody(env);
    if (req.error) { out.className = 'result err'; out.textContent = req.error; return Promise.resolve(false); }
    out.className = 'result'; out.textContent = 'Testing connection…';
    return postJson('/api/connect', req.body).then(function (r) {
      if (r.success) {
        var count = r.entityCount != null ? r.entityCount : r.tableCount;
        out.className = 'result ok';
        out.textContent = 'Connected to ' + (ENGINE_LABEL[r.engine] || r.engine) + ' in ' + Math.round(r.pingMs) + 'ms · ' + count + ' ' +
          entityNoun({ engine: r.engine }, true).toLowerCase() + ' · saved to session as ' + r.maskedUrl;
        $('url-' + env).value = '';
        $('ppass-' + env).value = '';
        return true;
      }
      out.className = 'result err';
      out.textContent = 'Error: ' + (r.error || 'Connection failed');
      var hint = hintFor(r.error);
      if (hint) out.textContent += ' — ' + hint;
      return false;
    }, function (e) {
      out.className = 'result err'; out.textContent = 'Error: ' + e.message; return false;
    });
  }

`;
