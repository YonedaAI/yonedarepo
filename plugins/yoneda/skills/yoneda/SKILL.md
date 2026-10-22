---
name: yoneda
description: Use when the current Git repository has a yoneda:: remote (git remote -v shows yoneda::https://...), or when asked to create, clone, read, land or review YonedaRepo repositories, or to use the yoneda CLI or YonedaRepo MCP tools. Not for ordinary GitHub/GitLab remotes.
---

# Working in a YonedaRepo repository

YonedaRepo is a Git server built for many agents at once. Locally it is plain Git, with the platform's own commit ids. The difference is on the server: when you push to `main`, it **merges disjoint concurrent changes for you**, and each push is one transaction. Check the remote first:

```sh
git remote -v            # yoneda::https://api.dev.yonedarepo.com/r… means this skill applies
yoneda status --brief    # one line, no network: repository, branch, commits not on the platform yet
```

## The loop

1. **Commit small and often.** One logical change per commit. Small commits merge cleanly on the server; large ones conflict.
2. **Land with `git push origin main`.** You do not need to pull first:
   - the helper prints `landed <commit> on main at version <n>`.
   - other agents' changes to *different files or lines* are merged on the server, and your push succeeds with `server merged concurrent changes; run git pull`.
   - main may get a platform commit on top of yours (a merge, or the record of your landing). Run `git pull` so your next commit starts from main; it fast-forwards.
3. **If the push reports a conflict** (the same lines changed on main):
   1. `yoneda conflicts` lists the paths of the refused landing
   2. `git pull`, resolve the files and commit
   3. `git push origin main` again
4. **Never force-push `main`** (`git push --force`, `+main`). Main only moves forward through landing.
5. **Use a feature branch when the work needs review:**
   1. `git switch -c feature/x`, commit, then `git push origin feature/x`
   2. a reviewer runs `yoneda review approve <sha>` (or `yoneda review reject <sha> -m <reason>`); `yoneda check run <name>` and `yoneda check status` handle the checks the repository's policy requires
   3. `yoneda land --branch feature/x` lands it once its checks and approvals pass
6. `git push --atomic origin a b` moves several branches in one transaction: all or none.

## Read on the server instead of opening many files

The server answers these from its index, with no checkout. Prefer them to reading file after file:

| Need | Command |
|---|---|
| Where a name or string is used | `yoneda grep <query> [--path <p>] [-i]` |
| Definitions in a file | `yoneda symbols <path>` |
| Who changed each line, and in which commit | `yoneda blame <path> [--ref <b>]` |
| History of the repository or a path | `yoneda log [path] [--ref <b>] [--limit <n>]` |
| What changed between two commits | `yoneda diff <base> <head> [--path <p>]` |
| Any of these as of an earlier landed version | add `--at <version>`, e.g. `yoneda grep <query> --at <version>` |

`yoneda help` lists every command and flag.

## Landing gates and other commands

- `yoneda land --branch <b>` lands a pushed branch's head on main (inside a clone, `yoneda land` uses the current branch). The repository's policy decides whether it needs approvals or checks. A refusal names what is missing (`NOT_READY`, failing checks, approvals).
- `yoneda repo create <name>`, `yoneda repo list`, `yoneda repo delete <id> --confirm <name>`: repositories created from the CLI land solo (no approvals).
- `yoneda login` signs in through the browser and stores a token. `YONEDA_TOKEN` overrides the stored token.
- Outside a clone, add `--repo <id>` (and `--origin <url>`) to repository commands.

## Without a checkout: the MCP tools

The `yoneda` MCP server (the account endpoint `/api/v1/mcp`) offers the same operations to agents without a local clone:

- `repo_list`, `repo_create`, `repo_delete`
- every `git_*` and `symbol_*` tool, each with a `repo` argument (id or name)

The write path is `git_commit` (it commits on the server, so there is nothing to push), then `git_land`. A `CONFLICT` result carries base/ours/theirs: resolve them, commit again and land. Read with `git_grep`, `git_blame`, `symbol_list`, `git_log` (`at` for time travel) before falling back to `git_cat_file` on many files.

## Rules

- Keep each commit scoped to its task. Never rewrite published history.
- Treat a conflict as information: re-read the merged main before resolving it.
- Never put tokens in commands, files or commit messages. They come from `YONEDA_TOKEN` or `yoneda login`.
