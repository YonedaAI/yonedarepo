---
title: yoneda:: remotes and lazy clones
summary: The git-remote-yoneda helper clones commits and trees at once and fetches each file the first time Git needs it, and pushes of any size commit by commit.
---

## Clone

```sh
yoneda clone <repo-id> demo
# the same thing with Git itself:
git clone yoneda::https://api.yonedarepo.com/<repo-id> demo
```

Both need the [CLI](/docs/guides/cli) installed, which brings the `git-remote-yoneda` helper. The remote URL is `yoneda::https://<platform>/<repo-id>` (or `yoneda://<platform>/<repo-id>`). After cloning, `git fetch`, `git pull` and `git push` work as usual.

## Lazy by default

A `yoneda::` clone brings every commit and tree, but no file contents. Git fetches each file the first time it needs it: on checkout, `git diff`, `git blame` and so on. A large repository clones in seconds, and you download only the files you open.

| You want | Run |
|---|---|
| Every object now | `yoneda clone <repo-id> --full` (or `git clone -c yoneda.lazy=false yoneda::…`) |
| Only some directories | `yoneda clone <repo-id> --sparse src,docs` (the top level's files come too) |
| Narrow an existing clone | `yoneda sparse src docs`; `yoneda sparse --add tests` adds more |

Lazy clones need Git 2.44 or newer; older Git gets a full clone.

## Credentials

The helper uses `YONEDA_TOKEN` when set, otherwise the token from `yoneda login`. Cloning through the helper needs a signed-in person's token (a personal access token with `repo:read`); repository tokens (`yrp_`) cannot clone through it. Use [HTTPS](/docs/guides/git-remotes) with a repository token instead.

## Pushing

The helper uploads your commits one by one, so a push is not bound by the 64 MiB pack limit of plain HTTPS and SSH. The commit ids on the platform are the ones you made.

```text
yoneda: landed as 3f2a1c0 at version 184
yoneda: landed 3f2a1c0 at version 185; server merged concurrent changes (main is at 9b1e44d); git pull fast-forwards
```

The first line is a push that fast-forwarded `main`; the second is one merged on the server with other writers' work. A conflict is refused with its paths, as described on [Concurrent pushes](/docs/guides/pushing).

- `git push -o <option>`, `--atomic` and `--dry-run` are supported.
- `git push --force` to `main` is refused: `main moves only by landing; it cannot be force-pushed`.
- Deleting a branch with `git push origin :branch` is not supported through the helper.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `git: 'remote-yoneda' is not a git command` | The helper is not on your `PATH`; see [Install the CLI](/docs/guides/cli) |
| A clone downloads every file | Your Git is older than 2.44; upgrade Git for lazy clones |
| `401` while cloning | Sign in again with `yoneda login`, or set `YONEDA_TOKEN` to a personal access token |
