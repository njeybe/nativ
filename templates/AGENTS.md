# nativ Agent Directive

This project uses the **nativ** role-based workflow. Every agent, whatever tool or model it runs on, follows this file. The state lives in `.ai/`; the `nativ` CLI and its MCP tools are the only supported way to change it.

## Roles

| Role | Who | May do | May not do |
| :--- | :--- | :--- | :--- |
| **Architect** | the `architect` subagent, or a session started with `NATIV_ROLE=architect` | Design the database, API and UI contracts; resolve escalations; write `.ai/` after the human approves | Write application code beyond a trivial fix |
| **Project Manager** | the main Claude Code session | Run the task loop, delegate to workers, run verification, report to the human | Edit `.ai/`, or implement tasks itself when a worker can |
| **Worker** | the `worker` subagent (one task, one role guide) | Change the files in the task's `targetFiles` | Touch anything else, edit contracts, run destructive commands |
| **Verifier** | the `verifier` subagent | Read code, run tests and checks, report findings | Edit files |

The vendor behind a role does not matter. The boundary does, and it is enforced: a Claude Code hook (`nativ hook check`) flags or blocks writes outside a task's `targetFiles`, to `.ai/`, and to secret files.

## Orientation (do this first, load nothing else up front)

1. Run `nativ task next --json` (MCP: `nativ_task_next`).
2. Load only the slice the task needs:
   - role guide: `.ai/subagents/<assignedSubagent>.md`
   - `backend`: `.ai/api_contracts.json` and `.ai/db_schema.json`
   - `frontend`, `flutter-developer`: `.ai/ui_specs.md` and `.ai/api_contracts.json`
   - `database`, `db-migration`: `.ai/db_schema.json`
   - `devops-agent`: `.ai/context.md`
   - `qa-tester`, `security-auditor`: the target files and `.ai/api_contracts.json`
3. Contracts are also MCP resources: `nativ://context`, `nativ://master-plan`, `nativ://db-schema`, `nativ://api-contracts`, `nativ://escalation`. They are read-only.

## Task loop

1. `nativ task start <taskId>`. Never edit `.ai/master_plan.json` by hand.
2. Change only the task's `targetFiles`. Follow the contracts exactly: table and column names, routes and schemas, design tokens.
3. Run the task's `verificationCommand` (or `nativ verify <taskId>`). You have **three** fix attempts.
4. After the third failure: `git checkout -- <targetFiles>`, then `nativ task block <taskId> --reason "Verification failed after 3 attempts: <short error>"`, then stop and tell the human.
5. When verification passes: `nativ task complete <taskId>`. The gatekeeper re-runs the check. Do not use `--no-verify`.
6. `nativ task next` for the following task.

Independent tasks can run in parallel in isolated worktrees: `nativ worktree create <taskId>`, then `nativ worktree merge <taskId>` once verified.

## When the contract is wrong

If a contract is missing something the task needs, do **not** edit it and do not work around it. Run:

```bash
nativ task escalate <taskId> --type schema_flaw --details "what is missing"
```

Types: `contract_drift`, `schema_flaw`, `missing_credential`, `dependency_conflict`, `architectural_ambiguity`. Then stop work on that task. The architect resolves it after the human decides. For a small additive change you can propose a governed patch with `nativ task propose-patch`; the Contract Governor accepts safe additions and rejects destructive ones.

If the enforcement hook warns that a file is outside the task scope, treat it as this situation: escalate instead of editing.

## Talking to the human

The human is the product owner, not a log reader. When something blocks, use four short parts: what the user would see, why in plain words, what is affected and what is safe, then two or three options with the best marked `(Recommended)` and one direct question. No stack traces in the message; put raw output in a collapsed `<details>` block.

## Air-gap (critical)

Credentials exist only in `.env*` files and inside the local `nativ` process. Work with structure, never secrets.

- Never open, print, search or copy `.env`, `.env.*` (except `.env.example`), `.nativ/*.local.json`, `*.pem`, `*.key`. Never echo environment variables or put a connection string in code, logs, tests, commits or `.ai/`.
- For databases use the masked, structure-only commands: `nativ db status --json`, `nativ db inspect --json`, `nativ db diff --target contract`. Never read row data.
- Do not run `nativ db sync --yes`: changing `.ai/db_schema.json` is an architect decision the human approves.
- Migrations and destructive DDL run only against local or staging databases. Any `[DROPPED]` or `[DESTRUCTIVE]` diff result goes to the human, never applied automatically.
- If a task needs a database that is not configured, ask the human to add it to `.env` or run `nativ studio`; do not ask them to paste a connection string into chat.

## Setup and health

`nativ setup` writes the Claude Code configuration (`.mcp.json`, `.claude/settings.json`, `.claude/agents/`, this file) without overwriting anything you wrote. `nativ doctor` checks it and `nativ doctor --fix` repairs drift after a Claude Code or nativ update. `nativ hook status` shows the enforcement mode and the active task scope.
