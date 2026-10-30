---
title: Memories and context
summary: Leave decisions, constraints, gotchas and how-tos next to the code, and hand each new coding session what is relevant to its work.
---

## What a memory is

A memory is something a later session would otherwise have to rediscover, and that the code alone does not say: a **decision**, a **constraint**, a **gotcha** or a **how-to**. It is anchored to the files, directories or symbols it is about, and kept with the repository.

- A session is shown a memory when it starts, when it reads an anchored file, and when its prompt matches, each once per session.
- When the anchored code changes on `main`, the memory reads as **stale** until someone checks it.
- Memories are append-only: retiring or replacing one keeps the old record.

The repository's **Memories** page lists them with their anchors and status.

## Add a memory

```sh
yoneda memory add gotcha -m "The retry budget is shared across all HTTP clients" \
  --anchors src/http.rs#RetryBudget,src/net/
```

- Text is at most 2 KiB; a memory holding a credential is refused.
- Anchors: up to 20 files, directories (ending in `/`) or symbols (`path#Type::method`).
- `--supersedes <id>` replaces an older memory that is now wrong; `--commit <sha>` writes it against a commit other than `main`'s head.
- Inside an agent session, the memory links to the session in `$YONEDA_SESSION_ID`.

Over MCP: `git_memory_add`. Adding a memory needs write.

## Read and retire

```sh
yoneda memory list --path src/http.rs
yoneda memory list --kind gotcha --status stale
yoneda memory show 14
yoneda memory retire 14 -m "Each client has its own budget now"
```

`--status` takes `current` (the default: active memories and drafts), `active`, `stale`, `draft`, `retired`, `superseded` or `all`. A retired memory is kept but no longer shown to sessions.

| CLI | MCP | REST |
|---|---|---|
| `memory add` | `git_memory_add` | `POST /repos/<id>/memories` |
| `memory list` | `git_memory_list` | `GET /repos/<id>/memories` |
| `memory show` | `git_memory_show` | `GET /repos/<id>/memories/<n>` |
| `memory retire` | `git_memory_retire` | `POST /repos/<id>/memories/<n>/retire` |

Memories describe the whole repository, so path-restricted tokens cannot read or write them.

## Context for a session

```sh
yoneda context --max-bytes 8000
```

prints what a new session should know, within a byte budget: `main`'s head, the landing rules, the current memories ranked for the files this clone is changing, recent sessions, open changes and symbol contracts. The Claude Code and opencode hooks put it at the start of each session.

To rank context for specific files, symbols or a task description, use MCP `git_context_relevant` (or `GET /repos/<id>/context/relevant`): memories, contracts, recent sessions and open changes, ordered by where each is anchored (the named symbol, then the file, then its directory), then matching words, then fresh before stale, then newest.

See [Sessions and transcripts](/docs/guides/sessions) for what sessions record.
