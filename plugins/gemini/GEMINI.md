# Working in a YonedaRepo repository

YonedaRepo is a Git server built for many agents at once. Locally it is plain Git. The difference is on the server: when you push to `main`, it **merges disjoint concurrent changes for you**, and each push is one transaction. Check the remote first:

```sh
git remote -v        # yoneda::https://api.dev.yonedarepo.com/r… means this skill applies
yoneda status        # base version, pending commits, what main has that you don't
```

## The loop

1. **Commit small and often.** One logical change per commit. Small commits merge cleanly on the server; large ones conflict.
2. **Land with `git push origin main`.** You do not need to pull first:
   - other agents' changes to *different files or lines* are merged on the server, and your push succeeds. The helper prints the landed version and "server merged, run git pull".
   - run `git pull` after a server merge, so your next commit starts from the merged main.
3. **If the push reports a conflict** (the same lines changed on main):
   1. `git pull` (or `yoneda conflicts` to see base/ours/theirs for each path)
   2. resolve the files and commit
   3. `git push origin main` again
4. **Never force-push `main`** (`git push --force`, `+main`). Main only moves forward through landing.
5. **Use a feature branch when the work needs review:**
   1. `git switch -c feature/x`, commit, then `git push origin feature/x`
   2. `yoneda review approve|reject` (a reviewer) and `yoneda check run|status` (the checks the repository's policy requires)
   3. `yoneda land --branch feature/x` lands it once its checks and approvals pass
6. `git push --atomic origin a b` moves several branches in one transaction: all or none.

## Read on the server instead of opening many files

The server answers these from its index, with no checkout. Prefer them to reading file after file:

| Need | Command |
|---|---|
| Where a name or string is used | `yoneda grep <pattern>` |
| Definitions in a file or the repo | `yoneda symbols [path]` |
| Who changed a line and in which landed version | `yoneda blame <path>` |
| History of a path | `yoneda log [path]` |
| The repository as of an earlier landed version | add `--at <version>` to `log`, `grep`, `blame`, `symbols` or `diff` |
| What changed between two commits | `yoneda diff <a> <b>` |

`yoneda help` lists the exact flags.

## Landing gates and other commands

- `yoneda land` lands the current branch's tip. The repository's policy decides whether it needs approvals or checks. A refusal names what is missing (`NOT_READY`, failing checks, approvals).
- `yoneda repo create|list|delete`: repositories created from the CLI land solo (no approvals). `delete` asks for the repository name.
- `yoneda login` signs in through the browser and stores a token. `YONEDA_TOKEN` overrides the stored token.

## Without a checkout: the MCP tools

The `yoneda` MCP server (the account endpoint `/api/v1/mcp`) offers the same operations to agents without a local clone:

- `repo_list`, `repo_create`, `repo_delete`
- every `git_*` and `symbol_*` tool, each with a `repo` argument (id or name)

The write path is `git_commit` (it commits on the server, so there is nothing to push), then `git_land`. A `CONFLICT` result carries base/ours/theirs: resolve them, commit again and land. Read with `git_grep`, `git_blame`, `symbol_list`, `git_log` (`at` for time travel) before falling back to `git_cat_file` on many files.

## Rules

- Keep each commit scoped to its task. Never rewrite published history.
- Treat a conflict as information: re-read the merged main before resolving it.
- Never put tokens in commands, files or commit messages. They come from `YONEDA_TOKEN` or `yoneda login`.
