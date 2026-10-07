# Running nativ hands-free

This guide covers how nativ keeps working without you: how agents claim tasks, what happens when something goes wrong, and when and how nativ asks for you. Each step links to its command in the [README](../README.md).

## The loop

The project manager agent repeats this until the milestone is done:

1. `nativ task next` picks the next task whose dependencies are complete.
2. `nativ task start <taskId>` **claims** it. The task must be pending, not blocked, and its dependencies finished. The claim records who took it (`--agent`, or `NATIV_AGENT_ID`) and when.
3. A worker agent does the task inside its `targetFiles`.
4. `nativ task complete <taskId>` runs the verification gatekeeper and completes the task only if it passes.

Give each parallel agent its own `NATIV_AGENT_ID`. Another agent's `task start` on a task with a claim younger than 4 hours is refused, so two agents never do the same work.

## When something goes wrong

nativ climbs this ladder and stops at the first rung that fixes the problem. Only the last rung reaches you.

| Problem | What happens | Who acts |
| :--- | :--- | :--- |
| Verification fails | The worker fixes the cause and retries, up to three times | Agent |
| A contract lacks a small additive detail (a nullable column, an optional field, a new route) | `nativ task propose-patch`; the Contract Governor applies safe additions | Agent |
| Anything else about a contract | `nativ task escalate`, then triage (`nativ_triage` over MCP, or `nativ triage --all --apply --json`) proves safe fixes in a sandbox and unblocks the task | Agent |
| An agent crashed or its session closed, leaving a task `in_progress` | `nativ task reclaim` returns claims older than 4 hours to pending; new sessions are told which tasks are stale | Agent |
| An AI provider has a network blip or a 5xx error | The call is retried twice with a short, jittered wait, then the next provider is tried | Automatic |
| A destructive change, a credential, or the same failure three times in a row | Triage returns `REQUIRE_HUMAN_DECISION`, or the circuit breaker blocks the task | **You** |

## When nativ needs you

You get a four-part decision card: what the user would see, why it happened, what is affected, and your options. Answer it with `nativ triage <escalationId>` or in Studio's Self-Healing tab.

To be told without watching the terminal, add a webhook or a command to `.nativ/config.json`. Git ignores that file, so a webhook token stays on your machine:

```json
{
  "notify": {
    "webhook": "https://hooks.slack.com/services/...",
    "events": ["human_decision", "circuit_breaker_tripped"]
  }
}
```

- Slack and ntfy read the message from `text`, Discord from `content`, and any other JSON endpoint gets the task, escalation, question, options and next step as separate fields.
- A `"command"` gets the same JSON on stdin and in `NATIV_NOTIFY_JSON`. For example, `"command": "notify-send nativ \"$(jq -r .text)\""` shows a desktop notification on Linux.
- Each escalation is announced once. A failed delivery never stops the workflow; it is recorded in `.nativ/notify-state.json` and tried again the next time that escalation comes up.
- Run `nativ notify test` to check the setup.

## Starting a fresh session

The SessionStart hook prints a short orientation: the active task, the next one, blocked tasks, stale tasks and pending escalations, each with the command that handles it. The plan in `.ai/master_plan.json`, not the chat history, is what a new session resumes from.
