# Nativ (`nativ`)

A portable, multi-tier autonomous software engineering harness that connects **Antigravity (Strategy & Planning)** with **Claude Code CLI (Project Manager)** and downstream **Sub-agents** (Backend, Frontend, Database, QA, Flutter, DevOps, Security).

> **Package Name:** `nativ-cli` | **Binary Command:** `nativ`

---

## 🏛 The 3-Tier Multi-Agent Architecture

`nativ` establishes a deterministic separation of concerns between strategic contract planning, project management, and specialized code execution:

```
                 +--------------------------------+
                 |       Tier 1: Antigravity      |
                 |      (Macro-Architect / Plan)  |
                 +---------------+----------------+
                                 |
           Generates validated .ai/ contracts & checkpoints
                                 v
                 +--------------------------------+
                 |      Tier 2: Claude Code       |
                 |       (Project Manager)        |
                 +---------------+----------------+
                                 |
         Dispatches JIT contract slices to parallel sub-agents
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

## ⚡ Key Capabilities

- **Multi-Agent Concurrency & OS Locks:** Advisory cross-process file locks (`proper-lockfile`) with atomic Read-Modify-Write cycles and Windows NTFS `EBUSY`/`EPERM` resilience. Run multiple agents in parallel across separate terminals with zero lost updates.
- **Contract Governor (Invariant Engine):** Deterministic AST/JSON middleware enforcing blast radius boundaries: auto-approves safe additive changes (`LOW_ADDITIVE`), rejects destructive drops (`HIGH_DESTRUCTIVE`), and trips a 3-strike circuit breaker on runaway violations.
- **Execution & Cost Telemetry:** Real-time offline telemetry (`.ai/telemetry.json`) tracking step durations, token volume heuristics, estimated operational costs ($3/M input, $15/M output), verification pass rates, and circuit breaker trips.
- **Synthetic Benchmark Suite (`nativ bench`):** Built-in eval matrix profiling operations throughput (ops/sec) and lock wait latencies (mean/max ms) across concurrency, invariants, verifications, and milestone lifecycles.
- **Zero-Credential AI Air-Gap:** AI subagents receive database schema structures only—never passwords, connection strings, or raw rows.
- **Git Worktree Sandboxing:** Isolates subagents into temporary git worktrees with mounted `.ai/` contracts and strict Safe Merge Gatekeepers.
- **Native MCP Stdio Server:** Exposes typed tools (`nativ_task_*`, `nativ_bench`, `nativ_verify`, `nativ_db_*`) and contract resources (`nativ://*`) for Claude Code, Cursor, and Antigravity.

---

## 🚀 Quick Start

### Installation

Install globally or run via `npx`:

```bash
# Global install (recommended):
npm install -g nativ-cli

# Or run instantly without installing:
npx nativ-cli <command>
```

### 1. Initialize a Project

Run inside any repository (new or existing):

```bash
nativ init
```

**What `nativ init` scaffolds:**
- **`.ai/` Contract Directory:**
  - `context.md`: Tech stack, runtime architecture, and guardrails.
  - `db_schema.json`: Strict JSON schema contract for database models and relationships.
  - `api_contracts.json`: Formal REST/GraphQL endpoints, payload structures, and response schemas.
  - `ui_specs.md`: Component trees, styling tokens, accessibility, and responsive layouts.
  - `master_plan.json`: Milestones, task dependency graph, and verification commands.
  - `subagents/`: Specialized role guides (`backend.md`, `frontend.md`, `database.md`, `qa-tester.md`, etc.).
- **Agent Directives:**
  - `CLAUDE.md`: Configures Claude Code as Project Manager.
  - `GEMINI.md`: Configures Antigravity as Macro-Architect.

---

### 2. The 3-Phase Lifecycle Flow

#### Phase 1: Interactive Design Checkpoints (Antigravity)
Before any code is written, Antigravity interviews the user and requires explicit approvals:
1. 🛑 **Database Schema:** Confirm table names, columns, and foreign keys.
2. 🛑 **API Contracts:** Confirm endpoints, request bodies, and response status codes.
3. 🛑 **UI/UX Specifications:** Confirm component hierarchy and design tokens.

#### Phase 2: Contract Export (Antigravity)
Upon receiving user approvals, Antigravity exports the finalized specifications into `.ai/db_schema.json`, `.ai/api_contracts.json`, `.ai/ui_specs.md`, and `.ai/master_plan.json`.

#### Phase 3: Autonomous Multi-Agent Execution (Claude Code)
Start Claude Code in your project root:
```bash
claude
```
Claude Code queries the next executable task using JIT contract slicing:
```bash
nativ task next --json
```
Subagents implement changes, run automated test verifications, and atomically commit state transitions via `nativ task complete <taskId>`.

---

## 💻 CLI Command Reference

### Task Management & JIT Context Slicing

```bash
# Inspect next executable task and its JIT contract slice
nativ task next

# List tasks with filters
nativ task list --available
nativ task list --milestone m1 --status pending

# Add a task dynamically (auto-increments ID, planned or fast-path)
nativ task add "Implement OAuth2 callback" -a backend -v "npm test"

# Transition task state (advisory locked)
nativ task start task-01
nativ task complete task-01          # Automatically runs verification command
nativ task complete task-01 --no-verify  # Bypass verification gatekeeper
nativ task block task-01 --reason "Missing Stripe API key"
nativ task escalate task-01 --type schema_flaw --details "Missing foreign key on orders table"
```

### Verification & Regression Gating

```bash
# Run verification for a single task
nativ verify task-01

# Run verifications across all completed tasks or specific milestones
nativ verify --all
nativ verify --milestone m1 --timeout 60000 --json
```

### Project Telemetry & Status

```bash
# Inspect status, milestone completion, and task badges
nativ status

# View execution duration, token heuristics, cost estimates, and pass rates
nativ status --telemetry

# Emit machine-readable JSON for CI/CD pipelines
nativ status --json
```

### Synthetic Benchmark Matrix

```bash
# Run all 5 synthetic benchmark scenarios
nativ bench

# Run specific scenario with custom concurrency
nativ bench --scenario concurrency --concurrency 8
nativ bench --scenario governor

# Export benchmark report for CI/CD gates
nativ bench --json
nativ bench -o .ai/benchmark_report.json
```

### Database Studio & Schema Telemetry

```bash
# Check Dev & Prod database connection health
nativ db status

# Introspect table structures, columns, keys, and indexes
nativ db inspect --env dev

# Compare schema drift from Dev to Prod, or to .ai/db_schema.json
nativ db diff
nativ db diff --target contract --exit-code

# Launch local dark-mode DB Studio web dashboard (http://localhost:4983)
nativ studio
```

### Git Worktree Sandboxing

```bash
# Create an isolated git worktree for a task with mounted .ai/ contracts
nativ worktree create task-01

# List active agent worktrees
nativ worktree list

# Merge task branch back to base branch (Safe Merge Gatekeeper enforced)
nativ worktree merge task-01

# Discard/cleanup worktree without merging
nativ worktree remove task-01
```

---

## 🔒 Multi-Agent Concurrency & OS Locks

`nativ` protects `.ai/master_plan.json` and `.ai/telemetry.json` against parallel write collisions using OS-level advisory file locks (`proper-lockfile`):

```
Agent Process 1 (Frontend)          Agent Process 2 (Backend)
         │                                   │
         ▼                                   ▼
 [withPlanLock: Try Lock]            [withPlanLock: Try Lock]
         │ (Acquired)                        │ (Queued / Backoff retry)
         ▼                                   │
 [Atomic Read-Modify-Write]                  │
         │ (Released)                        ▼
         └─────────────────────────► [Acquires Lock]
                                             │
                                     [Reads Freshest State]
                                             │
                                     [Applies & Saves Atomically]
```

- **Zero Lost Updates:** Verified across parallel processes running simultaneous `task start`, `task complete`, and `task add` operations.
- **Optimistic Verification Gating:** Long-running test commands (`npm test`, `pytest`) run *outside* the lock so other agents are never blocked.
- **Windows NTFS Resilience:** Uses atomic temporary file renames with an exponential retry backoff to cleanly absorb `EBUSY` and `EPERM` file collisions.

---

## ⚡ Execution & Cost Telemetry

Every task lifecycle transition records metrics to `.ai/telemetry.json`:

```text
⚡ Execution & Cost Telemetry
  Model Tier Benchmark: claude-3-7-sonnet
  Tasks Completed:      12
  Total Time Active:    4.2 min (252000ms)
  Estimated Tokens:     58,400
  Estimated Cost:       $0.2612 USD
  Verification Pass:    100% (12/12 runs)
  Circuit Breaker Trips: 0
```

- **Token & Cost Heuristics:** Calculated from prompt context overhead (~3,500 tokens), target file payload weights ($3.00/1M input), and code diff approximations ($15.00/1M output).
- **Quality Metrics:** Aggregates verification pass/fail ratios and tracks Governor circuit breaker events.

---

## 🛡️ Contract Governor: Invariant Guardrails

The **Contract Governor** acts as a deterministic firewall between autonomous subagents and project contracts (`.ai/db_schema.json` and `.ai/api_contracts.json`):

```
                 Sub-Agent Proposes Contract Modification
                                   │
                                   ▼
                [ Nativ Contract Governor Middleware ]
                                   │
         ┌─────────────────────────┴─────────────────────────┐
         ▼                                                   ▼
[ LOW_ADDITIVE (Type 2) ]                           [ HIGH_DESTRUCTIVE (Type 1) ]
• New nullable columns / defaults                   • Dropping tables / columns
• New tables / non-unique indexes                   • Altering existing column types
• New optional query params / headers               • Dropping API routes / fields
• New response fields (Postel's Law)                • Adding required request params
         │                                                   │
         ▼                                                   ▼
⚡ Auto-Approved & Patched                          🛑 Hard Rejection & Gating
1. Merged atomically into contract                  1. Rejected with structured violation
2. Logged to .ai/audit_log.jsonl                    2. Increments task failure counter
3. Agent continues seamlessly                       3. 3-Strike Circuit Breaker trips
                                                       (Freezes task & logs escalation)
```

---

## 🔌 Native MCP Integration

`nativ` includes a native Model Context Protocol (MCP) server communicating over stdio JSON-RPC.

### Available Tools & Resources

| MCP Tool / Resource | Type | Description |
| :--- | :--- | :--- |
| `nativ_task_next` | Tool | Fetch next executable task with JIT contract slice |
| `nativ_task_start` | Tool | Mark task as `in_progress` |
| `nativ_task_complete` | Tool | Complete task with automated verification check |
| `nativ_task_add` | Tool | Append a dynamic task to active or fast-path milestone |
| `nativ_task_block` | Tool | Mark task blocked with diagnostic notes |
| `nativ_task_escalate` | Tool | Escalate architectural blockers to Antigravity |
| `nativ_task_propose_patch` | Tool | Propose contract mutation evaluated by Governor |
| `nativ_verify` | Tool | Run automated verification command suite |
| `nativ_bench` | Tool | Execute synthetic benchmark evaluation matrix |
| `nativ_db_status` | Tool | Inspect connection health and masked database URLs |
| `nativ_db_inspect` | Tool | Inspect table structures, columns, and indexes |
| `nativ_db_diff` | Tool | Detect schema drift between environments and contracts |
| `nativ://context` | Resource | Read `.ai/context.md` |
| `nativ://master-plan` | Resource | Read `.ai/master_plan.json` |
| `nativ://telemetry` | Resource | Read `.ai/telemetry.json` |
| `nativ://db-schema` | Resource | Read `.ai/db_schema.json` |
| `nativ://api-contracts` | Resource | Read `.ai/api_contracts.json` |
| `nativ://escalation` | Resource | Read `.ai/escalation.json` |

### Configuration Examples

#### Claude Code
```bash
claude mcp add nativ -- npx -y nativ-cli mcp
```

#### Claude Desktop (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "nativ": {
      "command": "npx",
      "args": ["-y", "nativ-cli", "mcp", "/absolute/path/to/project"]
    }
  }
}
```

#### Cursor (`.cursor/mcp.json`)
```json
{
  "mcpServers": {
    "nativ": {
      "command": "npx",
      "args": ["-y", "nativ-cli", "mcp", "${workspaceFolder}"]
    }
  }
}
```

#### Antigravity (`mcp_config.json`)
```json
{
  "mcpServers": {
    "nativ": {
      "command": "npx",
      "args": ["-y", "nativ-cli", "mcp", "/absolute/path/to/project"]
    }
  }
}
```

---

## 📂 Repository Structure

```
nativ/
├── bin/
│   └── cli.js                    # Binary entrypoint (`nativ`)
├── src/
│   ├── index.ts                  # Commander CLI command registry
│   ├── commands/
│   │   ├── init.ts               # Project scaffolding
│   │   ├── update.ts             # Non-destructive directive sync
│   │   ├── status.ts             # Status & execution telemetry display
│   │   ├── task.ts               # Concurrency-hardened task router & lifecycle
│   │   ├── bench.ts              # Synthetic benchmark command
│   │   ├── verify.ts             # Verification gatekeeper command
│   │   ├── worktree.ts           # Git worktree lifecycle & merge gatekeeper
│   │   ├── db.ts                 # Database introspection, status, diff & sync
│   │   ├── test-gen.ts           # API contract & DB test suite synthesizer
│   │   └── mcp.ts                # Native MCP stdio server
│   ├── core/
│   │   ├── lock-manager.ts       # Advisory OS file locking & atomic mutations
│   │   ├── telemetry.ts          # Token heuristics, cost & execution tracking
│   │   ├── benchmark.ts          # 5-scenario synthetic evaluation matrix
│   │   ├── verifier.ts           # Cross-platform test execution engine
│   │   └── test-generator.ts     # Automated contract test generator
│   ├── governor/                 # Deterministic Contract Governor
│   │   ├── evaluator.ts          # Blast radius & invariant evaluation engine
│   │   ├── circuit-breaker.ts    # 3-strike failure ledger & escalation recorder
│   │   └── rules/                # Database & API mutation invariants
│   ├── mcp/
│   │   └── server.ts             # Native MCP server over stdio
│   └── db/
│       ├── introspector.ts       # PostgreSQL, MySQL & SQLite introspection
│       ├── env-parser.ts         # Zero-credential masked connection reader
│       └── diff.ts               # Schema drift engine
├── tests/                        # 12 automated regression test suites
│   ├── test-concurrency-locks.mjs
│   ├── test-telemetry-engine.mjs
│   ├── test-benchmark-suite.mjs
│   ├── test-contract-governor.mjs
│   ├── test-verify-gatekeeper.mjs
│   ├── test-worktree-lifecycle.mjs
│   └── ...
├── package.json
└── tsconfig.json
```

---

## 📄 License

MIT © [njeybe](https://github.com/njeybe)
