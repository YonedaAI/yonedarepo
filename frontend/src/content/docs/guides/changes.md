---
title: Changes
summary: Propose a branch, review it, run checks and land it.
---

## Landing without a change

Pushing to `main` lands directly when the landing rules allow it (for example, a repository with no required approvals). Disjoint edits from other writers merge on the server; same-line overlaps are refused with the path:

```text
remote: conflict in src/retry.ts
 ! [remote rejected] main -> main (conflict in src/retry.ts: run git pull)
```

`yoneda conflicts` lists the paths of the last refused landing again. Nothing is rebased or overwritten automatically.

## Open a change

Push a working branch. When it has no open change, the push suggests one:

```sh
git push origin retry
yoneda change create retry --title "Retry on 503" -m "Adds backoff"
```

A change lands on `main` unless `--base <branch>` names another existing branch. One branch has at most one open change.

## Review

```sh
yoneda change show 12                       # gates, reviews, comments and files
yoneda change comment 12 -m "Cap at 30 s" --path src/retry.ts --line 14 --side new
yoneda review approve <head-sha>
```

An approval is a review of the change's **head commit** by an account other than the head's author. The platform refuses an author's own approval, including through a token the author created. Pushing a new head needs a new approval.

Owners can let changes that only touch comments, docs or formatting be approved automatically (`auto_approve`). Anything that cannot be parsed needs a human.

## Checks

Required checks are named in the landing rules. A **command runner** runs argv in a fresh container on the exact commit:

```json
{ "runners": { "test": { "command": ["npm", "test"], "timeout_seconds": 600 } },
  "required_checks": ["test"] }
```

The container has Git, Python, Node with TypeScript, and Rust, and no network. A **model runner** grades the commit's diff and message against your rubric with one model call and records `{verdict, score, findings}`:

```json
{ "runners": { "security": { "kind": "model", "rubric": "Reject SQL built from user input." } },
  "required_checks": ["security"] }
```

A diff over 60,000 characters fails a model check unless `allow_truncated` is set. Run or inspect checks with `yoneda check run <name>` and `yoneda check status`.

## Land

```sh
yoneda change land 12
```

Landing on a protected branch needs the required approvals and checks on the head. Landings on a busy branch are batched into one merge commit. When a check fails after landing, the platform proposes a repair commit instead of rewriting history.

## In the web app

The **Changes** tab lists open, landed and closed changes. A change page shows the diff with line comments, the gates and the **Land** button once they pass.
