// Database Studio panel content; the shell supplies the surrounding section.
export const databaseMarkup = String.raw`    <div class="panel-head">
      <div class="panel-title">
        <h1>Database Studio</h1>
        <p class="lead">Schema inspector, live data browser, drift tracker and migration preview. Connection strings stay inside this local process.</p>
      </div>
      <div class="panel-actions">
        <button class="btn" id="btn-settings" type="button">Connection Settings</button>
        <button class="btn primary" id="btn-export" type="button">Export Contract</button>
      </div>
    </div>
    <div class="telemetry" id="telemetry" aria-label="Database telemetry"></div>

    <div class="env-toggle-bar">
      <div class="env-segmented" role="group" aria-label="Environment Focus Mode">
        <button type="button" class="env-seg-btn" data-env-mode="dev" aria-pressed="true">Staging / Dev</button>
        <button type="button" class="env-seg-btn" data-env-mode="prod" aria-pressed="false">Production</button>
        <button type="button" class="env-seg-btn" data-env-mode="split" aria-pressed="false">Split Comparison</button>
      </div>
    </div>

    <div id="diagnostic-banner" aria-live="polite" hidden></div>

    <nav class="tabs" role="tablist" aria-label="Database views">
      <button class="subtab" role="tab" id="tab-explorer" aria-controls="view" data-tab="explorer">Schema &amp; Structure <span class="count" id="count-explorer">0</span></button>
      <button class="subtab" role="tab" id="tab-data" aria-controls="view" data-tab="data">Live Data Browser <span class="count" id="count-data">0</span></button>
      <button class="subtab" role="tab" id="tab-drift" aria-controls="view" data-tab="drift">Schema Changes (Live vs Blueprint) <span class="count" id="count-drift">0</span></button>
      <button class="subtab" role="tab" id="tab-sql" aria-controls="view" data-tab="sql">Migration Script Preview <span class="count" id="count-sql">0</span></button>
    </nav>

    <div id="view" role="tabpanel" tabindex="-1"></div>
`;
