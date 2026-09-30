# nativ

A role-based multi-agent workflow for AI coding agents. **Claude Code is the default**; other agents plug in. `nativ` keeps the design contracts, the task plan and the guardrails in your repository, so the same rules hold whichever tool or model does the work.

> **Package:** `@njeybe/nativ` | **Command:** `nativ`

---

## The idea

Four roles, fixed. The model or vendor behind each role is configurable.

```
   Architect            designs contracts (database, API, UI); the human approves each step
       |
       v   .ai/ contracts + master_plan.json
   Project Manager      runs the task loop, delegates, reports (the main Claude Code session)
       |
       v   one task, one role guide, its own worktree if you like
   Workers              backend, frontend, database, QA, Flutter, DevOps, security, migration
       |
       v
   Verifier             independent checks; cannot edit files
```

Why it works:

- **Contracts, not chat.** `.ai/db_schema.json`, `.ai/api_contracts.json` and `.ai/ui_specs.md` are the source of truth. Workers implement against them and escalate gaps instead of improvising.
- **Boundaries enforced by code.** A Claude Code hook checks every file write against the active task, the protected contracts and your secret files. It does not rely on the model remembering a rule.
- **Independent verification.** Each task has a `verificationCommand` that a gatekeeper re-runs before the task can complete, and a separate verifier agent reviews the result.
- **Zero-credential air-gap.** Agents see database structure, never passwords, connection strings or rows.

---

## Quick start

### 1. Install

You need Node.js 20 or newer and Git.

```bash
npm install -g @njeybe/nativ
nativ --version
```

The package is `@njeybe/nativ`; the command is `nativ`. More options, including running it without installing, are in [docs/installation.md](docs/installation.md).

### 2. Set up a project

```bash
cd your-project
nativ init
```

`nativ init` scaffolds the `.ai/` workflow and then runs `nativ setup`, which writes the Claude Code configuration:

| File | What it does |
| :--- | :--- |
| `.mcp.json` | Registers the `nativ` MCP server |
| `.claude/settings.json` | Permission rules, the enforcement hook, the session-start orientation hook |
| `.claude/agents/` | The `architect`, `worker` and `verifier` agents |
| `AGENTS.md` | The one directive every agent follows. `CLAUDE.md` and `GEMINI.md` point at it |
| `.nativ/config.json` | Enforcement mode and provider choices |

Setup **merges**: it never overwrites your own settings, hooks, MCP servers or edited files. It is safe to run any number of times, and `nativ setup --dry-run` shows what it would change.

Open Claude Code in the folder once and accept the workspace trust dialog. Until you do, Claude Code ignores the project's `permissions.allow` entries.

### 3. About the Claude Code plugin

You do not need the plugin. `nativ setup` writes the same agents, enforcement hook and MCP entry into your project, and also the permission rules that deny `nativ task unlock` and `nativ db sync`, block reading `.env*` files, and make Claude Code ask before any write under `.ai/`. **A plugin cannot ship permission rules**, so `nativ setup` is the complete route.

The plugin files ship inside the package (`plugin/`). To try them for a single Claude Code session, point `claude --plugin-dir` at that folder under your global `node_modules` (`npm root -g` prints its location).

### 4. Work

1. Ask Claude to use the **architect** agent to design your contracts. It stops for your approval after the database schema, then the API, then the UI. Claude Code asks you to confirm every write under `.ai/`.
2. Ask Claude to run `nativ task next` and delegate each task to a **worker** agent. It works only inside the task's `targetFiles`, verifies, and completes.
3. Ask for a **verifier** pass before you call a milestone done.

### 5. Keep it healthy

```bash
nativ doctor          # checks the MCP server, hooks, permissions, agents, providers
nativ doctor --fix    # repairs what it can, idempotently
```

Run it after updating Claude Code or nativ. It also asks Claude Code itself whether the `nativ` server connects, and warns when a `nativ` server registered in your user or local scope is shadowing the project's.

### 6. Update

```bash
npm install -g @njeybe/nativ@latest
nativ update                      # in each project
nativ doctor
```

`nativ update` refreshes the directives, role guides, agents and hooks that nativ wrote and you have not edited. Anything you edited is kept and reported; `nativ update --force` replaces it. It never touches your contracts (`.ai/db_schema.json`, `.ai/api_contracts.json`, `.ai/ui_specs.md`, `.ai/master_plan.json`, `.ai/context.md`). See [CHANGELOG.md](CHANGELOG.md) before upgrading across a major version.

---

## Role enforcement

`nativ hook check` runs before every `Write`, `Edit`, `MultiEdit` and `NotebookEdit`. It looks at three things:

| Rule | Applies to | Meaning |
| :--- | :--- | :--- |
| `out_of_scope` | Workers and the project manager | The file is not in the active task's `targetFiles` (exact files, directories with a trailing `/`, and `*`/`**` globs) |
| `protected_path` | Everyone but the architect | Anything under `.ai/` |
| `secret_path` | Everyone, architect included | `.env`, `.env.*` (not `.env.example`), `.nativ/*.local.json`, `*.pem`, `*.key` |

Who is the architect? Inside a subagent, Claude Code reports the agent's name, so the `architect` agent (or the plugin's `nativ:architect`) is recognised. For a whole session, start it with `NATIV_ROLE=architect`.

**Modes** (`"enforcement"` in `.nativ/config.json`, or `nativ setup --enforcement <mode>`):

| Mode | Behaviour |
| :--- | :--- |
| `warn` (default) | The write goes through, the agent is told why it is out of scope, and the violation is logged to `.ai/telemetry.json` |
| `block` | The write is denied with the reason |
| `off` | No checks |

Start in `warn`, look at the log, then switch to `block`. If a task genuinely needs to leave its scope, `nativ task unlock <taskId>` lifts the scope rule for that task (contracts and secrets stay protected) and `--revoke` restores it. Unlock is a CLI command on purpose: it is not an MCP tool, so an agent cannot remove its own guardrail.

`nativ hook status` shows the mode, the role and the active task's scope. Two limits to know: the hook watches the file-editing tools, not shell commands (`sed -i` or a redirect can still write a file), and it fails open, so a broken payload never stops your work. The permission rules that `nativ setup` writes add a second layer.

---

## Design-first planning, task fields and model routing

**Planning levels.** The `.ai/ui_specs.md` template opens with a planning level: Quick (small fix, no design phase), Standard (new screen in an existing design) or Full (new app or redesign). It then walks through the design brief, users and top tasks, real content samples, user flows, design directions with a style tile, wireframes, a component map and one section per component. The architect and frontend/flutter guides were trimmed to match.

**UI/UX design enhancements.** The template supports two intake approaches: Experience-First (start with user flows and wireframes) or Data-First (start with entity relationships and table schemas), both leading to the same component map. The component map now organizes components into semantic trees reflecting their roles in the interface (layout, data display, input, feedback, navigation). Style tiles are stack-aware, showing platform-specific token variants for web breakpoints and Flutter platform adaptations. Typography is specified in context with font scales per platform and semantic role, mapped directly to components. Every interactive element and input carries a mutation state spec: default, hover, focus, disabled, loading, error and success states, documented in wireframe notes and component sections.

**Optional task fields.** A task can carry `specRefs` (anchors such as `ui_specs.md#appointment-list`), `complexity` (`simple`, `standard` or `complex`) and `acceptanceCriteria` ("done when" lines):

```bash
nativ task add "Appointment list" -a frontend --complexity standard   --spec-refs "ui_specs.md#appointment-list" --accept "Empty state shown|Rows sorted by time"
```

`--accept` can be repeated or `|`-separated. The `nativ_task_add` MCP tool takes the same three fields.

**Spec slices.** For a task with `specRefs`, `nativ task next --json` adds `specSlices` (the referenced heading sections or JSON pointers, size-capped) and `specWarnings` (a ref that is missing or outside `.ai/`). The native run engine puts the same slices in a `<spec_slices>` block of the worker prompt, and `nativ validate` prints the warnings for the whole plan. Workers read a whole contract only when a slice is missing or cut short.

**Model routing.** `nativ task next --json` returns `recommendedModel` from the task's `complexity`: `simple` gives `haiku`, `standard` gives `sonnet`, `complex` gives `opus`. A task with no complexity gets no recommendation and nothing changes. Override the mapping with `workerModels` in `.nativ/config.json`:

```json
{ "workerModels": { "simple": "haiku", "standard": "sonnet", "complex": "opus" } }
```

The run engine uses the routed model when you did not pass one explicitly, and the project manager passes `recommendedModel` as the `model` parameter of the Agent tool. These are Claude Code model aliases, so a Claude Pro login is enough and no API key is needed.

**Code style.** `AGENTS.md` gives workers short style rules: lines of 100 characters or fewer (hard maximum 120), functions of about 40 lines, files of about 300, comments of at most 2 lines, and your own formatter config wins. `nativ verify` also runs a check on a task's target files for over-long lines and long comment blocks. It only warns by default. Tune it with `codeStyle` in `.nativ/config.json` (`mode`: `warn`, `block` or `off`; `maxLineLength`, default 120; `maxCommentLines`, default 2). The `nativ task complete` gatekeeper runs it too, warn-only.

---

## Providers

nativ's own model calls (currently triage of escalations) go through one adapter, so no single vendor is on the critical path.

Default order: `claude-cli`, `claude-api`, `gemini`, then a deterministic rules engine.

| Provider | Needs | Notes |
| :--- | :--- | :--- |
| `claude-cli` | Claude Code signed in | Runs `claude -p` with your subscription login. No API key. Uses Haiku by default, with all tools disabled, from an empty working directory |
| `claude-api` | `ANTHROPIC_API_KEY` | Anthropic SDK |
| `gemini` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | The key is sent in a header, never the URL |

If a provider reports a rate or usage limit, nativ remembers it in `.nativ/provider-state.json` and skips that provider until the limit resets, so a limit costs seconds, not a long wait. If nothing is available, triage still answers from the offline rules engine. Prompts pass through secret redaction before leaving the machine.

Choose providers and models per role in `.nativ/config.json`:

```json
{
  "enforcement": "warn",
  "providers": { "triage": ["claude-cli", "gemini"] },
  "models": { "claude-cli": "haiku", "gemini": "gemini-3.8-flash" }
}
```

Roles are `architect`, `pm`, `worker`, `verifier` and `triage`. Adding a vendor means adding one file under `src/providers/`.

---

## CLI reference

### Setup and health

```bash
nativ init                       # scaffold .ai/ and run setup
nativ setup [--dry-run] [--enforcement warn|block|off] [--command "npx -y @njeybe/nativ"] [--force]
nativ doctor [--fix] [--no-deep] [--json]
nativ hook status [--json]       # enforcement mode, role, active task scope
```

### Task management and JIT context slicing

```bash
nativ task next                  # next executable task and its contract slice
nativ task list --available
nativ task list --milestone m1 --status pending
nativ task add "Implement OAuth2 callback" -a backend -v "npm test" -f "src/auth.ts"
nativ task add "Login form" -a frontend --complexity simple --spec-refs "ui_specs.md#login-form" --accept "Errors shown inline"
nativ task start task-01
nativ task complete task-01                # runs the verification command
nativ task complete task-01 --timeout 600000   # for slow suites
nativ task block task-01 --reason "Missing Stripe API key"
nativ task escalate task-01 --type schema_flaw --details "Missing foreign key on orders table"
nativ task propose-patch task-01 --target db_schema --op ADD --path users.columns.bio --reason "..."
nativ task unlock task-01 --reason "refactor touches a shared file"   # emergency; --revoke to re-lock
nativ triage                     # evaluate pending escalations; decision cards for the human
```

### Verification

```bash
nativ verify task-01
nativ verify --all
nativ verify --milestone m1 --timeout 60000 --json
```

### Status and telemetry

```bash
nativ status
nativ status --telemetry         # durations, token estimates, cost estimates, pass rates, role violations
nativ status --json
```

### Benchmarks

```bash
nativ bench
nativ bench --scenario concurrency --concurrency 8
nativ bench --json
```

### Database studio and schema telemetry (masked, structure only)

```bash
nativ db status
nativ db inspect --env dev
nativ db diff --target contract --exit-code
nativ studio                     # local dashboard at http://localhost:4983
```

### Git worktree sandboxing

```bash
nativ worktree create task-01
nativ worktree list
nativ worktree merge task-01     # Safe Merge Gatekeeper enforced
nativ worktree remove task-01
```

---

## Contract Governor

A deterministic firewall between agents and the contracts (`.ai/db_schema.json`, `.ai/api_contracts.json`):

```
            An agent proposes a contract change
                          |
                          v
                 [ Contract Governor ]
                          |
        +-----------------+------------------+
        v                                    v
 LOW_ADDITIVE                          HIGH_DESTRUCTIVE
 new nullable columns, new tables,     dropping tables or columns,
 optional params, new response fields  changing column types, dropping
                                       routes, new required params
        |                                    |
        v                                    v
 auto-approved and patched             rejected with a structured
 atomically                            violation; three strikes trip the
                                       circuit breaker and log an escalation
```

---

## Concurrency

`.ai/master_plan.json` and `.ai/telemetry.json` are protected by OS-level advisory file locks (`proper-lockfile`) with atomic read-modify-write and retry backoff for Windows `EBUSY`/`EPERM`. Several agents in separate terminals can start, complete and add tasks without lost updates. Long verification commands run outside the lock.

Parallel agents share your Claude usage limit. Two or three at a time is a sensible default on a subscription.

---

## Telemetry

Task transitions and role violations are recorded in `.ai/telemetry.json`: durations, token estimates priced with the model table in `src/core/telemetry.ts`, verification pass rates, circuit-breaker trips, and (capped at the latest 200) enforcement violations with the rule, mode, tool, project-relative path and task. File contents are never logged.

---

## MCP server

`nativ mcp` speaks the Model Context Protocol over stdio. `nativ setup` registers it for Claude Code; the same server works with Cursor, Claude Desktop and Antigravity.

| Tool / resource | Description |
| :--- | :--- |
| `nativ_task_next`, `nativ_task_list`, `nativ_task_add` | Find and add work |
| `nativ_task_start`, `nativ_task_complete`, `nativ_task_block` | Move a task through its lifecycle (complete runs the gatekeeper and refuses skipVerify) |
| `nativ_task_escalate`, `nativ_task_propose_patch` | Escalate a contract gap, or propose a governed patch |
| `nativ_verify`, `nativ_bench`, `nativ_status` | Verification, benchmarks, progress |
| `nativ_worktree_*` | Create, list, merge and remove task worktrees |
| `nativ_db_status`, `nativ_db_inspect`, `nativ_db_diff` | Masked, structure-only database telemetry |
| `nativ_doctor` | Read-only health report. Repairs are `nativ doctor --fix` in a terminal |
| `nativ://context`, `nativ://master-plan`, `nativ://db-schema`, `nativ://api-contracts`, `nativ://escalation`, `nativ://telemetry` | Read-only resources |

There is deliberately no MCP tool to unlock a task, write a contract, sync a database schema or run setup.

Manual registration, if you prefer:

```bash
claude mcp add nativ -- nativ mcp
```

```json
{
  "mcpServers": {
    "nativ": { "command": "npx", "args": ["-y", "@njeybe/nativ", "mcp", "/absolute/path/to/project"] }
  }
}
```

---

## Repository structure

```
nativ/
  bin/cli.js               entry point (a fast path serves the hook commands without loading the whole CLI)
  src/
    index.ts               command registry
    commands/              init, setup, doctor, hook, task, verify, worktree, db, triage, ...
    core/                  enforcement, setup-assets, tier1-liaison, telemetry, lock-manager, verifier, ...
    providers/             claude-cli, claude-api, gemini, registry (fallback chain and cooldown)
    governor/              contract evaluator, circuit breaker, rules
    mcp/server.ts          MCP server
    db/                    masked env parser, introspection, schema diff
    server/                Studio web dashboard
    runner/                agent supervisor
  templates/               AGENTS.md, CLAUDE.md, GEMINI.md, claude-agents/, dot-ai/
  plugin/                  Claude Code plugin (generated by `npm run sync-plugin`)
  .claude-plugin/          marketplace entry for the plugin
  scripts/sync-plugin.mjs  renders plugin/ from the same sources as `nativ setup`
  tests/                   regression suites (`npm test`)
```

Changed a template or the setup generator? Run `npm run sync-plugin`; a test fails if `plugin/` is out of date.

---

## License

MIT (c) JB Natividad. See [LICENSE](LICENSE).
