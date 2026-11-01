---
title: Review agents
summary: Code review, Security review, Slop review and Intent drift run on your changes, post their findings and a check, and are billed from your credit.
---

## The agents

YonedaRepo maintains four review agents. Each reviews an open change's diff, read only. The first three report on the lines the change added; Intent drift gives one verdict on the whole change.

| Agent | Looks for | Runs on | Result |
|---|---|---|---|
| **Code review** | Logic and off-by-one errors, error handling, races, missing awaits, unintended behavior changes, and breaks of the repository's own `REVIEW.md`, `AGENTS.md` or `CLAUDE.md` rules. Skips formatting and anything a linter reports. | Codex, `gpt-5.6-luna` | Pass or fail |
| **Security review** | Injection, missing authorization checks, committed or logged secrets, SSRF, XSS, unsafe deserialization, weak cryptography, privilege escalation | Claude Code, `claude-sonnet-5-5` | Pass or fail |
| **Slop review** | Dead or duplicated code, debug leftovers, drift from the repository's conventions, oversized files, filler comments | opencode, `mimo-v2.6-flash` | A level: low, medium or high (lower is better) |
| **Intent drift** | Whether the diff does what the change's [flight plan](/docs/guides/changes#flight-plans) set out to do, and nothing it ruled out. A change with no plan starts no model and costs nothing. | opencode, `mimo-v2.6-flash` | A level: low on course, medium partly, high off course |

The agents never edit, commit, push or use the network, and cannot land, approve or change policy: their token holds only read, review and check, including the right to post their own checks when your landing rules require them. The repository's `REVIEW.md`, `AGENTS.md` and `CLAUDE.md`, as they are at the change's base, are part of each review.

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
| Block landing at | Slop review and Intent drift: **High** (default), **Medium or higher** or **Never (report only)** |

## When they run

An agent runs when a change is opened and, with **On every push**, each time its branch moves. Each run reviews one head commit. A newer push replaces a run still going on an older head. There is no manual run button.

## What they post

On the change:

- **Line comments**, one per finding, at most 20, each on a line the change added.
- **A summary comment.**
- **A check** named after the agent (`code-review`, `security-review`, `slop-review`) on the head commit. Code review and Security review fail it when they post a high or medium finding. Slop review reports low and medium findings; its level is that of its most serious finding, or high with five or more medium findings on lines of the change. It fails the check only at or above **Block landing at**.

Intent drift posts no line comments. Its summary comment gives the verdict and what drifted, and its check `intent-drift` carries the level: on course is low, partly on course medium, off course high. So by default an off-course change fails the check. With no flight plan the check passes and its evidence says `no_plan`.

Findings that cannot be placed on a line of the diff, or that look like a credential, are left out. So are findings past the 2,000 comments a change can hold; they still count toward the check.

A failed check blocks landing when the repository's [landing rules](/docs/guides/repositories#landing-rules) list it in `required_checks`. With **Land when cleared** on, any failed check sends the Landing around, required or not. Otherwise it is advice. Line comments don't hold a Landing unless **Block landing on unresolved agent findings** is on.

A run that can't finish leaves no reading. If the check is required it fails, and a comment says so: push again to run the agent. If it isn't, nothing is posted.

## Go-around

Nothing wakes an agent when findings arrive. The next session on the branch reads them in its context, with file and line, and so does anyone running `yoneda change show <n>`. It fixes them and pushes, and the push runs the review again. See [Go-around](/docs/guides/changes#go-around).

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

## Pause or turn off

- **Disable** on an agent's card turns it off everywhere and cancels its open runs. To stop it on one repository, **Edit** it and untick the repository.
- **Pausing a repository's automation** (owner only; see [Break glass and automation pause](/docs/guides/break-glass)) stops new runs on that repository, and a run that has not started reviewing stops.
- When the credit runs out, runs pause on their own; see [Credit and usage](/docs/agents/review-credit).

## Where the review runs

Each run uses a fresh container on Cloudflare. Its model calls go through our Cloudflare AI Gateway to the model's provider, which receives the code and text the agent reads; see [Global network and data location](/docs/guides/global#what-leaves-cloudflare).
