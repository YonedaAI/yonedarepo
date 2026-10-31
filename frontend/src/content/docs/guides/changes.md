---
title: Landings and review
summary: Propose a branch as a Landing, review its head commit, run checks on the exact commit and land it.
---

## When you need a Landing

A push to `main` lands directly when the [landing rules](/docs/guides/repositories#landing-rules) allow it, for example in a repository with no required approvals. When the rules require approvals or checks, propose the work as a **Landing** and land it once it is cleared. The API, MCP tools, CLI and webhooks call a Landing a **change**: `yoneda change`, `git_change_*`, `/changes` and `change.*`.

## Open a Landing

Push a working branch, then open the Landing. When a pushed branch has no open Landing, the push suggests one.

```sh
git push origin retry
yoneda change create retry --title "Retry on 503" -m "Adds backoff"
```

- A Landing lands on `main` unless `--base <branch>` names another existing branch.
- A branch has at most one open Landing; `main` and release branches cannot be proposed.
- From a fork, `--to-parent` proposes the branch to the parent repository; see [Forks](/docs/guides/forks).

## A Landing for every push

Two switches under **Settings → Landing rules**, both off, set each repository's automatic Landings (a third, [Land when cleared](#land-when-cleared), lands them):

| Switch | What it does |
|---|---|
| Open a Landing for every pushed branch | A push opens one Landing on `main`, titled with the commit's subject. It costs nothing and starts no agent. |
| Run agents on automatic Landings | The agents set up on the repository run on them, at their usual price. |

- A push skips `main`, `release*`, `forks/*`, a head `main` already holds, and a repository with no `main`.
- `yoneda change create` on that branch claims the automatic Landing: your title, body and base replace the push's, and from then on it is a Landing like any other, agents included.
- A Landing someone closed stays closed until it is reopened. A landed branch pushed again gets a new Landing.
- Webhooks hear an automatic Landing open only by asking; see [Webhooks](/docs/guides/webhooks).

## States

The Landings list and page show a state worked out from what the repository holds. The API's `status` stays `open`, `landed` or `closed`.

| State | Means |
|---|---|
| Planned | Open, and marked as a draft in its title (`Draft:`, `WIP:`) |
| In flight | Open |
| Cleared to land | Every required gate passes (shown on the Landing's page) |
| Go-around | A required gate is blocked, so the work goes back (shown on the Landing's page) |
| Landed | On its base branch |
| Closed | Closed without landing |

Work pushed straight to `main` has no Landing of its own. It shows in the list as **Landed directly**.

## Flight plans

Before starting, say what the work sets out to do. It is written on purpose, and prompts are never read for it:

```sh
yoneda flight-plan -m "Retry failed fetches twice" --scope "src/net only"
```

The plan is for this clone's branch, pushed or not (`--branch` and `--change` name another; over MCP, `git_flight_plan`). The change page shows the goal of the newest plan for its branch, and a change with none says **No flight plan**. Plans are encouraged, never required: nothing refuses a push without one. The [Intent drift agent](/docs/agents/review-agents), when you turn it on, compares the goal with the diff. A goal and a scope each hold up to 2,000 bytes, and a plan holding a credential is refused.

## Review

```sh
yoneda change show 12                       # gates, reviews, comments and files
yoneda change route 12                      # its commits, sessions, delivered context and checks
yoneda change comment 12 -m "Cap at 30 s" --path src/retry.ts --line 14 --side new
yoneda change comment 12 -m "Done" --path src/retry.ts --line 14 --side new --resolve
yoneda review approve <head-sha>
yoneda review reject <head-sha> -m "Breaks the retry budget"
```

An approval is a review of the Landing's **head commit** by an account other than the head's author. The platform refuses an author's own approval, including through a token the author created. Pushing a new head means earlier approvals stop counting. A rejection needs a reason.

Comments are at most 8,000 bytes, and a comment holding a credential is refused. Unresolved comments show under Clearance.

Owners can let Landings that only touch docs, formatting or comments count as approved (`auto_approve` in the landing rules). Every commit the landing would bring must qualify, not only the head. Merges, and anything that cannot be classified, need a human.

## Checks

Required checks are named in the landing rules. A **command runner** runs a command in a fresh container on the exact commit:

```json
{
  "runners": { "test": { "command": ["npm", "test"], "timeout_seconds": 600 } },
  "required_checks": ["test"]
}
```

The container has Git, Python, Node with TypeScript, and Rust, and **no network**. Runs start on their own when a commit is recorded.

A **model runner** grades the commit's diff and message against your rubric with one model call and records a verdict, a score and findings:

```json
{
  "runners": { "security": { "kind": "model", "rubric": "Reject SQL built from user input." } },
  "required_checks": ["security"]
}
```

A diff over 60,000 characters fails a model check unless the runner sets `allow_truncated`. Run or read checks with `yoneda check run <name>` and `yoneda check status`.

The managed [review agents](/docs/agents/review-agents) post their results as checks too, so the landing rules can require them.

## Clearance

`yoneda change show <n>` (or `GET /api/v1/repos/<id>/changes/<n>/gates`) lists what the head still needs: each required check, approvals, unresolved comments, freshness against the base and a pause, each **ready**, **waiting** or **blocked** with one line of why.

## Go-around

Findings come back to whoever fixes them, and nothing wakes an agent to do it. The open findings on a change are its unresolved comments on lines:

1. A new session on the branch gets them first in its context, with file and line. `yoneda change show <n>` lists them too, and over MCP they are `go_around` in `git_context` and `git_change_show`.
2. It fixes them and pushes. A push re-runs the review agents, and it drops the head's approvals.
3. Once a reviewer's token has commented on a newer commit, its older findings stop being listed: it looked again. A person's comment stays until it is resolved.

At most 10 are listed, those on the head first, each cut to one line. The change page keeps every comment.

## Land

```sh
yoneda change land 12
```

Landing on a protected branch needs the land scope and the required approvals and checks on the head. If the base moved meanwhile, the platform merges on the server, as on [Concurrent pushes](/docs/guides/pushing). When a branch is behind, you can also [rebase it on the server](/docs/guides/merge-rebase) first.

## Land when cleared

**Settings → Landing rules → Land when cleared**, off by default, has CTC, Code Traffic Control, land an open Landing once it clears, so nobody has to press Land. It looks again whenever something could clear it: a check passing, an approval, a comment resolved, a new head, or a Landing opened. Nothing polls, and it starts no agent.

CTC decides by rules alone, and asks no model. The Landing page shows that same decision: **will land when cleared** and what it's waiting for, or a **go-around** when the work has to change. It lands the exact head it evaluated, against the Landing's base, only when all of these hold:

| Rule | Otherwise |
|---|---|
| Every required check and approval passes on this head | It waits; a failed check or a rejection is a go-around |
| The rules ask for an approval or a check, or the head was approved | It waits: with nothing asked for, pushing would be landing |
| A Landing from a fork has an approval of this head | It waits, whatever the rules accept |
| No failed check on this head, required or not | Go-around |
| No unresolved review comment, and it isn't a draft | It waits |
| Automation isn't paused, and no legal hold applies | It stays open |
| Every path-limited token that worked on it covers all it would land | It stays open |
| Risk isn't High, and the repository isn't full | It stays open with the reason |
| It merges cleanly | Go-around, with the reason |
| No Landing ahead in the queue wrote what it read, or read what it writes | It waits, naming that Landing, and CTC looks again once the way clears |

- A newer push or a rejection that arrives first stops it, even once the landing has joined the queue.
- A refused landing stays open with its reason. Only the next event tries again, and a Landing already cleared when you turn this on lands on its next event.
- After it lands the page says **Landed automatically**, with who approved and the gates that decided it. The log's actor is `platform:land-when-cleared`, and webhooks fire as for any landing.
- Each decision is kept on the Landing with its reasons and the head it judged: `clearances` in `GET /changes/<n>`, the newest 32.
- `yoneda change` and the **Land** button work as before, and don't apply these rules.

**Block landing on unresolved agent findings**, also off by default, refuses every landing on a protected branch, by anyone, while an agent's finding on the Landing is unresolved. A person's comment doesn't count: only Land when cleared waits for those.

## Traffic

When a coding session starts, or reads a file, the platform tells it which open Landings are on the same work, so it can avoid the collision before anything lands:

```text
- Landing 12 ("Retry budget", branch fix) is changing `retry` in src/net.rs
```

The closest come first: the same symbol, then the same file, then a Landing that read the file, since changing it would send that Landing around. A session hears each Landing and file once. It comes with `yoneda context`, the session hooks, `git_context` and `git_context_relevant`. A session's own branch counts as what it is changing, and its own Landing is left out. Nothing is held or refused by a warning. A token limited to some paths can't use these reads at all, and a file quarantine withholds is left out.

**CTC** in a repository's sidebar shows every open Landing: its state, what it's waiting for, its place in line, where it overlaps another Landing and the last decision on it. The line runs queued landings first, then cleared ones, oldest cleared first, then those waiting. A Landing that's only waiting holds nobody up, so one left open can't stop the rest. With Land when cleared off, the page shows what CTC would say and nothing lands on its own. The same answer is `GET /ctc` and `git_ctc_radar`.

## Close, reopen, delete

```sh
yoneda change close 12      # the branch stays
yoneda change reopen 12     # needs the branch, with no other open Landing
yoneda change delete 12     # a closed Landing and its comments (author or owner)
yoneda change list --status all
```

Deleting a Landing's branch closes the Landing, with a comment saying why. It stays closed if the branch comes back; reopen it then.

A landed Landing stays as history; a deleted Landing's number is never reused.

## In the web app

The **Landings** page lists open, landed and closed Landings, and work landed directly. A Landing's page shows the diff with line comments, its clearance, **Rebase on main** while the branch is behind, and **Land on main** once it is cleared. `/landings` and `/changes` reach the same page.
