---
title: Break glass and automation pause
summary: When checks or agents are down, the repository owner can land or revert by hand, or pause all automation.
---

## Who can use it

Only the repository owner, in their own signed-in browser session. Admin members, personal and repository tokens, and MCP are refused with `Break-glass recovery is only for a signed-in human owner`.

## Land or revert by hand

On a commit's page, when its gates are not ready, the owner sees **Break glass…**. It offers to land the commit without its gates, or to revert it. Use it when a required check cannot run and work must land anyway; the action is recorded with your reason.

## Pause automation

Pausing stops automated work on a repository while you investigate:

- For everyone except the owner, landing, the land queue, posting and claiming checks, repairs and bisect steps are refused with HTTP 423 `AUTOMATION_PAUSED`: `The repository owner paused automation`.
- The managed [review agents](/docs/agents/review-agents) start no new runs, and a run that has not started reviewing stops.
- Reads, commits and pushes to working branches keep working.

There is no button for it yet. From a browser where you are signed in as the owner, the API call is:

```http
POST /api/v1/repos/<id>/break-glass
Content-Type: application/json

{"action": "pause_automation", "reason": "flaky check runner"}
```

Resume with `"action": "resume_automation"`. A reason is required. The same endpoint also takes `land`, `revert` and `release_land_lease`.
