---
title: Sessions
summary: Record which coding session produced a commit, what it read, and hand its context to the next one.
---

## What a session record holds

A session record links a commit to the coding session that wrote it: the agent CLI, the model, a summary, the session's own id and how many files it declared as read. Records are listed newest first on the **Agents → Sessions** tab, filterable by CLI, model and branch.

A record can also carry the session's **transcript**: the context it started with, then its prompts, tool calls with input and output, and replies. The session's page shows it as turns, with tool calls collapsed and named by file or command.

## Record sessions automatically

The agent plugins record sessions for you:

| Agent | Setup |
|---|---|
| Claude Code | `yoneda setup claude` (plugin with hooks) |
| opencode | `yoneda setup opencode` (plugin) |
| Codex | `yoneda setup codex` (skill and MCP) |
| Gemini CLI | `yoneda setup gemini` (extension and MCP) |

With hooks installed, a session starts with the repository's context, records each file it reads, and records itself on its commits when it ends, uploading its transcript (Claude Code and opencode).

## Record by hand

```sh
yoneda session record HEAD --cli my-agent --model my-model --summary "Add retry helper"
yoneda session record HEAD --cli claude-code --summary "…" --transcript session.jsonl
yoneda session list HEAD
```

`--transcript` takes a Claude Code JSONL file, opencode messages, or `{context, turns}`. `--transcript-ref` instead names a transcript kept elsewhere (a URL or an id).

## Transcripts

- **Redacted before storage.** Every credential the platform's 11 rules recognize is replaced with `[REDACTED:<rule>]`. These are the same rules that scan pushes. A credential written JSON-escaped can slip through, so keep secrets out of sessions rather than relying on redaction.
- **Bounded.** A stored transcript is at most 1 MiB and 2,000 turns. Each text keeps its start and end, and the middle is cut. Past that, the opening prompt and the latest turns stay, and the rest is counted as omitted. The CLI fits uploads to 3 MiB first.
- **Readable by the repository's readers.** Anyone for a public repository; for a private one, non-members get "not found". Over the API: `GET /repos/<id>/sessions/<session>/transcript`.
- **Stored with the repository** in object storage, named by SHA-256, and deleted with it.

The default session id is `$YONEDA_SESSION_ID`, or opencode's session when it runs inside one.

## Declared reads

A session can declare the files it read. When it pushes, landing refuses the push if any of those files changed on `main` meanwhile, instead of merging a change built on stale code:

```sh
yoneda reads add src/retry.ts src/http.ts
yoneda push                    # git push -o yoneda.reads=…, then clears the reads
```

On a refusal: `git pull --rebase`, re-check the named paths, push again.

## Context for the next session

```sh
yoneda context [--max-bytes <n>] [--json]
```

prints what a new session should know, within a byte budget: `main`'s head and log version, the landing rules, recent sessions with their summaries, open change requests (this branch's first) and symbol contracts on the files you are changing. It says how many entries it left out. The hooks put this text at the start of each agent session. Over MCP the same read is `git_context`, and `git_sessions_recent` lists recent sessions.
