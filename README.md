# Nativ (`nativ`)

A portable, multi-tier autonomous software engineering harness that connects **Antigravity (Strategy & Planning)** with **Claude Code CLI (Project Manager)** and downstream **Sub-agents** (Backend, Frontend, Database, QA).

> **Package Name:** `nativ-cli` | **Binary Command:** `nativ`

---

## 🏛 The 3-Tier Architecture

```
                 +--------------------------------+
                 |       Tier 1: Antigravity      |
                 |      (Strategy & Planning)     |
                 +---------------+----------------+
                                 |
           Generates .ai/ contracts & checkpoints
                                 v
                 +--------------------------------+
                 |      Tier 2: Claude Code       |
                 |       (Project Manager)        |
                 +---------------+----------------+
                                 |
               Dispatches tasks to sub-agents
                                 v
   +-------------------------------+-------------------------------+
   |                                                               |
   v                                                               v
[ Core Development Units ]                       [ Specialized Functional Units ]
* Database (db & models)                         * Flutter Developer (mobile / widgets)
* Backend (APIs & business logic)                * DevOps Agent (Docker, CI/CD, dynos)
* Frontend (web UI & layout specs)               * Security Auditor (vulns & auth audits)
* QA / Tester (test suites & regression)         * DB Migration (zero-downtime & indexing)
```

---

## ⚡ Quick Start

### Initialize in Any Project (Existing or New)

Run the CLI tool inside your target project directory:

```bash
# Using nativ globally (via npm link or global install):
nativ init

# Or via npx:
npx nativ-cli init
```

### What `init` Does:
1. **Auto-Discovery:** Analyzes the target repository (runtimes, frameworks, ORMs, styling, test runners, project structure).
2. **Scaffolds `.ai/` Contract Directory:**
   - `.ai/context.md`: Project description, tech stack, architecture, and engineering guardrails.
   - `.ai/db_schema.json`: Strict JSON schema contract for database models and relationships.
   - `.ai/api_contracts.json`: Formal REST/GraphQL endpoints, payload structures, and response schemas.
   - `.ai/ui_specs.md`: Design system rules, component tree, interaction states, and accessibility specs.
   - `.ai/master_plan.json`: Execution milestones, dependency graph, assigned sub-agents, and verification commands.
   - `.ai/subagents/`: Role guides for Core units (`backend.md`, `frontend.md`, `database.md`, `qa-tester.md`) and Specialized units (`flutter-developer.md`, `devops-agent.md`, `security-auditor.md`, `db-migration.md`).
3. **Generates Directives:**
   - `CLAUDE.md`: Instructs **Claude Code CLI** to act as Project Manager, read `.ai/master_plan.json`, dispatch work to sub-agents, and track progress.
   - `GEMINI.md`: Instructs **Antigravity** to act as Macro-Architect, conduct Phase 1 intake, enforce database, API, and UI/UX checkpoints, and export `.ai/` contracts.

---

## 🔄 The 3-Phase Development Flow

### Phase 1: Discovery & Design Checkpoints (Antigravity)
1. Antigravity inspects `.ai/context.md` and interviews the user about the requested feature or objective.
2. **Database Schema Design:** Antigravity outlines the database tables and halts for user confirmation.
   - 🛑 *Stopping Point: Awaiting database schema approval.*
3. **API Contract Design:** Antigravity specifies endpoints, route params, request bodies, and response schemas.
   - 🛑 *Stopping Point: Awaiting API contract approval.*
4. **UI/UX Layout Design:** Antigravity designs component trees and styling layouts, then halts for user confirmation.
   - 🛑 *Stopping Point: Awaiting UI/UX approval.*

### Phase 2: State Export & Contract Generation (Antigravity)
Upon receiving approvals, Antigravity exports the finalized specifications:
- `.ai/db_schema.json`
- `.ai/api_contracts.json`
- `.ai/ui_specs.md`
- `.ai/master_plan.json`

### Phase 3: Autonomous Middle-Tier Execution (Claude Code CLI)
Open Claude Code CLI in your project terminal:
```bash
claude
```
Claude Code reads `CLAUDE.md`, calls `npx nativ-cli task next` to fetch only the active work item and its recommended contract slice (JIT context slicing), implements the scoped changes, verifies them via automated test runs, and updates status programmatically via `task complete`!

---

## 🛠 CLI Commands (`nativ`)

| Command | Description |
| :--- | :--- |
| `nativ init [targetDir]` | Scans target project and generates `.ai/`, `CLAUDE.md`, and `GEMINI.md`. Use `-f` to overwrite. |
| `nativ update [targetDir]` | Safely synchronizes latest directives, sub-agents, and missing contracts without touching project state. |
| `nativ status [targetDir]` | Displays overall progress, active milestone, and sub-agent task statuses from `.ai/master_plan.json`. |
| `nativ validate [targetDir]` | Verifies the structural integrity and validity of all contracts and agent profiles. |
| `nativ task list [targetDir]` | Lists all project tasks with filtering (`--available`, `--status`, `--milestone`, `--json`). Alias: `nativ tasks`. |
| `nativ task next [targetDir]` | Inspects the next executable task and suggests its specific JIT contract slice (supports `--json`). |
| `nativ task start <taskId>` | Marks a task as `in_progress` in `.ai/master_plan.json`. |
| `nativ task complete <taskId>` | Marks a task as completed after running its verification command (rejects on failure; bypass with `--no-verify`). |
| `nativ verify [taskId]` | Runs verification commands on demand to prevent regressions (`--all`, `--milestone <id>`, `--json`, `--timeout <ms>`). |
| `nativ task block <taskId> -r <reason>` | Marks a task as `blocked` with a documented reason in `notes`. |
| `nativ task escalate <taskId> -t <type> -d <details>` | Escalates contract drift/flaws to Antigravity via `.ai/escalation.json`. |
| `nativ worktree create <taskId>` | Creates an isolated Git worktree (`.worktrees/task-<id>`) on branch `agent/task-<id>`. |
| `nativ worktree list` | Lists all active agent git worktrees. |
| `nativ worktree merge <taskId>` | Merges the agent worktree branch into the base branch and cleans up. |
| `nativ db status [targetDir]` | Dev/Prod connection health: engine, ping latency, table count, masked URL (supports `--json`). |
| `nativ db inspect [targetDir]` | Prints introspected tables, columns, keys, and indexes (`--env dev|prod`, `--table <name>`, `--json`). |
| `nativ db diff [targetDir]` | Schema drift from Dev to Prod, or to `.ai/db_schema.json` with `--target contract` (`--json`, `--exit-code`). |
| `nativ db sync [targetDir]` | Previews exporting a live schema into `.ai/db_schema.json`; writes only with `--yes` (`--source dev|prod`). |
| `nativ db ui [targetDir]` | Launches the local DB Studio dashboard (`--port <n>`, `--no-open`). Alias: `nativ studio`. |
| `nativ mcp [targetDir]` | Runs the native MCP server over stdio, exposing `nativ_*` tools and `nativ://` contract resources. |

---

## 🔌 Native MCP Server (`nativ mcp`)

`nativ mcp` speaks the [Model Context Protocol](https://modelcontextprotocol.io) over stdio, so any MCP client can drive the workflow with typed tool calls instead of parsing CLI output.

**Tools**

| Tool | Arguments | Equivalent |
| :--- | :--- | :--- |
| `nativ_task_next` | – | `nativ task next --json` |
| `nativ_task_list` | `available?`, `status?`, `milestone?` | `nativ task list --json` |
| `nativ_task_start` | `taskId` | `nativ task start` |
| `nativ_task_complete` | `taskId`, `notes?`, `skipVerify?` | `nativ task complete` (enforces verification) |
| `nativ_verify` | `taskId?`, `milestone?`, `all?` | `nativ verify --json` |
| `nativ_task_block` | `taskId`, `reason` | `nativ task block` |
| `nativ_task_escalate` | `taskId`, `type`, `details`, `affected?` | `nativ task escalate` |
| `nativ_init` | – | `nativ init` (never overwrites; no `--force`) |
| `nativ_status` | – | `nativ status` |
| `nativ_db_status` | – | `nativ db status --json` |
| `nativ_db_inspect` | `env?`, `table?` | `nativ db inspect --json` |
| `nativ_db_diff` | `target?` (`contract` default, or `prod`) | `nativ db diff --json` |

**Resources:** `nativ://context`, `nativ://master-plan`, `nativ://db-schema`, `nativ://api-contracts`, `nativ://escalation` (the matching `.ai/` files).

The server is bound to one project directory: the `[targetDir]` argument, or the directory the client starts it in. It follows the same air-gap as the CLI: database output is masked and structure-only, and `db sync`, `db ui`, and `init --force` are not exposed.

### Client configuration

**Claude Code** (run inside the project):

```bash
claude mcp add nativ -- npx nativ-cli mcp
```

Or commit a project-scoped `.mcp.json`:

```json
{
  "mcpServers": {
    "nativ": { "command": "npx", "args": ["nativ", "mcp"] }
  }
}
```

**Claude Desktop** (`claude_desktop_config.json`; Desktop does not start in your project, so pass its path):

```json
{
  "mcpServers": {
    "nativ": {
      "command": "npx",
      "args": ["nativ", "mcp", "/absolute/path/to/your/project"]
    }
  }
}
```

**Cursor** (`.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` with an absolute path):

```json
{
  "mcpServers": {
    "nativ": { "command": "npx", "args": ["nativ", "mcp", "${workspaceFolder}"] }
  }
}
```

**Antigravity** (Agent panel → MCP Servers → Manage MCP Servers → View raw config, `mcp_config.json`):

```json
{
  "mcpServers": {
    "nativ": {
      "command": "npx",
      "args": ["nativ", "mcp", "/absolute/path/to/your/project"]
    }
  }
}
```

> **Windows:** if a client fails to launch `npx`, use `"command": "cmd"` with `"args": ["/c", "npx", "nativ", "mcp", "C:\\path\\to\\project"]`. With a global install (`npm i -g` / `npm link`), `"command": "nativ", "args": ["mcp", "<path>"]` works everywhere.

---

## 🗄️ Database Studio & Schema Telemetry (`nativ db`)

A zero-config, credential-safe way to see what your databases actually look like and how far they have drifted from each other and from the approved `.ai/db_schema.json` contract.

**Supported engines:** PostgreSQL (incl. Supabase / Neon) via `pg`, MySQL / MariaDB via `mysql2`, and SQLite via Node's built-in `node:sqlite` (Node 22.5+).

### 1. Configure connections

Add connection strings to `.env` (or `.env.local`, `.env.development`, `.env.production`) in your project root. They are read locally by `nativ` and never printed:

```bash
# Dev / staging (first match wins)
DEV_DATABASE_URL=postgres://app:password@localhost:5432/app_dev   # or DATABASE_URL_DEV / DATABASE_URL
# Production
PROD_DATABASE_URL=postgres://readonly:password@db.example.com:5432/app   # or DATABASE_URL_PROD / PRODUCTION_DATABASE_URL

# SQLite works too:
# DEV_DATABASE_URL=file:./dev.db
```

`NATIV_DEV_DATABASE_URL` / `NATIV_PROD_DATABASE_URL` take precedence, and real environment variables override `.env` files. Prefer a **read-only** database user for production: introspection only needs catalog access.

### 2. Check health

```bash
nativ db status
#  ● DEV  [ONLINE] PostgreSQL · app_dev (3.2ms) – 14 tables
#         postgres://app:••••••••@localhost:5432/app_dev
#  ● PROD [ONLINE] PostgreSQL · app (34ms) – 13 tables
#         postgres://readonly:••••••••@db.example.com:5432/app
```

### 3. Detect drift

```bash
nativ db diff                    # Dev → Prod
nativ db diff --target contract  # Dev → .ai/db_schema.json
nativ db diff --exit-code        # exit 1 on any drift (CI gate)
```

Tables are classified as `[NEW TABLE]`, `[ALTERED]` (added / dropped / changed columns, indexes, foreign keys), or `[DROPPED]`. Dropped tables, dropped columns, type changes, and new `NOT NULL` constraints are flagged `[DESTRUCTIVE]` with a high-severity warning. Equivalent types (`INT4` vs `INTEGER`, `timestamptz` vs `TIMESTAMP WITH TIME ZONE`) and Postgres casts in defaults are normalized so they don't show up as false drift.

### 4. Launch the visual studio

```bash
nativ studio          # same as: nativ db ui
nativ studio --port 5000 --no-open
```

Opens `http://localhost:4983` with:
- **Side-by-Side Table Explorer:** Dev and Prod tables in dual panes with search, expandable column details, and `PK` / `FK` / drift badges.
- **Visual Drift & Diff Tracker:** summary banner with risk level, and per-column before/after diffs against Prod or the contract.
- **Migration SQL Preview:** generated DDL in the target engine's dialect, with destructive statements highlighted. It is a preview only and is never executed.
- **Connection Settings:** enter or replace Dev/Prod connection strings (masked input, *Test Ping*); held in memory for the session only.
- **Export Contract:** writes the live Dev schema (structure only) into `.ai/db_schema.json`.

The studio exposes a small local REST API (`GET /api/status`, `GET /api/schema`, `GET /api/diff`, `POST /api/connect`, `POST /api/export-contract`) matching `.ai/api_contracts.json`.

### 5. Sync the contract

```bash
nativ db sync          # dry run: shows what would change in .ai/db_schema.json
nativ db sync --yes    # write it (structure only)
```

Syncing overwrites the table definitions in a Tier-1 contract, so treat it as a Phase 2 contract change: review the dry-run diff and approve it before writing. `CLAUDE.md` forbids Claude Code from running it; drift found during execution is escalated instead.

---

## 🔐 Security Architecture: Zero-Credential AI Air-Gap

AI agents get **schema structure, never secrets**.

| Layer | Guarantee |
| :--- | :--- |
| **Credential storage** | Connection strings live only in `.env*` files and the memory of the local `nativ` process. Studio connections are never written to disk. |
| **Masking** | Every URL shown in the terminal, the studio, or `--json` output is masked (`postgres://user:••••••••@host/db`), including password-like query parameters. Driver error messages are scrubbed of the raw URL and password. |
| **Schema-only access** | Introspection reads only `information_schema` / `pg_catalog` / `PRAGMA` metadata. No `SELECT * FROM` data queries are ever issued; SQLite files are opened read-only. |
| **Sanitized contracts** | Exporting to `.ai/db_schema.json` rebuilds each table field-by-field (names, types, nullability, defaults, keys, indexes) so nothing else can leak in. |
| **Local-only studio** | The server binds to `127.0.0.1` only, rejects non-localhost `Host`/`Origin` headers (DNS-rebinding and CSRF protection), requires JSON bodies on `POST`, and sends a strict CSP. |
| **Agent directives** | `CLAUDE.md` and `GEMINI.md` forbid reading `.env*` or `.nativ/*.local.json`, echoing environment variables, asking users to paste connection strings into chat, or running data-reading queries. Agents use the masked `nativ db` commands instead. |
| **Ignore rules** | `templates/.claudeignore` lists `.env*`, `*.local.json`, keys, local database files, and dumps as off-limits for agent context. |
| **Destructive-change gates** | Drops and destructive alterations are flagged high-severity everywhere. Agents may only apply migrations to local/staging databases, never production. |

---

## Project Structure

```
nativ-fw/
├── bin/
│   └── cli.js                    # Executable binary entrypoint (nativ)
├── src/
│   ├── index.ts                  # Commander CLI definition
│   ├── commands/
│   │   ├── init.ts               # Project initialization command
│   │   ├── update.ts             # Non-destructive framework sync command
│   │   ├── status.ts             # Status report command
│   │   ├── validate.ts           # Schema validation command
│   │   ├── task.ts               # JIT task lifecycle commands (next/start/complete/block/escalate)
│   │   ├── worktree.ts           # Parallel agent Git worktree isolation (create/list/merge)
│   │   ├── db.ts                 # Database commands (status/inspect/diff/sync/ui)
│   │   └── mcp.ts                # `nativ mcp` stdio server command
│   ├── mcp/
│   │   └── server.ts             # MCP tools & nativ:// contract resources
│   ├── db/
│   │   ├── types.ts              # Telemetry, schema & diff types (mirrors .ai/api_contracts.json)
│   │   ├── env-parser.ts         # Safe .env reader & connection-string masking
│   │   ├── introspector.ts       # PostgreSQL / MySQL / SQLite schema introspection + ping
│   │   └── diff.ts               # Schema drift engine & contract loader
│   ├── server/
│   │   ├── studio-server.ts      # Loopback-only HTTP server & REST API
│   │   └── studio-ui.ts          # Self-contained dark-mode dashboard
│   └── scanner/
│       ├── types.ts              # TypeScript interfaces
│       ├── detector.ts           # Multi-ecosystem tech stack scanner
│       └── context-builder.ts    # Template interpolator
├── templates/
│   ├── CLAUDE.md                 # Middle-Tier PM directive for Claude Code
│   ├── GEMINI.md                 # Tier-1 Mission Control directive for Antigravity
│   ├── .claudeignore             # Zero-credential ignore rules for agent context
│   └── dot-ai/
│       ├── context.md            # Auto-generated project context & guardrails
│       ├── db_schema.json        # Database schema contract
│       ├── api_contracts.json    # REST/GraphQL API endpoint & payload contract
│       ├── ui_specs.md           # UI/UX layout specification
│       ├── master_plan.json      # Milestone & task dependency graph
│       └── subagents/            # Sub-agent role specifications
│           ├── backend.md            # Backend & API development
│           ├── frontend.md           # Web UI/UX components & pages
│           ├── database.md           # Schema migrations & ORM models
│           ├── qa-tester.md          # Verification & automated test suites
│           ├── flutter-developer.md  # Mobile screens, widgets & state
│           ├── devops-agent.md       # Docker, CI/CD & deployment scripts
│           ├── security-auditor.md   # Vulnerability scans & auth audit
│           └── db-migration.md       # Zero-downtime & advanced indexing
├── package.json
└── tsconfig.json
```
