# Changelog

## Unreleased

### Changed

- **Studio redesign.** New Home, Tasks, Flow and Team pages focused on what needs you, what
  finished, how the work connects, and how each agent is doing. Ctrl+K command palette to find
  any task, a detail panel to read and act on one task, and light and dark themes.

### Removed

- Agent Cockpits and Workflow Canvas pages and the simulation controls in the UI. The
  simulation server endpoints remain for now and will be removed in a later cleanup.

## 2.2.0

### Added

- **Dual-Track Intake (Experience-First vs Data-First).** The `ui_specs.md` template can now start from either user experience (sketches and flows) or data structure (tables and entity relationships). Both paths lead to the same component map and style tile.
- **Semantic Component Trees.** Components now organize into a hierarchical structure with semantic roles: layout containers, data display, input controls, feedback, and navigation. The component map in `ui_specs.md` reflects these roles.
- **Stack-Aware Style Tiles.** Style tiles now include platform-specific variants. A web style tile shows how a design token adapts across desktop, tablet and mobile breakpoints. Flutter tiles show platform-native adaptations for iOS, Android and Cupertino.
- **Contextual Typography.** The `ui_specs.md` template documents font scales in context: scale per platform, role (heading, body, caption, code), and how type tokens map to semantic roles in components. Font sizes, weights and line heights are specified per context, not globally.
- **Mutation State Specs.** Every input component, button, and interactive element now carries a spec for its mutation states: default, hover, focus, disabled, loading, error and success. States are shown in the wireframe notes and in the component section.

## 2.1.0

### Added

- **Design-first planning.** The `ui_specs.md` template is rewritten around planning levels (Quick, Standard, Full), content samples, user flows, wireframes, a component map and a style tile. The architect, frontend and flutter guides are leaner.
- **Optional task fields** `specRefs`, `complexity` and `acceptanceCriteria`: `nativ task add --spec-refs --complexity --accept`, and the same fields on the `nativ_task_add` MCP tool.
- **Spec slices.** `nativ task next --json` returns `specSlices` and `specWarnings` for a task's `specRefs`, the native run engine adds a `<spec_slices>` block to the worker prompt, and `nativ validate` warns about refs that do not resolve.
- **Complexity-based model routing.** `nativ task next --json` returns `recommendedModel` (simple: haiku, standard: sonnet, complex: opus). Override it with `workerModels` in `.nativ/config.json`. The run engine uses it when no model is given, and the project manager passes it as the Agent `model` parameter. Works with a Claude Pro login; no API key.
- **Code style rules** for workers in `AGENTS.md`, and a code-shape check in `nativ verify` for long lines and long comments. It warns by default; configure it with `codeStyle` in `.nativ/config.json`. The `nativ task complete` gatekeeper runs it too, warn-only.
- **API spec links.** `specRefs` can point at an endpoint by method and path (`api_contracts.json#GET /path`) or by endpoint id (`api_contracts.json#<endpoint-id>`).
- **Design Brief step** in the Architect procedure. It records the primary platform and comes before the design directions.

### Changed

- **`nativ_task_complete` over MCP refuses `skipVerify`.** Only a human at a terminal can skip verification.

## 2.0.2

- **`nativ doctor` no longer reports a failure on a brand-new project.** Right after `nativ init`, Claude Code lists the project's `nativ` MCP server as "Pending approval" until you approve it, which is the expected first state. Doctor showed it as a red failure and exited 1. It is now a warning that tells you to open `claude` in the folder and approve the server; a server that genuinely fails to connect is still a failure.

## 2.0.1

Documentation and package metadata only; no behaviour changes.

- **npm is the only install path.** The source repository is private, so the instructions for `npm install -g github:â€¦` and for adding the plugin marketplace were removed from the README and the installation guide. `nativ setup` is the complete route: it writes the agents, the enforcement hook, the MCP entry and the permission rules, which a plugin cannot ship.
- The plugin files still ship inside the package (`plugin/`) and can be tried for one session with `claude --plugin-dir`.
- `package.json` no longer declares `repository`, `homepage` or `bugs`, so the npm page has no dead links.
- The 2.0.0 entry below still mentions the plugin marketplace; that route is not available outside the private repository.

## 2.0.0

nativ is now role-based and Claude-first. The roles (architect, project manager, worker, verifier) are fixed; the model behind each one is configurable, and Claude Code is the default host for all of them. Antigravity and Gemini still work as an optional architect.

### Added

- **Provider chain for Tier 1 triage.** Claude Code under your own login first (no API key needed), then the Anthropic API, then Gemini, then the offline rules engine. A provider that hits a usage limit is remembered and skipped until it resets, so a limit no longer stalls triage.
- **Role enforcement.** `nativ hook check` runs before every file write from Claude Code. It flags or blocks writes outside the active task's `targetFiles`, writes under `.ai/` from anyone but the architect, and writes to secret files. Modes are `warn` (default), `block` and `off`, set in `.nativ/config.json`. `nativ task unlock <id>` lifts scope for one task and is deliberately not available to agents. `nativ hook status` shows what applies.
- **`nativ setup` and `nativ doctor`.** Setup writes and merges `.mcp.json`, `.claude/settings.json`, `.claude/agents/`, `AGENTS.md` and `.nativ/config.json` without overwriting your own settings. Doctor checks the integration, asks Claude Code whether the MCP server connects, and `nativ doctor --fix` repairs drift. `nativ init` now runs setup.
- **Claude Code plugin and marketplace** (`njeybe/nativ`), generated from the same sources as setup.
- **Agent defaults for a Claude subscription.** Architect on Opus, worker on Sonnet, verifier on Haiku, with turn caps; triage on Haiku.
- **`nativ_doctor`** MCP tool (read-only).
- **`AGENTS.md`** as the one canonical directive. `CLAUDE.md` and `GEMINI.md` point at it.

### Changed

- **The npm package is now `@njeybe/nativ`** (it was `nativ-cli`). The command is still `nativ`. `nativ-cli` stays on npm and is deprecated in favour of the new name.
- **`nativ update` no longer overwrites files you edited.** It refreshes only files nativ wrote and you have not touched, keeps the rest and reports them, and `--force` replaces them. It also restores `AGENTS.md`, the agents and the hooks. It never touches your contracts.
- **Dispatched agents no longer run with `--dangerously-skip-permissions`.** The runner and Studio use `acceptEdits` plus a per-task allowlist, so the deny and ask rules and the enforcement hook apply. A task that needs another command is denied instead of run; widen the list with `NATIV_RUNNER_ALLOW`.
- Claude is the default architect and triage provider. Wording across the CLI, templates and docs names roles instead of one vendor.
- `nativ --version` and the MCP server report the version from `package.json`.

### Removed

- **The `agentj_*` MCP tools and the `agentj://` resources.** Only `nativ_*` and `nativ://` remain. The `.agentj/*.local.json` secret patterns and the `AGENTJ_DEV_DATABASE_URL` / `AGENTJ_PROD_DATABASE_URL` variables are still recognised.

### Migrating from 1.x

1. Switch to the new package: `npm uninstall -g nativ-cli`, then `npm install -g @njeybe/nativ`. If your own MCP configs or `nativ setup --command` use `npx -y nativ-cli`, change that to `npx -y @njeybe/nativ`.
2. Rename any `agentj_*` tool or `agentj://` resource in your own configs to `nativ_*` and `nativ://`.
3. In each project run `nativ update`, then `nativ doctor` (add `--fix` if it reports drift).
4. Open Claude Code in the project once and accept the trust dialog; until then it ignores the project's permission rules.
5. If `nativ doctor` warns that a `nativ` MCP server in your user or local scope shadows the project's, remove it: `claude mcp remove nativ -s local`.
6. Optional: `nativ setup --enforcement block` once you trust the scope rules.

## 1.0.0

Initial release.
