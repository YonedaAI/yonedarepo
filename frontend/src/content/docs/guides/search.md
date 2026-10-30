---
title: Search and history
summary: Search code, memories, commits, sessions and changes on the server, and read blame, logs and diffs at any landed version.
---

## Search

```sh
yoneda search "retry budget"                       # code, memories, commits, sessions, changes
yoneda search backoff --in code,commits --limit 20
yoneda grep "fn backoff" --path src/ -w            # code only
```

The **Search** page, `GET /api/v1/repos/<id>/search?q=` and MCP `git_grep` run the same search.

- **Code** results are ranked: files where the query is a whole word (`test`, not `latest`) first, then files whose path matches, then files where it only appears inside words; within each, more matches first, then by path. `-w` (`word=true`, the **Whole words** toggle) leaves out matches inside words, and `-i` ignores case.
- **Memories, commits, sessions and changes** are the records holding every word of the query, ranked by where the words appear, then newest first.
- A query is 2 to 200 characters. Code returns 50 files by default (at most 200); each other group 10 (at most 50).

The index is kept per directory and rebuilt only where files changed. Binary files and text files over 4 MiB are not content-searched; a search answer lists them by path with the reason.

## Reading at a version

Every landing gets a version number in the repository's transaction log. Reads take `--at <version>` (or `at=` in the API) to answer as of that version:

```sh
yoneda log src/retry.ts --at 180
yoneda grep backoff --at 180
yoneda blame src/retry.ts --at 180
yoneda diff main retry --path src/
yoneda symbols src/retry.ts --at 180
```

## History in the app

- **Commits:** first-parent commits of a branch with their landing versions; branches and tags; the transaction log of every ref move.
- **Blame:** the commit that last changed each line.
- **Overview:** a generated map of the repository's subsystems, with their files, symbols, contracts and how they reference each other.

## Symbols and contracts

`yoneda symbols <path>` lists a file's symbols (Rust, TypeScript and JavaScript). Over the API and MCP, `symbol_get`, `symbol_view` (a symbol with its contract, callers and callees) and `symbol_edit` work on symbols by handle; an edit against a stale handle is refused.
