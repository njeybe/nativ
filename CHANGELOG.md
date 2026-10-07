# Changelog

## Unreleased

### Improved: token usage and autonomy

- **Leaner directives.** `AGENTS.md` (-17%), `CLAUDE.md` (-20%) and the worker and verifier agents are shorter. Subagents no longer re-read `AGENTS.md`, which already reaches them through `CLAUDE.md`. The human-communication rules now live in one place.
- **Compact JSON.** `task next`, `task list` and `triage --json` print single-line JSON. `recommendedContractSlice` is a bare file list.
- **Brief task list over MCP.** `nativ_task_list` returns a short summary per task; pass `full: true` for every field.
- **Self-healing ladder.** `AGENTS.md` and `CLAUDE.md` tell agents to retry, patch additively, then run `nativ triage --all --apply --json`; only `REQUIRE_HUMAN_DECISION` items, destructive changes, credentials and repeated failures reach the human.
- **Resumable sessions.** The SessionStart orientation lists blocked tasks and pending escalations.
- **Budget guard.** `tests/test-token-budget.mjs` fails when an always-loaded file outgrows its token budget.

### Added

- **Notifications when nativ needs you.** A `notify` webhook (Slack, Discord, ntfy, any JSON endpoint) or command in `.nativ/config.json` is called when triage returns `REQUIRE_HUMAN_DECISION` or the circuit breaker blocks a task, once per escalation. Webhooks must be https. `nativ notify test` sends a sample. Failures are recorded, never fatal.

### Fixed

- **Tasks are claimed, not just started.** `task start` refuses a completed or blocked task and one whose dependencies are unfinished, and records `claimedBy` (`--agent` or `NATIV_AGENT_ID`) and `claimedAt`. Another agent cannot start a task with a fresh claim; a claim older than 4 hours can be taken over. Complete and block release the claim. A person can override with `--force`. `nativ_task_start` takes an optional `agent`.
- **Stuck tasks recover.** `nativ task reclaim` (and `nativ_task_reclaim`) returns `in_progress` tasks with a claim older than 4 hours (`--older-than`) to pending, so a crashed agent no longer leaves a task stuck forever. `--dry-run` reports only. The SessionStart orientation lists stale tasks, and the self-healing ladder covers them.
- **`nativ init` writes the architect guide.** It copied a fixed list of eight guides and skipped `architect.md`; it now copies every guide in the templates. `nativ validate` checks the architect guide when present.
- **Windows paths in `.mcp.json` count as machine-specific on every OS.** A `C:/...` command was treated as portable when setup ran on Linux or macOS.
- **`npm test` runs every suite.** `tests/run-all.mjs` keeps going after a failure and lists every failed suite at the end.

## 2.5.1

### Fixed

- Added missing `architect` role guide (`templates/dot-ai/subagents/architect.md` and `.ai/subagents/architect.md`). `nativ doctor` no longer warns about the architect role having no guide.

## 2.5.0

### Added

- **Adaptive Ceremony Profiles.** Introduced `nativ profile [prototype | solo | enterprise]` to adapt framework rigor across all development stages:
  - **`prototype`**: Zero-friction exploration for hackathons and day 1 greenfield projects. Relaxes scope enforcement, enables contract auto-adoption without escalation halts, and disables test integrity blocking.
  - **`solo`**: Lightweight agility for solo microservices and utilities with advisory warnings and auto-evolving contracts.
  - **`enterprise`**: Full production rigor with strict role boundaries, formal contract governor review, test integrity protection, and circuit breakers.
- **Native CI/CD Headless Automation.** `refuseHeadless` now detects CI environments (`CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `NATIV_CI_OVERRIDE`) to permit headless test verification and automated pipeline gates without TTY failures.

### Improved & Refactored

- **Modular Architecture.** Decomposed large monolithic modules into focused, single-responsibility submodules adhering to the ~300-line standard:
  - `src/commands/task/`: Split into `task-query`, `task-lifecycle`, `task-add`, `task-escalate`, and `task-common`.
  - `src/core/verifier/`: Split into `executor`, `phases`, and `task-verifier`.
  - `src/core/setup/`: Split into `types`, `config-merger`, `template-planner`, `setup-planner`, and `session-context`.
  - `src/commands/db/`: Decoupled database introspection (`db-introspect`) and ANSI terminal presentation (`db-formatter`).
  - `src/commands/triage/`: Decoupled triage persistence (`triage-store`) and interactive card UI (`triage-ui`).
- **ESM Type Re-exports.** Fixed TypeScript interface re-exports in barrel files using explicit `export type` syntax.

## 2.4.1

### Fixed & Improved

- **Resilient Spec Slices Resolution.** Enhanced `resolveSpecSlices` in `src/core/spec-slices.ts` to gracefully resolve non-standard and shorthand contract/spec references across `.ai/` contracts:
  - **Shorthand Markdown Section Anchors:** Supports numeric and prefix section references (e.g. `ui_specs.md#6`, `ui_specs.md#15`, `ui_specs.md#15.1`) by matching section prefixes when exact heading slug matches are not found.
  - **JSON Root Keys without Leading Slash:** Automatically resolves JSON references missing a leading slash (e.g. `api_contracts.json#confirmationPageContracts`, `api_contracts.json#legalDocumentsContract`) by falling back to root property pointers and dot-path navigation.
  - **Route Names Lookup:** Resolves named route references (e.g. `api_contracts.json#coaches.payment-qr`, `company.coaches.payment-qr`) across `routingPolicy.playerRoutes`, `venueScopedRoutes`, and other route collections.
  - **Mail Events by Trigger:** Resolves mail event references by trigger name (e.g. `api_contracts.json#Coach Lesson Booked`, `Coach Payment Proof Uploaded`).
  - **Database Schema Tables:** Resolves table references directly by name in `relevantTables` and `tables` collections (e.g. `db_schema.json#legal_documents`, `db_schema.json#coach_bookings`, `db_schema.json#sports`).

## 2.4.0

### Added

- **Learnings.** `nativ learn propose` (and the `nativ_learn_propose` MCP tool) records a project
  lesson the contracts do not capture. A human approves it with `nativ learn approve` in an
  interactive terminal, after seeing the full lesson; a lesson that changed during review is not
  decided. Approved lessons reach `nativ task next --json` as `learnings`, scoped to the task's
  role and target files, at most five.
- **Verify phases.** `verifyPhases` in `.nativ/config.json` lists checks (type check, lint) that
  run before every task's own command in `nativ verify` (once per batch), the `task complete`
  gatekeeper and Studio dispatch. They are always read from the main checkout, and an unreadable
  config fails verification instead of skipping it. A failure names the phase, in Studio too.
- **Escalation history.** `nativ task next --json` adds `priorEscalations`: the task's settled
  escalations with how each was settled, so a worker does not raise a settled gap again.
- **Explorer agent.** An `explorer` subagent with only Read, Grep and Glob (Sonnet; the project
  manager passes Haiku for a quick lookup) maps existing code: layout, components, routes, data
  models, conventions, drift against the contracts, and suggested target files for a feature. The
  architect saves its report as `.ai/codebase_map.md` after the human approves, stamped with the
  commit it describes.
- **Harness checks in `nativ doctor`.** Flags `disableAllHooks` (fail) and `bypassPermissions`
  (warning) in project or local Claude settings, settings files it cannot read, well-known
  credential formats in files agents read (file and line only, never the value), roles with no
  guide, hand-edited role guides, lessons waiting for approval, an unreadable lessons file,
  and a `ui_specs.md` that predates the Marketing pages checks.

### Changed

- `nativ task unlock`, `nativ task complete --no-verify` and `nativ db sync --yes` now refuse to run
  without an interactive terminal, like `nativ learn approve`. Agents run headless, so this holds
  even where no permission rule is installed. `task unlock --revoke` still works anywhere.
- Completing a task closes its pending escalations, and Studio's Needs you no longer lists
  completed tasks.
- The enforcement hook reads the enforcement mode and unlocks from the main checkout, also inside a
  task worktree, and guards `../..` paths from a worktree into the main checkout's `.ai/`, `.nativ/`
  and secrets.
- `.nativ/` is protected like `.ai/`: the enforcement hook flags agent edits there, setup adds ask
  rules for it, and Studio's native runner refuses it. Agents are also denied reading
  `.nativ/*.local.json`.
- Design-time rules (fonts, color, marketing page layout) moved into the Anti-Generic Checklist of
  the `ui_specs.md` template, checked by the architect. The frontend guide keeps build-time rules,
  and its design read applies only to Standard or Full work that renders a screen.

## 2.3.1

### Fixed

- Studio Dispatch on Windows: task text with quotes or symbols like > could cut off the agent's instructions and send its output to a stray file.

### Removed

- The simulation endpoints (`/api/pipeline/simulation/start` and `/stop`) that fed the old Workflow Canvas.

## 2.3.0

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

- **npm is the only install path.** The source repository is private, so the instructions for `npm install -g github:...` and for adding the plugin marketplace were removed from the README and the installation guide. `nativ setup` is the complete route: it writes the agents, the enforcement hook, the MCP entry and the permission rules, which a plugin cannot ship.
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
