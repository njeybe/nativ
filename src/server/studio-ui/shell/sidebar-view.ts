// Pure sidebar markup: grouped navigation with badges, and the workspace footer.
export const sidebarViewScript = String.raw`  // ─── Sidebar markup (pure) ──────────────────────────────────────────────────
  var NAV_GROUPS = [['now', 'Now'], ['project', 'Project'], ['system', 'System']];

  function navBadges(env) {
    var badges = {}, model = env.model;
    if (model && model.needsYou.length) badges.home = ['warn', model.needsYou.length];
    if (model && model.running.length) badges.tasks = ['run', model.running.length];
    if (env.worktreeCount != null) badges.worktrees = ['', env.worktreeCount];
    if (env.benchmarkText) badges.benchmarks = ['', env.benchmarkText];
    return badges;
  }

  /** env = { model, view, worktreeCount, benchmarkText }. */
  Studio.sidebarHtml = function (env) {
    var badges = navBadges(env);
    var item = function (p) {
      var b = badges[p.id];
      return '<button type="button" class="nav-item" data-go="' + esc(p.id) + '"' +
        (env.view === p.id ? ' aria-current="page"' : '') + '>' + ui.svg(p.icon) +
        '<span class="nav-text">' + esc(p.label) + '</span>' +
        (b ? '<span class="nav-badge' + (b[0] ? ' ' + b[0] : '') + '">' + esc(b[1]) + '</span>' : '') + '</button>';
    };
    var groups = NAV_GROUPS.map(function (g) {
      var items = Studio.order.filter(function (p) { return p.group === g[0]; });
      if (!items.length) return '';
      return '<div class="nav-group"><div class="nav-glabel">' + g[1] + '</div>' + items.map(item).join('') + '</div>';
    }).join('');
    return '<nav class="nav" aria-label="Studio">' + groups + '</nav>';
  };

  /** env = { root, branch }. */
  Studio.sideFootHtml = function (env) {
    return '<span>Workspace</span><span class="mono" id="sb-root" title="' + esc(env.root || '') + '">' +
      esc(env.root || '–') + '</span><span>branch <span class="mono" id="sb-branch-name">' + esc(env.branch || '–') + '</span></span>';
  };

`;
