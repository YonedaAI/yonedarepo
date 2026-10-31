---
title: Changes and review
summary: Propose a branch as a change, review its head commit, run checks on the exact commit and land it.
---

## When you need a change

A push to `main` lands directly when the [landing rules](/docs/guides/repositories#landing-rules) allow it, for example in a repository with no required approvals. When the rules require approvals or checks, propose the work as a **change** (a change request) and land it once its gates pass.

## Open a change

Push a working branch, then open the change. When a pushed branch has no open change, the push suggests one.

```sh
git push origin retry
yoneda change create retry --title "Retry on 503" -m "Adds backoff"
```

- A change lands on `main` unless `--base <branch>` names another existing branch.
- A branch has at most one open change; `main` and release branches cannot be proposed.
- From a fork, `--to-parent` proposes the branch to the parent repository; see [Forks](/docs/guides/forks).

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

An approval is a review of the change's **head commit** by an account other than the head's author. The platform refuses an author's own approval, including through a token the author created. Pushing a new head means earlier approvals stop counting. A rejection needs a reason.

Comments are at most 8,000 bytes, and a comment holding a credential is refused. Unresolved comments show among the gates.

Owners can let changes that only touch docs, formatting or comments count as approved (`auto_approve` in the landing rules). Every commit the landing would bring must qualify, not only the head. Merges, and anything that cannot be classified, need a human.

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

## Gates

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

## Close, reopen, delete

```sh
yoneda change close 12      # the branch stays
yoneda change reopen 12     # needs the branch, with no other open change
yoneda change delete 12     # a closed change and its comments (author or owner)
yoneda change list --status all
```

Deleting a change's branch closes the change, with a comment saying why. It stays closed if the branch comes back; reopen it then.

A landed change stays as history; a deleted change's number is never reused.

## In the web app

The **Changes** page lists open, landed and closed changes. A change page shows the diff with line comments, the gates, **Rebase on main** while the branch is behind, and **Land on main** once the gates pass.
