---
title: Concurrent pushes
summary: How a push to main lands when other people and agents push at the same time. Work on different code merges on the server; real conflicts are refused with their paths.
---

## Protected and working branches

| Branch | How it moves |
|---|---|
| `main`, `release`, `release/*` (protected) | Only by **landing**: a push, `yoneda land`, `yoneda change land` or the **Land** button. Never rewritten or deleted. |
| Every other branch (working) | Like any Git branch, by compare-and-swap on the value Git last saw |

Landing on a protected branch needs the land scope (the `land` or `admin` role) and whatever the [landing rules](/docs/guides/repositories#landing-rules) require: approvals and checks. When they are not met, the push is refused with `Commit cannot land yet` and the missing gates; open a [change](/docs/guides/changes) instead.

## Pushing to main

```sh
git push origin main
```

Your push lands even when `main` moved since you last pulled.

**Fast-forward.** Nobody else landed meanwhile: `main` moves to your commit.

**Server merge.** Others landed work on different lines: the platform merges on the server, and `git pull` then fast-forwards your clone. Git prints:

```text
remote: main: landed with server merge, run git pull
```

**Conflict.** Someone changed the same lines: nothing lands, and Git prints the paths:

```text
remote: conflict in src/retry.ts
remote: next: git pull, resolve the conflicts, commit, git push
 ! [remote rejected] main -> main (conflict in src/retry.ts: run git pull)
```

Nothing is rebased or overwritten for you. `yoneda conflicts` lists the paths of the last refused landing again.

## Read conflicts

A session can declare the files it relied on (see [Declared reads](/docs/guides/sessions#declared-reads)). If one of them changed on `main` after your base, the push is refused even without a textual conflict:

```text
remote: read conflict on src/http.ts: it changed after your base
remote: next: git pull, check your change still holds, git push
```

## Force pushes and deletes

- `git push --force origin main` over HTTPS or SSH lands like any other push: it can never rewrite `main`. Through the `yoneda::` helper it is refused.
- Deleting a protected branch is refused: `main is protected and cannot be deleted`.
- An `--atomic` push cannot include a protected branch: `an atomic push cannot include main: it moves only by landing`.
- Tags never move: `tags are immutable: this tag already exists`.

## Many writers at once

Landings on one branch are serialized in the repository, so a burst of pushes from many agents lands one after another without lost updates. Each landing gets a version number in the repository's transaction log, which reads can name with `--at <version>`; see [Search and history](/docs/guides/search).

## Troubleshooting

| Message | What to do |
|---|---|
| `main: landed with server merge, run git pull` | Nothing is wrong: run `git pull` before your next commit |
| `conflict in <path>: run git pull` | `git pull`, resolve the conflict markers, commit, push again |
| `Commit cannot land yet` | The landing rules need approvals or checks: open a change |
| `main is protected and cannot be deleted` | Protected branches stay; delete working branches only |
