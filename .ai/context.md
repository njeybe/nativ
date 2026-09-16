# Project Context & Guardrails

## 1. System Overview & Repository Profile
- **Project Name:** ai-agent-workflow
- **Repository Type:** Standard Monolith / Standalone CLI Engine & Workflow Harness (Single Package Node)
- **Primary Goal:** Multi-tier AI agent workflow harness connecting Antigravity (Macro-Architect), Claude Code CLI (Project Manager), and autonomous sub-agents (Database, Backend, Frontend, QA)

## 2. Languages & Frameworks
- **Runtime Environment:** Node.js (ES Modules, `"type": "module"`)
- **Primary Language:** TypeScript 5.5.4 (Target: ES2022, Module Resolution: NodeNext)
- **CLI Framework & Core Libraries:**
  - `commander` (^12.1.0): CLI command dispatch, options parsing, subcommands
  - `picocolors` (^1.1.0): Terminal styling and color formatting
  - `@types/node` (^22.5.0): Node.js type definitions
- **Build System:** TypeScript Compiler (`tsc`), building from `src/` to `dist/`
- **Package Manager:** npm (`package-lock.json`)
- **Testing Framework:** None currently installed (Verification via `npm run build` and `node bin/cli.js validate`)

## 3. Database & Architecture Rules
- **Active ORM / Driver:** None detected (Greenfield / File-based Contract Authority)
- **Contract & Specification Authorities:**
  - Database Schema Contract: `.ai/db_schema.json`
  - UI / UX Specification Contract: `.ai/ui_specs.md`
  - Master Execution Plan: `.ai/master_plan.json`
  - Sub-agent Role Profiles: `.ai/subagents/*.md`
- **Architecture Constraints & Guidelines:**
  1. **Strict 3-Tier Execution Model:**
     - **Tier 1 (Antigravity):** Macro-Architect & intake engine. Designs database schemas and UI/UX layouts, establishes checkpoints, and generates `.ai/` contracts.
     - **Tier 2 (Claude Code CLI):** Middle-Tier Project Manager. Ingests `.ai/master_plan.json` and autonomously orchestrates sub-agents.
     - **Tier 3 (Sub-agents):** Specialized workers for Database, Backend, Frontend, and QA.
  2. **Zero Breaking Changes:** Preserve public interfaces, CLI command arguments, and contract structures.
  3. **Schema Authority:** Database modifications must strictly align with `.ai/db_schema.json`.
  4. **UI Fidelity:** Any UI output or terminal interactive components must strictly match `.ai/ui_specs.md`.
  5. **Secrets & Security:** Never hardcode credentials, API keys, or sensitive tokens. Always use environment variables.
  6. **Verification Gate:** Every newly introduced feature or command must build cleanly and pass `ai-agent-workflow validate`.

## 4. Execution Boundaries (Sub-Agent Allocation)

### Core Development & Database Units
- **`backend` (or `backend-agent`):**
  - Target Scope: `src/` (`src/commands/`, `src/scanner/`, `src/index.ts`), `bin/cli.js`, business logic, scanner heuristics, template interpolators, CLI command execution.
- **`frontend` (or `frontend-agent`):**
  - Target Scope: `.ai/ui_specs.md`, UI template components, interactive CLI terminal interfaces / spinners / banners, or web dashboard assets.
- **`database` (or `database-agent`):**
  - Target Scope: `.ai/db_schema.json`, schema migrations, ORM models, seeders, or persistent state storage if introduced.
- **`qa-tester` (or `qa-agent`):**
  - Target Scope: Automated test suites, test case writing, verification commands (`npm run build`, `node bin/cli.js validate`), CLI regression testing.

### Specialized Functional Units
- **`flutter-developer`:**
  - Target Scope: Cross-platform mobile screens, modular widgets, state management, mobile layout adaptations of `.ai/ui_specs.md`.
- **`devops-agent`:**
  - Target Scope: Environment configs (`.env.example`), Dockerfiles, `docker-compose.yml`, CI/CD pipelines, deployment scripts, server/dyno tuning.
- **`security-auditor`:**
  - Target Scope: Codebase vulnerability scans, credential leak prevention, authentication/authorization checks, OWASP compliance audits.
- **`db-migration`:**
  - Target Scope: Advanced data normalization, zero-downtime migrations, complex indexing, live table maintenance aligned with `.ai/db_schema.json`.
