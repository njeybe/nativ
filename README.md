# nativ

**A role-based workflow harness for AI coding agents.** nativ keeps your design contracts, the task plan and the guardrails in your repository, so the same rules hold whichever agent or model does the work. Claude Code is the default; other agents plug in through `AGENTS.md` and MCP.

[![npm](https://img.shields.io/npm/v/@njeybe/nativ)](https://www.npmjs.com/package/@njeybe/nativ)
![node](https://img.shields.io/badge/node-%3E%3D20-339933)
![license](https://img.shields.io/badge/license-MIT-blue)

```bash
npm install -g @njeybe/nativ     # the package is @njeybe/nativ, the command is nativ
cd your-project && nativ init    # scaffold .ai/ and the Claude Code configuration
```

---

## Contents

| Start here | Command reference | Reference |
| :--- | :--- | :--- |
| [Why nativ](#why-nativ) | [Command map](#command-map) | [Configuration](#configuration) |
| [Quick start](#quick-start) | [Setup and health](#setup-and-health) | [Guardrails](#guardrails) |
| [How it works](#how-it-works) | [Tasks](#tasks) | [Files nativ manages](#files-nativ-manages) |
| [Everyday workflow](#everyday-workflow) | [Verification](#verification) | [MCP server](#mcp-server) |
| | [Learnings](#learnings) | [Providers](#providers) |
| | [Escalations and triage](#escalations-and-triage) | [Concurrency and telemetry](#concurrency-and-telemetry) |
| | [Database](#database) | [Troubleshooting](#troubleshooting) |
| | [Worktrees](#worktrees) | [For maintainers](#for-maintainers) |
| | [Studio, tests and benchmarks](#studio-tests-and-benchmarks) | |

---

## Why nativ

- **Contracts, not chat.** `.ai/db_schema.json`, `.ai/api_contracts.json` and `.ai/ui_specs.md` are the source of truth. Workers build against them and escalate gaps instead of improvising.
- **Boundaries enforced by code.** A Claude Code hook checks every file write against the active task, the protected contracts and your secret files. It does not rely on the model remembering a rule.
- **Independent verification.** A gatekeeper re-runs each task's checks before it can complete, and a separate verifier agent reviews the result.
- **Adaptive ceremony.** Shift seamlessly between `prototype` velocity, balanced `solo` defaults, and strict `enterprise` compliance (`nativ profile`).
- **A project that remembers.** Settled escalations and human-approved lessons travel with later tasks, so the same gap is not raised twice.
- **Zero-credential air-gap.** Agents see database structure, never passwords, connection strings or rows.

---

## Quick start

**1. Install.** You need Node.js 20 or newer and Git. More options are in [docs/installation.md](docs/installation.md).

```bash
npm install -g @njeybe/nativ
nativ --version
```

**2. Set up a project.** `init` scaffolds `.ai/` and runs `setup`, which writes the Claude Code configuration. Setup merges: it never overwrites your own settings, hooks, MCP servers or edited files.

```bash
cd your-project
nativ init
nativ doctor          # confirm everything is wired
```

**3. Trust the folder.** Open Claude Code in the project once and accept the workspace trust dialog. Until you do, Claude Code ignores the project's `permissions.allow` entries.

**4. Ask Claude to work.** On existing code, start with the explorer; then the architect designs, workers build, and the verifier checks. See [Everyday workflow](#everyday-workflow).

> **About the Claude Code plugin.** The package also ships a plugin (`plugin/`), but you do not need it: a plugin cannot ship permission rules, so `nativ setup` is the complete route. To try the plugin for one session, point `claude --plugin-dir` at that folder under your global `node_modules` (`npm root -g` prints it).

---

## How it works

Four roles, plus a read-only explorer for existing code. Each one has a single job and hands a
concrete result to the next.

```
┌──────────────────────────────────────┐
│  EXPLORER                            │
│  maps the existing code              │
└───────────────────┬──────────────────┘
                    │  codebase map
                    ▼
┌──────────────────────────────────────┐
│  ARCHITECT                           │  ◀── you approve each step
│  designs the contracts               │
└───────────────────┬──────────────────┘
                    │  contracts + task plan
                    ▼
┌──────────────────────────────────────┐
│  PROJECT MANAGER                     │
│  hands out one task at a time        │
└───────────────────┬──────────────────┘
                    │  one task + only its context
                    ▼
┌──────────────────────────────────────┐
│  WORKERS                             │
│  build inside the task's files       │
└───────────────────┬──────────────────┘
                    │  finished change
                    ▼
┌──────────────────────────────────────┐
│  VERIFIER                            │
│  checks the result independently     │
└──────────────────────────────────────┘
```

| Role | Job | Runs on | Never |
| :--- | :--- | :--- | :--- |
| **Explorer** | Maps components, routes, models, conventions and drift from the contracts. Has only Read, Grep and Glob | Sonnet · Haiku for quick lookups | Edits, designs or decides |
| **Architect** | Designs the database, API and UI contracts; resolves escalations | Opus | Writes application code |
| **Project Manager** | Runs the task loop, delegates, reports back to you | Your main Claude Code session | Edits contracts or does tasks itself |
| **Workers** | Build one task each: backend, frontend, database, QA, Flutter, DevOps, security, migration | Picked per task: Haiku, Sonnet or Opus | Touch files outside the task, or contracts |
| **Verifier** | Reruns the checks and reviews the diff against the contracts | Haiku | Edits anything |

- **One rulebook.** Every agent follows `AGENTS.md`; `CLAUDE.md` and `GEMINI.md` point at it.
- **The project manager starts everyone else.** Subagents cannot start other subagents, so it
  runs the explorer, the workers and the verifier.
- **Swap any model or vendor.** The roles are fixed; what runs behind them is configurable.

---

## Everyday workflow

| Step | You ask Claude to... | What happens |
| :--- | :--- | :--- |
| 1. Explore | run the **explorer** (existing code only) | A map of components, routes, models and conventions, plus drift from the contracts. The architect saves it as `.ai/codebase_map.md`. |
| 2. Design | use the **architect** | Experience-First or Data-First track, design brief, style tiles, wireframes, component map. It stops for your approval after each contract. |
| 3. Plan | let the architect add tasks | Each task has `targetFiles`, `acceptanceCriteria`, `specRefs` and a `complexity` that picks the worker's model. |
| 4. Build | run `nativ task next` and delegate to a **worker** | The worker gets only what it needs: contract slices, settled escalations and approved lessons. |
| 5. Check | let the worker complete the task | The gatekeeper runs your verify phases, then the task's command, then a code-style check. |
| 6. Review | ask for a **verifier** pass | An independent read of the diff against the contracts. |
| 7. Improve | approve lessons agents proposed | `nativ learn list --status proposed`, then `approve` or `reject`. |

---

## Command reference

Every command takes an optional `[targetDir]` (default: the current directory) and most accept `--json` for scripting. Run `nativ <command> --help` for the full option list.

### Command map

**Who** says who should run it: **You** in a terminal, an **Agent** (directly or through MCP), or a Claude Code **Hook**. Commands marked *You only* refuse to run without an interactive terminal, and the permission rules `nativ setup` writes also deny them to agents.

| Command | What it does | Who |
| :--- | :--- | :--- |
| [`init`](#nativ-init) | Scaffold `.ai/` and the Claude Code configuration | You |
| [`setup`](#nativ-setup) | Write or merge the Claude Code configuration | You |
| [`profile`](#nativ-profile) | Inspect or switch ceremony profile (`prototype`, `solo`, `enterprise`) | You, Agent |
| [`doctor`](#nativ-doctor) | Check the integration and the harness; `--fix` repairs | You, Agent (read-only) |
| [`update`](#nativ-update) | Refresh directives, role guides and agents to the latest templates | You |
| [`validate`](#nativ-validate) | Check the contracts and role guides are well formed | You, Agent |
| [`status`](#nativ-status) | Progress and telemetry | You, Agent |
| [`hook status`](#nativ-hook) | Enforcement mode, role and active task scope | You, Agent |
| [`task next`](#nativ-task-next) | The next executable task with its context | Agent |
| [`task list`](#nativ-task-list) / `tasks` | List tasks with filters | You, Agent |
| [`task add`](#nativ-task-add) | Add a task | Architect |
| [`task start`](#nativ-task-start) | Mark a task in progress | Agent |
| [`task reclaim`](#nativ-task-reclaim) | Free tasks left in progress by a stopped agent | You, Agent |
| [`task complete`](#nativ-task-complete) | Complete a task through the gatekeeper | Agent |
| [`task block`](#nativ-task-block) | Block a task with a reason | Agent |
| [`task escalate`](#nativ-task-escalate) | Escalate a contract gap to the architect | Agent |
| [`task propose-patch`](#nativ-task-propose-patch) | Propose a governed contract change | Agent |
| [`task unlock`](#nativ-task-unlock) | Lift a task's file scope in an emergency | *You only* |
| [`verify`](#nativ-verify) | Run verification for a task, a milestone or all | You, Agent |
| [`learn propose`](#nativ-learn-propose) | Propose a lesson for later workers | Agent |
| [`learn list`](#nativ-learn-list) | List lessons | You, Agent |
| [`learn approve` / `reject`](#nativ-learn-approve--reject) | Decide on a lesson | *You only* |
| [`triage`](#nativ-triage) | Evaluate pending escalations; decision cards for you | You |
| [`notify test`](#nativ-notify-test) | Check the webhook or command that tells you a decision is waiting | You |
| [`db status` / `inspect` / `diff`](#nativ-db-status--inspect--diff) | Masked, structure-only database checks | You, Agent |
| [`db sync`](#nativ-db-sync) | Copy a live schema into `.ai/db_schema.json` | *You only* |
| [`worktree create` / `list` / `merge` / `remove`](#nativ-worktree) | Isolated worktrees for parallel tasks | You, Agent |
| [`studio`](#nativ-studio) / `db ui` | Local dashboard at <http://localhost:4983> | You |
| [`test gen`](#nativ-test-gen) | Generate contract and database tests | You, Agent |
| [`bench`](#nativ-bench) | Synthetic benchmarks | You, Agent |
| [`mcp`](#nativ-mcp) | Run the MCP server over stdio | Claude Code |
| `hook check` / `hook context` | PreToolUse and SessionStart hooks | Hook |

[Back to contents](#contents)

---

### Setup and health

#### `nativ init`

Scaffold the workflow (`.ai/`, `AGENTS.md`, directives), scan the stack into `.ai/context.md`, then run `setup`.

```bash
nativ init [targetDir] [-f, --force]
```

| Option | Description |
| :--- | :--- |
| `-f, --force` | Overwrite existing specification and directive files |

#### `nativ setup`

Write the Claude Code configuration: `.mcp.json`, `.claude/settings.json` (permissions and hooks), `.claude/agents/`, `AGENTS.md` and `.nativ/config.json`. Safe to run any number of times.

```bash
nativ setup [targetDir] [options]
```

| Option | Description |
| :--- | :--- |
| `--command <cli>` | How Claude Code should start nativ, e.g. `"npx -y @njeybe/nativ"` (default: `nativ` when installed globally) |
| `--enforcement <mode>` | `warn` (default), `block` or `off` |
| `--dry-run` | Show what would change without writing |
| `-f, --force` | Also replace agent and directive files you edited |
| `--json` | Output the result as JSON |

#### `nativ profile`

Inspect or switch the active ceremony profile. Profiles adapt the rigor of the gatekeeper, governor, and enforcement hooks to the stage of your project:

- `prototype`: Maximum velocity for hackathons and spikes. Auto-adopts additive contract patches, relaxes test-integrity guards, and warns on style/scope violations.
- `solo`: Balanced defaults for solo developers and small teams (default). Enforces task file scope, requires verification commands, but uses lightweight reviews.
- `enterprise`: Maximum governance for high-stakes production code. Strict blocking enforcement, mandatory verification phases, required test integrity, and strict human review.

```bash
nativ profile [profile] [targetDir] [options]
```

```bash
nativ profile                         # Show current profile and resolved settings
nativ profile solo                    # Switch to the solo profile
nativ profile enterprise --json       # Switch and return config as JSON
```

| Option | Description |
| :--- | :--- |
| `--json` | Output current or updated profile configuration as JSON |

#### `nativ doctor`

Check the integration for drift (MCP server, hooks, permissions, agents, providers) and the harness itself: settings that switch the guardrails off (`disableAllHooks`, `bypassPermissions`), credentials in files agents read (file and line only), roles with no guide, and lessons waiting for approval.

```bash
nativ doctor [targetDir] [options]
```

| Option | Description |
| :--- | :--- |
| `--fix` | Repair missing or out-of-date files (runs setup) |
| `--command <cli>` | How Claude Code should start nativ (see `setup`) |
| `--no-deep` | Skip asking Claude Code (`claude mcp list`) whether the server connects |
| `--json` | Output the report as JSON |

Run it after updating Claude Code or nativ.

#### `nativ update`

Refresh directives, role guides, agents and hooks that nativ wrote and you have not edited. Edited files are kept and reported. Contracts and the plan (`db_schema.json`, `api_contracts.json`, `ui_specs.md`, `master_plan.json`, `context.md`) are never touched.

```bash
npm install -g @njeybe/nativ@latest
nativ update [targetDir] [-f, --force]     # --force also replaces files you edited
nativ doctor
```

Read the [CHANGELOG](CHANGELOG.md) before upgrading across a major version.

#### `nativ validate`

Check that every `.ai/` contract parses and has the expected shape, that role guides exist, and that each task's `specRefs` resolve.

```bash
nativ validate [targetDir]
```

#### `nativ status`

Progress per milestone; with `--telemetry`, durations, token and cost estimates, pass rates and role violations.

```bash
nativ status [targetDir] [-t, --telemetry] [--json]
```

#### `nativ hook`

```bash
nativ hook status [targetDir] [--json]    # enforcement mode, role and active task scope
nativ hook check                          # PreToolUse hook (reads the tool call from stdin)
nativ hook context                        # SessionStart hook (prints orientation)
```

`check` and `context` are wired by `setup`; you do not run them by hand.

[Back to contents](#contents)

---

### Tasks

The task lifecycle lives in `.ai/master_plan.json`. Never edit it by hand; these commands lock it, so parallel agents never lose updates.

```
 pending ──start──> in_progress ──complete (gatekeeper passes)──> completed
                         │
                         ├──block──────> blocked
                         └──escalate───> blocked  ──(architect resolves)──> pending
```

#### `nativ task next`

The next executable task in the active milestone: an in-progress task first, otherwise the first pending task whose dependencies are done.

```bash
nativ task next [targetDir] [--json]
```

With `--json`, the task carries everything a worker needs:

| Field | Contents |
| :--- | :--- |
| `roleGuide`, `recommendedContractSlice` | Which guide and which contracts the role reads |
| `recommendedModel` | `haiku`, `sonnet` or `opus`, from the task's `complexity` |
| `specSlices`, `specWarnings` | The referenced contract sections, size-capped, and any refs that did not resolve |
| `priorEscalations` | The task's settled escalations with their resolution notes (last 3) |
| `learnings` | Approved lessons that fit the task's role and files (at most 5) |

#### `nativ task list`

```bash
nativ task list [targetDir] [options]      # also available as: nativ tasks
```

| Option | Description |
| :--- | :--- |
| `-a, --available` | Only unblocked tasks ready to run |
| `-s, --status <status>` | `pending`, `in_progress`, `completed` or `blocked` |
| `-m, --milestone <id>` | Milestone ID or name |
| `--fast-path` | Only fast-path tasks |
| `--json` | Output as JSON |

#### `nativ task add`

Append a task with an auto-incremented ID.

```bash
nativ task add <title> [targetDir] [options]
```

| Option | Description |
| :--- | :--- |
| `-a, --agent <name>` | Role: `backend` (default), `frontend`, `database`, `qa-tester`, `flutter-developer`, `devops-agent`, `security-auditor`, `db-migration` |
| `-f, --files <paths>` | Comma-separated target files: exact files, `dir/`, or `*` / `**` globs |
| `-v, --verify <command>` | Verification command the gatekeeper runs |
| `-d, --description <text>` | Task description |
| `-m, --milestone <id>` | Target milestone (default: the active one) |
| `--deps <ids>` | Comma-separated dependency task IDs |
| `--spec-refs <refs>` | Contract anchors, e.g. `ui_specs.md#appointment-list` or `api_contracts.json#GET /appointments` |
| `--complexity <level>` | `simple`, `standard` or `complex` (routes the worker's model) |
| `--accept <text>` | "Done when" line; repeatable or `\|`-separated |
| `--fast-path` | Route to the fast-path milestone for quick fixes |
| `--json` | Output the created task as JSON |

```bash
nativ task add "Appointment list" -a frontend --complexity standard \
  --spec-refs "ui_specs.md#appointment-list" \
  --accept "Shows name and time per row" --accept "Empty and error states shown" \
  -f src/components/AppointmentList.tsx --deps task-3 -v "npm test"
```

#### `nativ task start`

```bash
nativ task start <taskId> [targetDir] [--agent <id>] [--force]
```

Claims the task, marks it `in_progress` and records the baseline the test-integrity guard compares against. The task must be pending and its dependencies completed; a blocked task goes through `nativ triage` first, and only a person can override with `--force`. The claim records `claimedBy` (`--agent` or `$NATIV_AGENT_ID`) and `claimedAt`, so a parallel agent cannot take a task another agent holds. Running `task start` again on your own task refreshes the claim; a claim older than 4 hours counts as abandoned.

#### `nativ task reclaim`

```bash
nativ task reclaim [taskId] [targetDir] [--older-than <hours>] [--dry-run] [--json]
```

Puts `in_progress` tasks whose agent stopped (a crash or a closed session) back to `pending`. Without a task id it reclaims every claim older than `--older-than` hours (default 4). Tasks started before claims were recorded have no claim time; name them to reclaim them. A fresh claim is refused unless a person passes `--force`. The SessionStart orientation lists stale tasks. The previous agent may have left partial changes, so review the working tree before restarting.

#### `nativ task complete`

Runs the [verification gatekeeper](#verification) and completes the task only if it passes. A change that deletes or weakens tests is refused.

```bash
nativ task complete <taskId> [targetDir] [options]
```

| Option | Description |
| :--- | :--- |
| `-n, --notes <notes>` | Completion notes |
| `--timeout <ms>` | Verification timeout (default 120000) |
| `--no-verify` | Skip verification. *You only*: needs an interactive terminal, is denied to agents, and the MCP tool refuses it |

#### `nativ task block`

```bash
nativ task block <taskId> [targetDir] -r "Verification failed after 3 attempts: <short error>"
```

#### `nativ task escalate`

Record a contract gap in `.ai/escalation.json` and block the task until the architect resolves it.

```bash
nativ task escalate <taskId> [targetDir] -t <type> -d "what is missing" [-a <contracts>]
```

| Option | Description |
| :--- | :--- |
| `-t, --type <type>` | `contract_drift`, `schema_flaw`, `missing_credential`, `dependency_conflict` or `architectural_ambiguity` |
| `-d, --details <text>` | What is missing |
| `-a, --affected <list>` | Comma-separated affected contracts |

#### `nativ task propose-patch`

Propose a small contract change through the [Contract Governor](#contract-governor): additive changes are applied, destructive ones are rejected.

```bash
nativ task propose-patch <taskId> --target db_schema --op ADD \
  --path users.columns.bio --value '{"type":"text","nullable":true}' -r "profile bio"
```

| Option | Description |
| :--- | :--- |
| `--target <target>` | `db_schema` or `api_contracts` (required) |
| `--op <op>` | `ADD`, `ALTER`, `DROP` or `RENAME` (required) |
| `--path <path>` | Dot or pointer path, e.g. `users.columns.status` (required) |
| `--value <json>` | Value or schema definition |
| `-r, --reason <text>` | Why (required) |
| `--base-hash <hash>` | Reject if the contract changed since this hash |
| `--json` | Output the verdict as JSON |

#### `nativ task unlock`

*You only, in an interactive terminal.* Lift the file-scope rule for one task when it genuinely must leave its `targetFiles`. Contracts and secrets stay protected. `--revoke` re-locks and works anywhere.

```bash
nativ task unlock <taskId> [targetDir] -r "refactor touches a shared file"
nativ task unlock <taskId> --revoke
```

[Back to contents](#contents)

---

### Verification

#### `nativ verify`

Re-run verification for one task, a milestone or every completed task. Also available as `nativ task verify`.

```bash
nativ verify task-01
nativ verify --milestone m1 --timeout 60000
nativ verify --all --json
```

| Option | Description |
| :--- | :--- |
| `-a, --all` | Every completed task |
| `-m, --milestone <id>` | Every task in a milestone |
| `--timeout <ms>` | Per command (default 120000) |
| `--json` | Output as JSON |

**What runs, in order** (the same for `verify`, the `task complete` gatekeeper and Studio dispatch):

1. **Verify phases** from `.nativ/config.json`, in order, stopping at the first failure. A failure names the phase.
2. The task's own `verificationCommand`.
3. The **code-style check** on the task's target files (warn-only unless `codeStyle.mode` is `block`).

```json
{ "verifyPhases": [
  { "name": "types", "run": "npx tsc --noEmit" },
  { "name": "lint", "run": "npm run lint" }
] }
```

With no phases configured, verification is just the task's command and the style check. The settings always come from the main checkout, never a task worktree's copy. If `.nativ/config.json` cannot be read, or a phase has no `name` or `run`, verification fails with a clear message instead of skipping the checks.

[Back to contents](#contents)

---

### Learnings

Lessons from earlier tasks that the contracts do not capture: a setup quirk, a library gotcha, a convention. Agents propose; only you approve. Stored in `.ai/learnings.json`.

#### `nativ learn propose`

```bash
nativ learn propose "<one-line insight>" [targetDir] [options]
```

| Option | Description |
| :--- | :--- |
| `--role <role>` | Only workers with this role see it |
| `--files <globs>` | Comma-separated files, `dir/` or globs; only tasks touching them see it |
| `--task <taskId>` | The task where it came up |
| `-d, --details <text>` | Longer explanation |
| `--by <who>` | Who proposed it (default: `NATIV_ROLE`) |
| `--json` | Output the stored lesson as JSON |

```bash
nativ learn propose "Set the date picker locale before it mounts" \
  --role frontend --files "src/components/forms/" --task task-12
```

#### `nativ learn list`

```bash
nativ learn list [targetDir] [-s, --status proposed|approved|rejected] [--role <role>] [--json]
```

#### `nativ learn approve` / `reject`

*You only, in an interactive terminal.* Both show the full lesson (insight, details, scope) and ask you to confirm; `-y` skips the question but not the terminal check, so a headless agent cannot run them.

```bash
nativ learn approve learn-01 [-n "confirmed on two tasks"] [-y]
nativ learn reject learn-02 [-n "one-off, not a rule"] [-y]
```

If the lesson changed while you were reviewing it, nothing is decided and you are asked to run the command again. `.ai/learnings.json` is protected like the contracts: the hook flags agent edits and Claude Code asks you before any write under `.ai/`. An approved lesson travels with `nativ task next` to the tasks it fits: lessons scoped to the task's files first, then to its role, then project-wide ones, at most five.

[Back to contents](#contents)

---

### Escalations and triage

A worker that finds a contract gap escalates (`nativ task escalate`) and stops. The gap is then resolved by the architect, or first assessed by triage. [docs/self-healing.md](docs/self-healing.md) walks through the whole hands-free loop: claims, retries, triage, reclaiming stuck tasks and notifications.

#### `nativ triage`

Run the strategist (Claude by default, see [Providers](#providers)) on pending escalations: it proves safe additive fixes in a sandbox, or gives you a four-part decision card (what the user would see, why, what is affected, options).

```bash
nativ triage [escalationId] [targetDir] [options]
```

| Option | Description |
| :--- | :--- |
| `-a, --all` | Triage every pending escalation (report only, no prompts) |
| `--apply` | Write sandbox-proven additive patches and unblock their tasks |
| `--threshold <policy>` | `safe_contracts_only` (default) or `all_non_destructive` |
| `--json` | Output evaluations as JSON (no prompts) |

When an escalation is settled, its resolution notes reach the next worker on that task as `priorEscalations`.

#### `nativ notify test`

nativ can tell you when it needs you: when triage returns `REQUIRE_HUMAN_DECISION`, and when the circuit breaker blocks a task. Each escalation is announced once. Add a webhook (Slack, Discord, ntfy or any JSON endpoint) or a local command to `.nativ/config.json`, which git ignores, so a webhook token stays on your machine:

```json
{ "notify": { "webhook": "https://hooks.slack.com/services/...", "events": ["human_decision", "circuit_breaker_tripped"] } }
```

The webhook receives JSON with `text` (Slack, ntfy), `content` (Discord), and the task, escalation, question, options and next step as fields. Webhooks must use `https://` (plain `http://` only to `localhost`). A `"command"` receives the same JSON on stdin and in `NATIV_NOTIFY_JSON`, e.g. `"command": "notify-send nativ \"$(jq -r .text)\""`. `nativ notify test` sends a sample; delivery failures never stop the workflow and are recorded in `.nativ/notify-state.json`.

[Back to contents](#contents)

---

### Database

Masked and structure-only: credentials stay inside the local nativ process, and row data is never read. Connections come from your `.env` files; see [Environment variables](#environment-variables).

#### `nativ db status` / `inspect` / `diff`

```bash
nativ db status [--json]                                 # dev/prod health, engine, latency, table count
nativ db inspect [-e dev|prod] [-t <table>] [--json]     # columns, types, keys, indexes
nativ db diff [--target prod|contract] [--exit-code]     # drift; --exit-code fails CI on drift
```

`nativ db diff --target contract` compares the dev database with `.ai/db_schema.json`.

#### `nativ db sync`

*You only.* Copy a live schema (structure only) into `.ai/db_schema.json`. It previews unless `--yes` is given, and `--yes` needs an interactive terminal; changing the contract is an architect decision you approve.

```bash
nativ db sync [-s dev|prod]          # preview
nativ db sync --yes                  # write
```

[Back to contents](#contents)

---

### Worktrees

#### `nativ worktree`

Run independent tasks in parallel, each in its own git worktree with the `.ai/` contracts mounted.

```bash
nativ worktree create <taskId> [--json]
nativ worktree list [--json]
nativ worktree merge <taskId> [-f] [--json]      # Safe Merge Gatekeeper; -f bypasses it
nativ worktree remove <taskId> [-f] [--json]     # alias: cleanup; discards the branch
```

Parallel agents share your Claude usage limit; two or three at a time is a sensible default on a subscription.

[Back to contents](#contents)

---

### Studio, tests and benchmarks

#### `nativ studio`

A local dashboard at <http://localhost:4983> with live updates. It loads nothing from the internet and runs under a strict content security policy. Also available as `nativ db ui`.

```bash
nativ studio [targetDir] [-p, --port <port>] [--no-open]
```

| Page | Shows |
| :--- | :--- |
| **Home** | What needs you, what is running, what just finished |
| **Tasks** | One milestone at a time, newest completed first |
| **Flow** | How the work connects and how the run actually happened |
| **Team** | Each agent's tasks, time and cost |
| **Worktrees, Benchmarks, Database** | Branches, performance and schemas |

Press **Ctrl+K** (or Cmd+K or `/`) to find any task by id, title, agent or file. The theme toggle switches light and dark.

#### `nativ test gen`

Generate API contract and database integrity tests from `.ai/api_contracts.json` and `.ai/db_schema.json`.

```bash
nativ test gen [targetDir] [options]
```

| Option | Description |
| :--- | :--- |
| `-f, --framework <name>` | `vitest` (default), `jest`, `node:test`, `pytest` or `go` |
| `-o, --output <dir>` | Output directory (default `tests/contract`) |
| `-b, --base-url <url>` | Base URL the API suites call (default `http://localhost:3000`) |
| `--dry-run` | Show what would be generated |
| `--json` | Output the result as JSON |

#### `nativ bench`

```bash
nativ bench [-s concurrency|governor|verification|telemetry|e2e|all] [-c <workers>] [-o report.json] [--json]
```

#### `nativ mcp`

Run the MCP server over stdio. `setup` registers it; see [MCP server](#mcp-server).

[Back to contents](#contents)

---

## Configuration

### `.nativ/config.json`

Written by `setup`; every key is optional.

```json
{
  "profile": "solo",
  "enforcement": "warn",
  "workerModels": { "simple": "haiku", "standard": "sonnet", "complex": "opus" },
  "verifyPhases": [{ "name": "types", "run": "npx tsc --noEmit" }],
  "codeStyle": { "mode": "warn", "maxLineLength": 120, "maxCommentLines": 2 },
  "providers": { "triage": ["claude-cli", "gemini"] },
  "models": { "claude-cli": "haiku", "gemini": "gemini-3.8-flash" }
}
```

| Key | Default | Meaning |
| :--- | :--- | :--- |
| `profile` | `solo` | Active ceremony profile: `prototype`, `solo` or `enterprise`. See [`nativ profile`](#nativ-profile) |
| `enforcement` | `warn` | Role enforcement mode: `warn`, `block` or `off`. See [Guardrails](#guardrails) |
| `workerModels` | as above | Model per task `complexity`, returned as `recommendedModel` |
| `verifyPhases` | none | Checks run before every task's own command. See [Verification](#verification) |
| `codeStyle.mode` | `warn` | `warn`, `block` or `off` for the line-length and comment check |
| `codeStyle.maxLineLength` | `120` | Longest allowed line |
| `codeStyle.maxCommentLines` | `2` | Longest allowed comment block |
| `providers` | see [Providers](#providers) | Provider order per role: `architect`, `pm`, `worker`, `verifier`, `triage` |
| `models` | provider default | Model per provider |
| `notify` | off | `webhook`, `command` and `events` for human notifications. See [`nativ notify test`](#nativ-notify-test) |

### Environment variables

| Variable | Used for |
| :--- | :--- |
| `NATIV_ROLE` | Session role; `NATIV_ROLE=architect` lets a whole session write `.ai/` |
| `NATIV_AGENT_ID` | Who claims a task on `task start`, so parallel agents never take the same task |
| `NATIV_NOTIFY_WEBHOOK`, `NATIV_NOTIFY_COMMAND` | Override the `notify` webhook or command from `.nativ/config.json` |
| `ANTHROPIC_API_KEY` | The `claude-api` provider and the Studio native runner |
| `GEMINI_API_KEY` or `GOOGLE_API_KEY` | The `gemini` provider |
| `NATIV_DEV_DATABASE_URL`, `DEV_DATABASE_URL`, `DATABASE_URL` | Dev database for `nativ db`, checked in that order, read from your `.env*` files. MongoDB (`MONGODB_URI`) and Firestore variants work too, and names declared in `.env.example` are checked first |
| `NATIV_PROD_DATABASE_URL`, `PROD_DATABASE_URL`, `DATABASE_URL_PROD` | Prod database for `nativ db`, same rules |

[Back to contents](#contents)

---

## Guardrails

### Role enforcement

`nativ hook check` runs before every `Write`, `Edit`, `MultiEdit` and `NotebookEdit`.

| Rule | Applies to | Meaning |
| :--- | :--- | :--- |
| `out_of_scope` | Workers and the project manager | The file is not in the active task's `targetFiles` |
| `protected_path` | Everyone but the architect | Anything under `.ai/` |
| `protected_path` | Everyone, architect included | Anything under `.nativ/`: the settings decide what the gate runs and how strict the hook is |
| `secret_path` | Everyone, architect included | `.env`, `.env.*` (not `.env.example`), `.nativ/*.local.json`, `*.pem`, `*.key` |

| Mode | Behaviour |
| :--- | :--- |
| `warn` (default) | The write goes through, the agent is told why, and the violation is logged to `.ai/telemetry.json` |
| `block` | The write is denied with the reason |
| `off` | No checks |

Start in `warn`, look at the log, then switch to `block`. Two limits: the hook watches file-editing tools, not shell commands (`sed -i` can still write a file), and it fails open, so a broken payload never stops your work.

### Permission rules

`setup` adds rules that Claude Code enforces even under a broad `nativ *` allow:

| Rule | Effect |
| :--- | :--- |
| Deny `nativ task unlock`, `nativ db sync`, `nativ task complete --no-verify` | Agents cannot lift their own guardrails or rewrite the schema |
| Deny `nativ learn approve`, `nativ learn reject` | Agents cannot approve their own lessons (the commands also refuse to run without a terminal) |
| Deny reading `.env*`, `*.pem`, `*.key` | Secrets stay out of agent context |
| Ask before `Edit` or `Write` under `.ai/` and `.nativ/` | Every contract or settings change needs your yes |

Studio's native runner runs headless, so the terminal-only commands refuse there too. Its editor cannot write `.ai/` or `.nativ/` (in any letter case), and its shell refuses commands that name `.nativ/`. The shell check is a best-effort guard against mistakes, not a sandbox: a worker that runs `node` or other programs can still reach any file the process can. Run untrusted work in a container or VM.

### Air-gap

Credentials exist only in `.env*` files and inside the local nativ process. Agents use the masked, structure-only `nativ db` commands and never read row data. Migrations and destructive changes run only against local or staging databases, and any `[DROPPED]` or `[DESTRUCTIVE]` diff goes to you.

### Contract Governor

A deterministic firewall between agents and the contracts:

```
             An agent proposes a contract change
                           |
                  [ Contract Governor ]
                           |
         +-----------------+------------------+
         v                                    v
  LOW_ADDITIVE                          HIGH_DESTRUCTIVE
  new nullable columns, new tables,     dropping tables or columns,
  optional params, new response fields  changing types, dropping routes,
                                        new required params
         |                                    |
         v                                    v
  applied atomically                    rejected with a structured violation;
                                        three strikes trip the circuit breaker
                                        and log an escalation
```

[Back to contents](#contents)

---

## Files nativ manages

| Path | Written by | Contents |
| :--- | :--- | :--- |
| `AGENTS.md` | setup | The directive every agent follows |
| `CLAUDE.md`, `GEMINI.md` | setup | Pointers to `AGENTS.md` (only created when absent) |
| `.mcp.json` | setup | The `nativ` MCP server entry |
| `.claude/settings.json` | setup | Permission rules and the enforcement and orientation hooks |
| `.claude/agents/` | setup | `architect`, `worker`, `verifier` and `explorer` |
| `.nativ/config.json` | setup | [Configuration](#configuration) |
| `.ai/context.md` | init | Stack scan: runtime, framework, ORM, main folders |
| `.ai/codebase_map.md` | architect, from the explorer | Map of existing code, stamped with the commit it describes |
| `.ai/db_schema.json`, `.ai/api_contracts.json`, `.ai/ui_specs.md` | architect | The contracts |
| `.ai/design/style-tile.html` | architect | The chosen visual direction |
| `.ai/master_plan.json` | `nativ task` commands | Milestones and tasks |
| `.ai/subagents/*.md` | init, update | One guide per worker role |
| `.ai/escalation.json` | `task escalate`, triage | Escalations and how they were settled |
| `.ai/learnings.json` | `nativ learn` | Proposed, approved and rejected lessons |
| `.ai/telemetry.json` | nativ | Durations, costs, pass rates, role violations |

Files nativ wrote carry a marker, so `update` and `doctor` can tell untouched files from ones you edited.

[Back to contents](#contents)

---

## MCP server

`nativ mcp` speaks the Model Context Protocol over stdio. `setup` registers it for Claude Code; the same server works with Cursor, Claude Desktop and Antigravity.

| Tools | Purpose |
| :--- | :--- |
| `nativ_task_next`, `nativ_task_list`, `nativ_task_add` | Find and add work |
| `nativ_task_start`, `nativ_task_complete`, `nativ_task_block`, `nativ_task_reclaim` | Move a task through its lifecycle (complete always runs the gatekeeper; reclaim frees stale claims) |
| `nativ_validate` | Check the `.ai/` contracts, plan and role guides; returns only problems and a verdict |
| `nativ_triage` | Self-heal: evaluate pending escalations, apply sandbox-proven safe fixes, return decision cards for the rest |
| `nativ_task_escalate`, `nativ_task_propose_patch` | Escalate a gap or propose a governed patch |
| `nativ_learn_propose` | Propose a lesson; you approve it in a terminal |
| `nativ_verify`, `nativ_status`, `nativ_bench`, `nativ_test_gen` | Verification, progress, benchmarks, test generation |
| `nativ_worktree_create`, `_list`, `_merge`, `_remove` | Task worktrees |
| `nativ_db_status`, `nativ_db_inspect`, `nativ_db_diff` | Masked, structure-only database checks |
| `nativ_init`, `nativ_doctor` | Scaffold, and a read-only health report |

| Resources (read-only) |
| :--- |
| `nativ://context`, `nativ://master-plan`, `nativ://db-schema`, `nativ://api-contracts`, `nativ://escalation`, `nativ://telemetry` |

There is deliberately no MCP tool to unlock a task, approve a lesson, write a contract, sync a database schema or run setup.

**Manual registration:**

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

[Back to contents](#contents)

---

## Providers

nativ's own model calls (triage of escalations) go through one adapter, so no single vendor is on the critical path. Default order: `claude-cli`, `claude-api`, `gemini`, then a deterministic rules engine.

| Provider | Needs | Notes |
| :--- | :--- | :--- |
| `claude-cli` | Claude Code signed in | Uses your subscription login, no API key. Haiku by default, tools disabled, empty working directory |
| `claude-api` | `ANTHROPIC_API_KEY` | Anthropic SDK |
| `gemini` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | The key goes in a header, never the URL |

A provider that hits a usage limit is remembered in `.nativ/provider-state.json` and skipped until it resets. If none is available, triage still answers from the offline rules engine. Prompts pass through secret redaction before leaving the machine.

[Back to contents](#contents)

---

## Concurrency and telemetry

- **Locks.** `.ai/master_plan.json`, `.ai/telemetry.json`, `.ai/escalation.json` and `.ai/learnings.json` use OS-level advisory locks with atomic writes and retry backoff for Windows `EBUSY`/`EPERM`. Agents in separate terminals can start, complete and add tasks without lost updates. Long verification runs outside the lock.
- **Telemetry.** `.ai/telemetry.json` records task durations, token and cost estimates, verification pass rates, circuit-breaker trips and the latest 200 enforcement violations (rule, mode, tool, path, task). File contents are never logged. View it with `nativ status --telemetry` or in Studio.

[Back to contents](#contents)

---

## Troubleshooting

| Symptom | Fix |
| :--- | :--- |
| Claude Code ignores the project's permissions | Open Claude Code in the folder and accept the trust dialog |
| `doctor` reports missing or out-of-date files | `nativ doctor --fix` |
| `doctor` fails on `disableAllHooks` | Remove it from `.claude/settings.json` or `.claude/settings.local.json`; enforcement is off while it is set |
| The MCP server does not connect | `nativ doctor` (it asks `claude mcp list`); check for a `nativ` server in your user scope shadowing the project's |
| The generated config points at a path on your machine | Install globally, or `nativ setup --command "npx -y @njeybe/nativ"` |
| A worker keeps editing outside its task | Switch to `"enforcement": "block"`; a genuine need is an escalation, or `nativ task unlock` |
| `task complete` fails in a phase | The output names it; run that phase's command yourself to see the error |
| Triage says no provider | Sign in to Claude Code, or set `ANTHROPIC_API_KEY` or `GEMINI_API_KEY`; the offline rules engine still answers |

[Back to contents](#contents)

---

## For maintainers

```
nativ/
  bin/cli.js               entry point (a fast path serves the hooks without loading the whole CLI)
  src/
    index.ts               command registry
    commands/              init, setup, doctor, task, verify, learn, worktree, db, triage, ...
    core/                  enforcement, verifier, learnings, harness-integrity, setup-assets, telemetry, ...
    providers/             claude-cli, claude-api, gemini, registry (fallback chain and cooldown)
    governor/              contract evaluator, circuit breaker, rules, escalation store
    mcp/server.ts          MCP server
    db/                    masked env parser, introspection, schema diff
    server/                Studio dashboard
    runner/                agent supervisor (Studio dispatch)
  templates/               AGENTS.md, CLAUDE.md, GEMINI.md, claude-agents/, dot-ai/
  plugin/                  Claude Code plugin (generated by `npm run sync-plugin`)
  tests/                   regression suites (`npm test`)
```

```bash
npm install && npm run build
npm test
npm run sync-plugin      # after changing a template or the setup generator; a test fails if plugin/ is stale
```

---

## License

MIT (c) JB Natividad. See [LICENSE](LICENSE).
