---
title: Search and history
summary: Search, blame, log and diff on the server, at any landed version.
---

## Search

The **Search** tab, `yoneda grep <query> [--path <p>] [-i] [-w]`, `GET /api/v1/repos/<id>/search?q=` and MCP `git_grep` search the repository's code.

Results are ranked: files where the query is a whole word (`test`, not `latest`) first, then files whose path matches, then files where it only appears inside words; within each, more matches first, then by path. `-w` (`word=true`, the **Whole words** toggle) leaves out the matches inside words. Each line carries the ranges that matched, and each file its match count.

The index is kept per directory and rebuilt only where files changed. Binary files are not content-searched and not listed. Text files over 4 MiB are not content-searched either; a search answer names them.

## Reading at a version

Every landing gets a version number in the repository's transaction log. Reads take `--at <version>` (or `at=` in the API) to answer as of that version:

```sh
yoneda log src/retry.ts --at 180
yoneda grep backoff --at 180
yoneda blame src/retry.ts --at 180
yoneda diff main retry --path src/
yoneda symbols src/retry.ts
```

## History in the app

- **History:** first-parent commits of a branch with their landing versions; branches and tags; the transaction log of every ref move.
- **Blame:** the commit that last changed each line.
- **Code → Overview:** a generated map of the repository's subsystems, with their files, symbols, contracts and how they reference each other.

## Symbols and contracts

`yoneda symbols <path>` lists a file's symbols. Over the API and MCP, `symbol_get`, `symbol_view` (a symbol with its contract, callers and callees) and `symbol_edit` work on symbols by handle; an edit against a stale handle is refused.
