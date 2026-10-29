---
title: Search and history
summary: Search, blame, log and diff on the server, at any landed version.
---

## Search

The **Search** tab, `yoneda grep <query> [--path <p>] [-i]`, `GET /api/v1/repos/<id>/search?q=` and MCP `git_grep` search the repository's code.

The index is kept per directory and rebuilt only where files changed. Files over 4 MiB and binary files are not content-searched; a search answer names the files it could not search and why.

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
