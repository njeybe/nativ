# Changelog

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

- **`nativ update` no longer overwrites files you edited.** It refreshes only files nativ wrote and you have not touched, keeps the rest and reports them, and `--force` replaces them. It also restores `AGENTS.md`, the agents and the hooks. It never touches your contracts.
- **Dispatched agents no longer run with `--dangerously-skip-permissions`.** The runner and Studio use `acceptEdits` plus a per-task allowlist, so the deny and ask rules and the enforcement hook apply. A task that needs another command is denied instead of run; widen the list with `NATIV_RUNNER_ALLOW`.
- Claude is the default architect and triage provider. Wording across the CLI, templates and docs names roles instead of one vendor.
- `nativ --version` and the MCP server report the version from `package.json`.

### Removed

- **The `agentj_*` MCP tools and the `agentj://` resources.** Only `nativ_*` and `nativ://` remain. The `.agentj/*.local.json` secret patterns and the `AGENTJ_DEV_DATABASE_URL` / `AGENTJ_PROD_DATABASE_URL` variables are still recognised.

### Migrating from 1.x

1. Update the CLI: `npm install -g nativ-cli@latest`.
2. Rename any `agentj_*` tool or `agentj://` resource in your own configs to `nativ_*` and `nativ://`.
3. In each project run `nativ update`, then `nativ doctor` (add `--fix` if it reports drift).
4. Open Claude Code in the project once and accept the trust dialog; until then it ignores the project's permission rules.
5. If `nativ doctor` warns that a `nativ` MCP server in your user or local scope shadows the project's, remove it: `claude mcp remove nativ -s local`.
6. Optional: `nativ setup --enforcement block` once you trust the scope rules.

## 1.0.0

Initial release.
