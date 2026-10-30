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

## Review

```sh
yoneda change show 12                       # gates, reviews, comments and files
yoneda change comment 12 -m "Cap at 30 s" --path src/retry.ts --line 14 --side new
yoneda change comment 12 -m "Done" --path src/retry.ts --line 14 --side new --resolve
yoneda review approve <head-sha>
yoneda review reject <head-sha> -m "Breaks the retry budget"
```

An approval is a review of the change's **head commit** by an account other than the head's author. The platform refuses an author's own approval, including through a token the author created. Pushing a new head means earlier approvals stop counting. A rejection needs a reason.

Comments are at most 8,000 bytes, and a comment holding a credential is refused. Unresolved comments show among the gates.

Owners can let changes that only touch docs, formatting or comments count as approved (`auto_approve` in the landing rules). Anything that cannot be classified needs a human.

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

A landed change stays as history; a deleted change's number is never reused.

## In the web app

The **Changes** page lists open, landed and closed changes. A change page shows the diff with line comments, the gates, **Rebase on main** while the branch is behind, and **Land on main** once the gates pass.
