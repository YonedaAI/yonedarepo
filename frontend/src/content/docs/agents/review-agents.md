---
title: Review agents
summary: Code review, Security review and Slop review run on your changes, post their findings as line comments and a check, and are billed from your credit.
---

## The agents

YonedaRepo maintains three review agents. Each reviews an open change's diff, read only, and reports on the lines the change added.

| Agent | Looks for | Runs on | Result |
|---|---|---|---|
| **Code review** | Logic and off-by-one errors, error handling, races, missing awaits, unintended behavior changes, and breaks of the repository's own `REVIEW.md`, `AGENTS.md` or `CLAUDE.md` rules. Skips formatting and anything a linter reports. | Codex, `gpt-5.6-luna` | Pass or fail |
| **Security review** | Injection, missing authorization checks, committed or logged secrets, SSRF, XSS, unsafe deserialization, weak cryptography, privilege escalation | Claude Code, `claude-sonnet-5-5` | Pass or fail |
| **Slop review** | Dead or duplicated code, debug leftovers, drift from the repository's conventions, oversized files, filler comments | opencode, `mimo-v2.6-flash` | A level: low, medium or high (lower is better) |

The agents never edit, commit, push or use the network, and cannot land, approve or change policy: their token holds only read, review and check. The repository's `REVIEW.md`, `AGENTS.md` and `CLAUDE.md`, as they are at the change's base, are part of each review.

## Turn them on

1. Open **Agents** in the app's sidebar (the page **Managed by YonedaRepo**).
2. On an agent's card choose **Enable**.
3. Pick the repositories under **Repositories**, adjust the settings if you like, and choose **Enable agent**.

Only an owner can turn an agent on for a repository (for an organization's repositories, an organization owner). Turning one on adds a repository token named `yoneda-managed-agents` and a webhook to the repository; turning off the last agent removes both and cancels open runs. **Edit** and **Disable** on the card change it later. A repository's **Settings → Plugins** links to the same page.

## Settings

| Setting | Meaning |
|---|---|
| Harness, Model, Reasoning | Which agent CLI and model run the review (defaults above) |
| Timeout (minutes) | 5 to 30; default 20 (Slop review 15) |
| Instructions | What the agent looks for; **Reset to the maintained instructions** restores ours |
| When to run | **On every push** (default) or **When marked ready** (once, when the change opens) |
| Paths, Branches | Optional filters; branches take `prefix/*` |
| Block landing at | Slop review only: **Never (report only)** (default), **Medium or higher** or **High** |

## When they run

An agent runs when a change is opened and, with **On every push**, each time its branch moves. Each run reviews one head commit. A newer push replaces a run still going on an older head. There is no manual run button.

## What they post

On the change:

- **Line comments**, one per finding, at most 20, each on a line the change added.
- **A summary comment.**
- **A check** named after the agent (`code-review`, `security-review`, `slop-review`) on the head commit. Code review and Security review fail it when they post a high or medium finding. Slop review fails it only at or above **Block landing at**.

Findings that cannot be placed on a line of the diff, or that look like a credential, are left out.

A failed check blocks landing only when the repository's [landing rules](/docs/guides/repositories#landing-rules) list it in `required_checks`; otherwise it is advice.

## Runs

**Agents → View runs** lists every run; a run's page shows its findings, its redacted transcript and its cost.

| Status | Meaning |
|---|---|
| Queued, Running | Waiting for or using a container |
| Passed | No blocking findings |
| Found issues | The check failed |
| Paused (no credit) | The credit ran out; see [Credit and usage](/docs/agents/review-credit) |
| Replaced by a newer push | A newer head is being reviewed instead |
| Stopped, Failed | Cancelled, or the run could not finish |

Pausing a repository's automation (see [Break glass](/docs/guides/break-glass)) stops new runs too.
