// Console drawer, dialogs and other shell overlays.
export const markupTools = String.raw`</main>
</div>
</div>
<div class="scrim" id="scrim" hidden></div>
<aside class="drawer" id="task-drawer" role="dialog" aria-label="Task details" aria-modal="true" tabindex="-1" hidden></aside>
<div class="pal-wrap" id="pal" hidden></div>

<section id="runner-console-drawer" aria-labelledby="rc-task" hidden>
  <header class="rc-head">
    <code class="rc-task" id="rc-task">&#8211;</code>
    <span class="rc-title" id="rc-title"></span>
    <ol class="rc-steps" id="rc-steps" aria-label="Runner lifecycle"></ol>
    <div class="rc-controls">
      <button class="rc-btn" type="button" id="rc-autoscroll" aria-pressed="true" aria-label="Toggle console auto-scroll">Auto-scroll</button>
      <button class="rc-btn" type="button" id="rc-clear" aria-label="Clear the console buffer">Clear</button>
      <button class="rc-btn danger" type="button" id="rc-abort" aria-label="Abort the running agent">Abort</button>
      <button class="rc-btn" type="button" id="rc-minimize" aria-expanded="true" aria-controls="rc-body">Minimize</button>
      <button class="rc-btn" type="button" id="rc-close" aria-label="Close the runner console">Close</button>
    </div>
  </header>
  <div class="rc-tabs" role="tablist" aria-label="Console views">
    <button class="rc-tab" type="button" role="tab" id="rc-tab-logs" data-rc-tab="logs" aria-controls="rc-body" aria-selected="true"><svg class="icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5l3.5 3.5L3 11.5M8.5 12h4.5"/></svg>Live Logs</button>
    <button class="rc-tab" type="button" role="tab" id="rc-tab-diff" data-rc-tab="diff" aria-controls="rc-diff" aria-selected="false" tabindex="-1"><svg class="icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5 2.5v6M2 5.5h6M8.5 12.5h5.5"/></svg>Worktree Changes <span class="rc-count" id="rc-diff-count">&#8211;</span></button>
    <button class="rc-tab" type="button" role="tab" id="rc-tab-heal" data-rc-tab="heal" aria-controls="rc-heal" aria-selected="false" tabindex="-1" hidden><svg class="icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.8l5.2 2.1v3.7c0 3.1-2.2 5.6-5.2 6.6-3-1-5.2-3.5-5.2-6.6V3.9z"/><path d="M5.6 8.1l1.7 1.7 3.2-3.3"/></svg>Self-Healing Proposal <span class="rc-count is-proposal" id="rc-heal-count">1</span></button>
  </div>
  <pre class="rc-body" id="rc-body" role="log" aria-live="polite" aria-label="Runner output" tabindex="0"></pre>
  <div class="rc-diff" id="rc-diff" role="tabpanel" aria-labelledby="rc-tab-diff" hidden>
    <div class="rc-diff-bar">
      <span id="rc-diff-summary">Uncommitted changes in the task worktree</span>
      <button class="rc-btn" type="button" id="rc-diff-refresh" aria-label="Reload the worktree diff">Reload Diff</button>
    </div>
    <ul class="rc-files" id="rc-diff-files" aria-label="Changed files"></ul>
    <pre class="rc-diff-body" id="rc-diff-body" aria-label="Unified diff" tabindex="0"></pre>
  </div>
  <div class="rc-heal" id="rc-heal" role="tabpanel" aria-labelledby="rc-tab-heal" tabindex="0" hidden></div>
  <footer class="rc-foot">
    <span>Elapsed <strong id="rc-elapsed">00:00</strong></span>
    <span>Output <strong id="rc-bytes">0 B</strong></span>
    <span id="rc-spend-wrap" hidden>Spend <strong id="rc-spend">$0.0000</strong></span>
    <span id="rc-cache-wrap" hidden>Cache hit <strong id="rc-cache">0%</strong></span>
    <span>Gatekeeper <strong id="rc-gate">Idle</strong></span>
    <span id="rc-exit"></span>
  </footer>
</section>

<dialog id="dispatch-dialog" aria-labelledby="dispatch-title" aria-describedby="dispatch-lead">
  <form class="modal" method="dialog" id="dispatch-form">
    <h2 id="dispatch-title">Dispatch Task</h2>
    <p class="lead" id="dispatch-lead">Hands the task to an autonomous Claude runner. Output, token spend and gatekeeper results stream into the console drawer.</p>
    <div class="dispatch-task">
      <div class="dispatch-task-head"><code class="tcard-id" id="dispatch-task-id">task</code><span class="badge badge-agent" id="dispatch-agent">agent</span></div>
      <h3 id="dispatch-task-title"></h3>
      <ul class="file-list" id="dispatch-files" aria-label="Target files"></ul>
      <code class="cmd" id="dispatch-verify"></code>
    </div>
    <fieldset class="choice-group">
      <legend>Engine</legend>
      <div class="engine-options">
        <label class="engine-option"><input type="radio" name="dispatch-engine" id="dispatch-engine-native" value="native" checked><svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z"/></svg><span><b>Native Engine</b><span>Direct API, Prompt Caching &amp; Fast Streaming. Token spend is reported live.</span></span></label>
        <label class="engine-option"><input type="radio" name="dispatch-engine" id="dispatch-engine-cli" value="cli"><svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M4.5 6.5L6.5 8l-2 1.5M8.5 10h3"/></svg><span><b>CLI Terminal Pairing</b><span>Interactive Claude Code in a terminal shell, driven by the command below.</span></span></label>
      </div>
    </fieldset>
    <fieldset class="choice-group">
      <legend>Thinking Budget</legend>
      <div class="budget-chips">
        <label class="budget-chip"><input type="radio" name="dispatch-budget" id="dispatch-budget-none" value="0" checked>None<small>Fast / Deterministic</small></label>
        <label class="budget-chip"><input type="radio" name="dispatch-budget" id="dispatch-budget-standard" value="2048">Standard<small>2,048 tokens</small></label>
        <label class="budget-chip"><input type="radio" name="dispatch-budget" id="dispatch-budget-deep" value="4096">Deep<small>4,096 tokens</small></label>
      </div>
      <p class="field-hint" id="dispatch-budget-hint" aria-live="polite"></p>
    </fieldset>
    <div class="field" id="dispatch-command-field" hidden>
      <label for="dispatch-command">Autonomous command</label>
      <textarea class="input cmd-preview" id="dispatch-command" rows="4" spellcheck="false"></textarea>
      <p class="field-hint" id="dispatch-command-hint">Leave unchanged to use the server's default runner (Claude Code unless <code>NATIV_RUNNER_COMMAND</code> is set). In a custom command, <code>{taskId}</code>, <code>{taskTitle}</code> and <code>{worktreeDir}</code> are filled in on launch.</p>
    </div>
    <div class="switches" role="group" aria-label="Run options">
      <label class="switch"><input type="checkbox" id="dispatch-worktree" checked><span class="switch-track" aria-hidden="true"></span><span class="switch-text"><b>Isolated Worktree</b><span>Run on branch agent/task-&lt;id&gt; in .worktrees/, away from your working copy.</span></span></label>
      <label class="switch"><input type="checkbox" id="dispatch-verify-gate" checked><span class="switch-track" aria-hidden="true"></span><span class="switch-text"><b>Auto-verify Gatekeeper</b><span>Run the test command when the agent exits.</span></span></label>
      <label class="switch"><input type="checkbox" id="dispatch-merge"><span class="switch-track" aria-hidden="true"></span><span class="switch-text"><b>Auto-merge on Pass</b><span>Merge the worktree branch into main once verification passes.</span></span></label>
    </div>
    <p class="field-error" id="dispatch-error" aria-live="polite"></p>
    <div class="modal-foot">
      <button class="btn" value="cancel" type="submit">Cancel</button>
      <button class="btn primary" type="button" id="btn-launch-agent" aria-keyshortcuts="Control+Enter"><svg class="icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.5 2.8v10.4L13 8z"/></svg>Launch Autonomous Runner <kbd>Ctrl+Enter</kbd></button>
    </div>
  </form>
</dialog>

<dialog id="confirm-dialog" class="narrow" aria-labelledby="confirm-title" aria-describedby="confirm-body">
  <form class="modal" method="dialog">
    <h2 id="confirm-title">Confirm</h2>
    <p class="lead" id="confirm-body"></p>
    <div class="modal-foot">
      <button class="btn" value="cancel" type="submit">Cancel</button>
      <button class="btn primary" type="button" id="btn-confirm-ok">Confirm</button>
    </div>
  </form>
</dialog>

<dialog id="conn-dialog" aria-labelledby="conn-title">
  <form class="modal" method="dialog" id="conn-form">
    <h2 id="conn-title">Connection Settings</h2>
    <p class="lead">Connection strings stay in memory inside the local nativ process. They are never written to disk or shown to AI agents; only masked URLs are displayed.</p>
    <div id="conn-template-chips" hidden></div>
    <div class="field" data-env="dev">
      <label for="engine-dev"><span class="dot" id="mdot-dev"></span> Dev / Staging</label>
      <div class="field-row">
        <select class="input" id="engine-dev" data-engine="dev" aria-label="Dev database type">
          <option value="url">Connection URL (PostgreSQL, MySQL, SQLite, MongoDB)</option>
          <option value="form">Connection Form (XAMPP / Parameters)</option>
          <option value="firestore">Firebase Firestore</option>
        </select>
      </div>
      <div class="param-grid" id="params-dev" hidden>
        <select class="input" id="pengine-dev" aria-label="Dev database engine">
          <option value="mysql">MySQL</option>
          <option value="postgresql">PostgreSQL</option>
        </select>
        <input class="input" id="phost-dev" type="text" autocomplete="off" spellcheck="false" aria-label="Dev host" placeholder="Host, e.g. 127.0.0.1">
        <input class="input" id="pport-dev" type="text" inputmode="numeric" autocomplete="off" aria-label="Dev port" placeholder="Port">
        <input class="input" id="puser-dev" type="text" autocomplete="off" spellcheck="false" aria-label="Dev user" placeholder="User">
        <input class="input span-2" id="ppass-dev" type="password" autocomplete="new-password" aria-label="Dev password" placeholder="Password (empty for XAMPP root)">
        <input class="input span-2" id="pdb-dev" type="text" autocomplete="off" spellcheck="false" aria-label="Dev database name" placeholder="Database name">
        <button class="btn small" type="button" data-xampp="dev">Use XAMPP Defaults</button>
      </div>
      <div class="field-row">
        <input class="input" id="url-dev" type="password" autocomplete="off" spellcheck="false" aria-label="Dev connection string" placeholder="postgres://user:password@localhost:5432/app_dev  or  mongodb://localhost:27017/app">
        <button class="btn small" type="button" data-toggle="dev" aria-controls="url-dev" aria-pressed="false">Show</button>
        <input class="input" id="fsproject-dev" type="text" autocomplete="off" spellcheck="false" aria-label="Dev Firestore project ID" placeholder="Project ID" hidden>
        <input class="input" id="fsemu-dev" type="text" autocomplete="off" spellcheck="false" aria-label="Dev Firestore emulator host" placeholder="Emulator host (optional), e.g. localhost:8080" hidden>
        <button class="btn small" type="button" data-ping="dev">Test Ping</button>
      </div>
      <div class="current" id="current-dev"></div>
      <div class="result" id="result-dev" aria-live="polite"></div>
    </div>
    <div class="field" data-env="prod">
      <label for="engine-prod"><span class="dot" id="mdot-prod"></span> Production</label>
      <div class="field-row">
        <select class="input" id="engine-prod" data-engine="prod" aria-label="Production database type">
          <option value="url">Connection URL (PostgreSQL, MySQL, SQLite, MongoDB)</option>
          <option value="form">Connection Form (XAMPP / Parameters)</option>
          <option value="firestore">Firebase Firestore</option>
        </select>
      </div>
      <div class="param-grid" id="params-prod" hidden>
        <select class="input" id="pengine-prod" aria-label="Production database engine">
          <option value="mysql">MySQL</option>
          <option value="postgresql">PostgreSQL</option>
        </select>
        <input class="input" id="phost-prod" type="text" autocomplete="off" spellcheck="false" aria-label="Production host" placeholder="Host">
        <input class="input" id="pport-prod" type="text" inputmode="numeric" autocomplete="off" aria-label="Production port" placeholder="Port">
        <input class="input" id="puser-prod" type="text" autocomplete="off" spellcheck="false" aria-label="Production user" placeholder="User">
        <input class="input span-2" id="ppass-prod" type="password" autocomplete="new-password" aria-label="Production password" placeholder="Password">
        <input class="input span-2" id="pdb-prod" type="text" autocomplete="off" spellcheck="false" aria-label="Production database name" placeholder="Database name">
        <button class="btn small" type="button" data-xampp="prod">Use XAMPP Defaults</button>
      </div>
      <div class="field-row">
        <input class="input" id="url-prod" type="password" autocomplete="off" spellcheck="false" aria-label="Production connection string" placeholder="postgres://user:password@db.example.com:5432/app  or  mongodb+srv://…">
        <button class="btn small" type="button" data-toggle="prod" aria-controls="url-prod" aria-pressed="false">Show</button>
        <input class="input" id="fsproject-prod" type="text" autocomplete="off" spellcheck="false" aria-label="Production Firestore project ID" placeholder="Project ID" hidden>
        <input class="input" id="fsemu-prod" type="text" autocomplete="off" spellcheck="false" aria-label="Production Firestore emulator host" placeholder="Emulator host (optional)" hidden>
        <button class="btn small" type="button" data-ping="prod">Test Ping</button>
      </div>
      <div class="current" id="current-prod"></div>
      <div class="result" id="result-prod" aria-live="polite"></div>
    </div>
    <p class="lead" style="margin:0 0 8px">Firestore uses your local Application Default Credentials (<code>gcloud auth application-default login</code>) or the emulator; no key file is ever uploaded here.</p>
    <div class="modal-foot">
      <button class="btn" value="cancel" type="submit">Close</button>
      <button class="btn primary" type="button" id="btn-save-conn">Save to In-Memory Session</button>
    </div>
  </form>
</dialog>

<dialog id="media-dialog" aria-labelledby="media-title">
  <form class="modal media-modal" method="dialog">
    <h2 id="media-title">Image field</h2>
    <p class="lead" id="media-sub"></p>
    <div class="thumb-box" id="media-thumb"></div>
    <dl id="media-details"></dl>
    <p class="media-note">Only metadata from sampled documents is shown. Raw image bytes and full Base64 payloads are never sent to the browser or to AI agents.</p>
    <div class="modal-foot"><button class="btn" value="close" type="submit">Close</button></div>
  </form>
</dialog>

<dialog id="record-dialog" aria-labelledby="record-title">
  <form class="modal" method="dialog" id="record-form">
    <h2 id="record-title">Record</h2>
    <p class="lead" id="record-lead">Insert or edit record.</p>
    <div class="record-form-grid" id="record-fields"></div>
    <div class="modal-foot">
      <button class="btn" value="cancel" type="submit">Cancel</button>
      <button class="btn primary" type="button" id="btn-save-record">Save Record</button>
    </div>
  </form>
</dialog>

<dialog id="challenge-dialog" aria-labelledby="challenge-title">
  <form class="modal modal-prod-guard" method="dialog" id="challenge-form">
    <span class="challenge-badge">PRODUCTION MUTATION SAFEGUARD</span>
    <h2 id="challenge-title">Confirm Production Mutation</h2>
    <div class="challenge-box">
      <p>Target: <b>PRODUCTION ENVIRONMENT</b></p>
      <p id="challenge-desc">You are about to modify live production data.</p>
      <p>To proceed, type the target name exactly: <code id="challenge-target-name">entity</code></p>
    </div>
    <div class="field">
      <label for="challenge-input">Confirmation phrase</label>
      <input class="input" id="challenge-input" type="text" autocomplete="off" spellcheck="false" placeholder="Type name to confirm">
    </div>
    <div class="modal-foot">
      <button class="btn" value="cancel" type="submit">Cancel</button>
      <button class="btn btn-danger" type="button" id="btn-confirm-challenge" disabled>Execute Production Mutation</button>
    </div>
  </form>
</dialog>

<div class="thumb-pop" id="thumb-pop" role="tooltip" hidden></div>

`;
