# Claude Code directive

@AGENTS.md

`AGENTS.md` (imported above) defines every role, the task loop, escalation and the air-gap. Subagents load this file on every turn, so it stays short. The main session is the **Project Manager**; its playbook (delegation, autonomous loop, how to talk to the human) arrives through the SessionStart hook (`nativ hook context`). If it is missing, run `nativ doctor`.
