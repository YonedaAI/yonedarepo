---
title: Forks
summary: Fork a repository you can read, work on the fork, and propose a branch back to the parent.
---

## Fork

```sh
yoneda repo fork <id> [--name <name>] [--owner <org>]
```

Or **Fork** on the repository's page. A fork is a new repository on your account (or an organization's), with the parent's branches and tags as they are now. History is shared, not copied, so forking is quick at any size.

- Forking needs read on the whole parent: as a member, through a team, or because it is public.
- It needs an account credential (a signed-in session, or a personal access token with `repo:admin`), never a repository token.
- A fork starts **private**; change its visibility like any repository.
- Forks of forks are allowed, up to 4 levels deep.

Over the API: `POST /api/v1/repos/<id>/fork`; over MCP: `git_fork`.

## Propose a branch to the parent

Push a branch to your fork, then open a change on the parent from inside the fork's clone:

```sh
git push origin fix-timeout
yoneda change create fix-timeout --to-parent --title "Fix the timeout"
```

The branch's new commits are carried into the parent as the branch `forks/<fork>/<branch>`, and the change proposes that branch to the parent's `main`. Later pushes to your branch follow into the change. Proposing needs read on the parent and write on the fork. The parent's landing rules decide when it lands, as for any [change](/docs/guides/changes).

## Deleting

A repository with forks cannot be deleted until its forks are.
