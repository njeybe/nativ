# AgentJ (`agentj`)

A portable, multi-tier autonomous software engineering harness that connects **Antigravity (Strategy & Planning)** with **Claude Code CLI (Project Manager)** and downstream **Sub-agents** (Backend, Frontend, Database, QA).

> **Binary Name:** `agentj` *(alias: `ai-agent-workflow`)*

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
# Using agentj globally (via npm link or global install):
agentj init

# Or via npx:
npx agentj init
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
Claude Code reads `CLAUDE.md`, calls `npx ai-agent-workflow task next` to fetch only the active work item and its recommended contract slice (JIT context slicing), implements the scoped changes, verifies them via automated test runs, and updates status programmatically via `task complete`!

---

## 🛠 CLI Commands (`agentj`)

| Command | Description |
| :--- | :--- |
| `agentj init [targetDir]` | Scans target project and generates `.ai/`, `CLAUDE.md`, and `GEMINI.md`. Use `-f` to overwrite. |
| `agentj update [targetDir]` | Safely synchronizes latest directives, sub-agents, and missing contracts without touching project state. |
| `agentj status [targetDir]` | Displays overall progress, active milestone, and sub-agent task statuses from `.ai/master_plan.json`. |
| `agentj validate [targetDir]` | Verifies the structural integrity and validity of all contracts and agent profiles. |
| `agentj task next [targetDir]` | Inspects the next executable task and suggests its specific JIT contract slice (supports `--json`). |
| `agentj task start <taskId>` | Marks a task as `in_progress` in `.ai/master_plan.json`. |
| `agentj task complete <taskId>` | Marks a task as `completed` and advances milestone/project status upon completion. |
| `agentj task block <taskId> -r <reason>` | Marks a task as `blocked` with a documented reason in `notes`. |
| `agentj task escalate <taskId> -t <type> -d <details>` | Escalates contract drift/flaws to Antigravity via `.ai/escalation.json`. |
| `agentj worktree create <taskId>` | Creates an isolated Git worktree (`.worktrees/task-<id>`) on branch `agent/task-<id>`. |
| `agentj worktree list` | Lists all active agent git worktrees. |
| `agentj worktree merge <taskId>` | Merges the agent worktree branch into the base branch and cleans up. |

---

## 📦 Project Structure

```
ai-agent-workflow/
├── bin/
│   └── cli.js                    # Executable binary entrypoint (agentj)
├── src/
│   ├── index.ts                  # Commander CLI definition
│   ├── commands/
│   │   ├── init.ts               # Project initialization command
│   │   ├── update.ts             # Non-destructive framework sync command
│   │   ├── status.ts             # Status report command
│   │   ├── validate.ts           # Schema validation command
│   │   ├── task.ts               # JIT task lifecycle commands (next/start/complete/block/escalate)
│   │   └── worktree.ts           # Parallel agent Git worktree isolation (create/list/merge)
│   └── scanner/
│       ├── types.ts              # TypeScript interfaces
│       ├── detector.ts           # Multi-ecosystem tech stack scanner
│       └── context-builder.ts    # Template interpolator
├── templates/
│   ├── CLAUDE.md                 # Middle-Tier PM directive for Claude Code
│   ├── GEMINI.md                 # Tier-1 Mission Control directive for Antigravity
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
