---
title: Server-side merge and rebase
summary: Rebase a working branch, merge, revert and cherry-pick on the server, without a local clone.
---

## Rebase a branch

```sh
yoneda rebase retry                 # onto main's head
yoneda rebase retry --onto release  # onto another branch
```

The platform replays the branch's commits that are not on the target, oldest first, each as a three-way merge, then moves the branch in one compare-and-swap. It prints `Rebased retry onto main: 3 commit(s) replayed, now at <sha>`.

- At most 100 commits are replayed.
- Protected branches cannot be rebased: they move only by landing.
- A branch with merge commits is refused (`NOT_SUPPORTED`).
- A conflict leaves the branch unchanged and names each conflicting path.
- A push to the branch while it is being rebased answers `STALE_HEAD`; run it again.

In the web app, an open change shows **Rebase on main** (or its base) while its branch is behind.

Over the API: `POST /api/v1/repos/<id>/branches/<branch>/rebase` with `{"onto": "main"}`; over MCP: `git_rebase`.

## Merge

`POST /api/v1/repos/<id>/merges` (MCP `git_merge`) creates a merge commit of a branch or commit into a branch, without landing it:

```json
{ "source": "retry", "into": "main" }
```

It answers `up_to_date` or `fast_forward` when no merge commit is needed. A conflict answers `CONFLICT` with diff3-marked text per path. With `"on_conflict": "workspace"` you get a two-parent commit holding every cleanly merged path, plus the list of conflicting paths to resolve in a follow-up commit.

Land the result with `POST /land` or `yoneda land`.

## Revert and cherry-pick

| Operation | API | MCP |
|---|---|---|
| Undo a commit on top of a branch | `POST /commits/<sha>/revert` | `git_revert` |
| Re-apply a commit on top of a branch | `POST /commits/<sha>/cherry-pick` | `git_cherry_pick` |

Both create a commit without landing it, and fail with `CONFLICT` when the branch changed the same paths.
