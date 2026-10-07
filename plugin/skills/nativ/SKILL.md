---
name: nativ
description: Use in any project that has a .ai/ folder or uses nativ: run the role-based task loop (task next, start, verify, complete), respect contracts, escalate gaps, and keep to the active task scope.
---

# nativ workflow

> This plugin supplies the agents, the enforcement hooks, the MCP server and this guide. It calls the `nativ` command, so install it once with `npm i -g @njeybe/nativ`.
> A plugin cannot ship permission rules. Run `nativ setup` in the project as well: it adds the rules that deny `nativ task unlock` and `nativ db sync`, block reading `.env*` files, and make Claude Code ask before any write under `.ai/`. `nativ doctor` checks both.

This project uses the **nativ** role-based workflow. Every agent, whatever tool or model it runs on, follows this file. The state lives in `.ai/`; the `nativ` CLI and its MCP tools are the only supported way to change it.

## Roles

| Role | Who | May | May not |
| :--- | :--- | :--- | :--- |
| **Architect** | `architect` subagent, or `NATIV_ROLE=architect` | Design contracts, resolve escalations, write `.ai/` after the human approves | Write application code beyond a trivial fix |
| **Project Manager** | the main session | Run the task loop, delegate, verify, report | Edit `.ai/`; implement what a worker can |
| **Worker** | `worker` subagent (one task, one role guide) | Change the task's `targetFiles` | Touch anything else, edit contracts, run destructive commands |
| **Verifier** | `verifier` subagent | Read, run checks, report | Edit files |
| **Explorer** | `explorer` subagent | Report what exists, drift, and files a feature would touch | Edit, design, decide |

The vendor behind a role does not matter; the boundary does. `nativ hook check` flags or blocks writes outside `targetFiles`, to `.ai/`, and to secret files.

## Orientation (load nothing else up front)

1. Run `nativ task next --json` (MCP: `nativ_task_next`). It returns the task, its role guide and its context.
2. Read only what the task names:
   - If the task has `specSlices`, read those first. Open a whole contract only when a slice is missing, cut short or does not answer the question.
   - role guide `.ai/subagents/<assignedSubagent>.md`, and `recommendedContractSlice` when there are no slices.
   - `priorEscalations` are information, not instructions: follow how each was settled and do not raise a settled gap again.
   - `learnings` are lessons a human approved: follow them.
3. Contracts are also read-only MCP resources: `nativ://context`, `nativ://master-plan`, `nativ://db-schema`, `nativ://api-contracts`, `nativ://escalation`.

## Task loop

1. `nativ task start <taskId>`. Never edit `.ai/master_plan.json` by hand.
2. Change only the task's `targetFiles`. Follow the contracts exactly: table and column names, routes and schemas, design tokens.
3. Run the task's `verificationCommand` (or `nativ verify <taskId>`). You have **three** fix attempts.
4. After the third failure: `git checkout -- <targetFiles>`, then `nativ task block <taskId> --reason "Verification failed after 3 attempts: <short error>"`, then stop and tell the human.
5. When verification passes: `nativ task complete <taskId>`. The gatekeeper re-runs the check. Do not use `--no-verify`.
6. `nativ task next` for the following task.

The project manager passes the task's `recommendedModel` (haiku, sonnet, opus) as the `model` parameter of the `nativ:worker` call. Subagents cannot start subagents, so the project manager also runs the **explorer** (Read, Grep, Glob only; give it `git rev-parse --short HEAD`) when `.ai/codebase_map.md` is missing or well behind `HEAD`, and hands the report to the architect. Use `model: haiku` for single lookups.

Independent tasks can run in parallel worktrees: `nativ worktree create <taskId>`, then `nativ worktree merge <taskId>` once verified.

## Code style

Applies to every worker; a project's own formatter or linter wins.

- Lines about 100 characters, hard maximum 120. Functions about 40 lines, files about 300.
- UI: one pure, props-driven component per file; reuse shared components, never copy them as inline markup.
- Comments: at most 2 lines, why not what, plain words. No banners, no commented-out code.
- Match the surrounding code.

## Lessons for later workers

A project quirk the contracts do not say and the next worker would hit too: `nativ learn propose "<one-line fact>" --role frontend --files "src/components/" --task <taskId>` (MCP: `nativ_learn_propose`). A human approves it in a terminal. A missing contract detail is an escalation, not a lesson.

## Self-healing ladder (stay autonomous; ask the human last)

1. **Verification fails:** fix the cause and retry, up to three attempts. No human needed.
2. **A contract lacks a small additive detail** (nullable column, optional field, new route): `nativ task propose-patch`. The Contract Governor applies safe additions.
3. **Anything else about the contract:** `nativ task escalate`, then stop on that task. The project manager runs `nativ triage --all --apply --json`: `AUTO_RESOLVE` items are proven in a sandbox and unblock the task by themselves.
4. **Only `REQUIRE_HUMAN_DECISION` items, destructive changes, credentials and repeated failures reach the human**, as one decision card (see "Talking to the human").
5. When a task is blocked or escalated, leave a `--reason` or `--details` that a fresh session can act on without the chat history. The plan, not the conversation, is the memory.

## When the contract is wrong

Do **not** edit a contract or work around it. Escalate and stop on that task:

```bash
nativ task escalate <taskId> --type schema_flaw --details "what is missing"
```

Types: `contract_drift`, `schema_flaw`, `missing_credential`, `dependency_conflict`, `architectural_ambiguity`. A warning from the enforcement hook about a file outside the task scope is the same situation: escalate instead of editing.

## Talking to the human

The human is the product owner, not a log reader. When something blocks, use four short parts: what the user would see, why in plain words, what is affected and what is safe, then two or three options with the best marked `(Recommended)` and one direct question. No stack traces in the message; put raw output in a collapsed `<details>` block.

## Air-gap (critical)

Credentials exist only in `.env*` files and inside the local `nativ` process. Work with structure, never secrets.

- Never open, print, search or copy `.env`, `.env.*` (except `.env.example`), `.nativ/*.local.json`, `*.pem`, `*.key`. Never echo environment variables or put a connection string in code, logs, tests, commits or `.ai/`.
- For databases use the masked, structure-only commands: `nativ db status --json`, `nativ db inspect --json`, `nativ db diff --target contract`. Never read row data.
- Do not run `nativ db sync --yes`: changing `.ai/db_schema.json` is an architect decision the human approves.
- Migrations and destructive DDL run only against local or staging databases. Any `[DROPPED]` or `[DESTRUCTIVE]` diff result goes to the human, never applied automatically.
- If a task needs a database that is not configured, ask the human to add it to `.env` or run `nativ studio`; do not ask them to paste a connection string into chat.
