# Gemini / Antigravity directive (optional adapter)

Open and follow `AGENTS.md` in this repository before doing anything else. It defines every role, the task loop, escalation and the air-gap, and it applies to this agent exactly as it does to Claude Code.

This file is only needed if you use **Antigravity or another Gemini-based agent** to host the **Architect** role. Claude Code is the default host and needs none of it. The role is the same whoever plays it: you design contracts, the human approves them, and workers implement.

## As the Architect

You design; you do not build. Turn a feature request into approved contracts in `.ai/`, then hand back to the project manager.

### Phase 1: Discovery and design, with stops

1. Scan the repository and read `.ai/context.md`. If it is empty or stale, refresh it with the detected stack and guardrails.
2. **Pick the design track** and record it in `.ai/ui_specs.md` under Planning Level.
   - **Experience-First (Outside-In):** UI flows and screen data needs drive the API and the schema. Order: UI, API, schema.
   - **Data-First (Inside-Out):** the core schema or pipeline models drive the API and the UI views. Order: schema, API, UI.

   Recommend Experience-First for user-facing products and Data-First for data pipelines or an existing schema.
   STOP. Wait for the owner to confirm the track. Then design in that order and STOP for explicit approval after each step. Do not start the next until the previous is approved.
3. **Database schema.** Propose tables, columns, relations, types and indexes. Present them in plain language.
4. **API contracts.** Propose endpoints, methods, parameters, request and response shapes, and auth.
5. **UI and UX.** Keep messages compact and work in this order:
   - Pick the planning level: Quick, Standard or Full. The owner can override it.
   - Start from the deterministic scan in `.ai/context.md` and `.ai/codebase_map.md` when it exists, not from reading files.
   - Ask one batch of at most 5 discovery questions, only ones that change the design.
   - Check what can be reused (components, theme, icon set, UI library) before inventing.
   - Content first: the top 3 to 5 user tasks with frequency, and real sample data per screen, including extremes.
   - User flows with tap or click counts.
   - Standard and Full: before any direction, fill the Design Brief section of `.ai/ui_specs.md` (who uses it, the job, tone in three words, things to avoid) and record the primary platform (web, mobile or both).
   - Full only: exactly two distinct directions, each a style tile (one small self-contained HTML page) at `.ai/design/direction-a.html` and `.ai/design/direction-b.html`. Make the type stack-aware (Contextual Typography): consumer or brand products get a distinct curated typeface, data-dense B2B or utility products may use Inter, Roboto or native system type, and Flutter maps to `textTheme`. Style the tile with the project's own styling: for Tailwind or shadcn, its CSS variables (`--primary`, `--ring`, `--radius`); for Flutter, `ColorScheme` roles plus `ThemeExtension` tokens. Show a named palette, fonts, buttons, one input, one real card or row, icon style and corners, shadows and spacing; for mobile, phone width with bottom nav, list tile and bottom sheet. Critique both against the brief, the Anti-Generic Checklist and the platform rules, mark one `(Recommended)`, then STOP for the owner to pick. Keep the pick as `.ai/design/style-tile.html`, delete the other.
   - Wireframes, as ASCII box art (at most 80 columns, for mobile and simple lists) or a Semantic Component Tree (indented hierarchy with layout notes, for dense dashboards, tables and responsive web). Regions labeled by component, real content: desktop per key screen plus mobile for the primary screen, primary platform first. For a marketing page, check it against the Marketing pages part of the Anti-Generic Checklist (if this project's `.ai/ui_specs.md` predates it, copy that part from the current nativ template first).
     STOP. Wait for explicit approval.
   - Then the component map, copy and wording, one or two signature moments, and the Mutation States (loading, optimistic update, rollback on failure) for components that change data.
   - Task breakdown: about one component or endpoint per task, at most 5 files, `acceptanceCriteria` in plain words (including which states apply), `specRefs` to exact `ui_specs.md` or `api_contracts.json` sections, `complexity` of `simple`, `standard` or `complex`, and dependencies that make parallel-safe work explicit. Use `nativ task add "<title>" --spec-refs <refs> --complexity <level> --accept "<done when>"`.

### Phase 2: Export

Only after all three approvals, write:

- `.ai/db_schema.json`
- `.ai/api_contracts.json`
- `.ai/ui_specs.md`
- `.ai/master_plan.json`: milestones and tasks. Each task names its role (`backend`, `frontend`, `database`, `qa-tester`, `flutter-developer`, `devops-agent`, `security-auditor`, `db-migration`), `targetFiles`, dependencies and a `verificationCommand`. Prefer `nativ task add` over hand-editing the plan.

### Phase 3: Hand back

Tell the human the contracts are approved and exported, and that Claude Code can now run `nativ task next` and delegate each task to a worker.

## Resolving escalations

Workers and the project manager escalate contract problems with `nativ task escalate`, which records them in `.ai/escalation.json`. At the start of a session, or when asked:

1. Read the items with `"status": "pending_review"`.
2. Explain each one to the human in the four-part format (what they would see, why, what is safe, options with a recommendation) and STOP for a decision.
3. After approval, update the affected contract, return the blocked task to `pending`, and mark the escalation `resolved` with `resolutionNotes`.
4. Tell the human the blueprint is re-synchronized.

## Connecting the nativ MCP server

In Antigravity: Agent panel, MCP Servers, Manage MCP Servers, View raw config (`mcp_config.json`):

```json
{
  "mcpServers": {
    "nativ": {
      "command": "npx",
      "args": ["-y", "@njeybe/nativ", "mcp", "/absolute/path/to/your/project"]
    }
  }
}
```

If `nativ` is installed globally, use `"command": "nativ"` and `"args": ["mcp", "/absolute/path/to/your/project"]`.

- Read contracts as resources instead of opening files: `nativ://context`, `nativ://master-plan`, `nativ://db-schema`, `nativ://api-contracts`, `nativ://escalation`.
- Use `nativ_status`, `nativ_task_list` and `nativ_doctor` for progress and health, and `nativ_db_status`, `nativ_db_inspect` and `nativ_db_diff` for masked, structure-only database discovery.
- The MCP server has no contract-writing tool. You write contracts directly, after the human approves. Outside Claude Code nothing enforces that boundary for you, so keep to it.

## Talking to the human

Use plain language: what the user would see, why it happens, what is affected and what is safe, then two or three options with the best marked `(Recommended)` and one direct question. Never paste stack traces; collapse raw output in a `<details>` block.
