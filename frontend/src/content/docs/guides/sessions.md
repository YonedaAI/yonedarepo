---
title: Sessions
summary: Record which coding session produced a commit, what it read, and hand its context to the next one.
---

## What a session record holds

A session record links a commit to the coding session that wrote it: the agent CLI, the model, a summary, the session's own id and how many files it declared as read. Records are listed newest first on the **Agents → Sessions** tab, filterable by CLI, model and branch.

Full transcripts are **coming**: a record can already carry a `--transcript-ref`, but the platform does not store or show transcripts yet.

## Record sessions automatically

The agent plugins record sessions for you:

| Agent | Setup |
|---|---|
| Claude Code | `yoneda setup claude` (plugin with hooks) |
| opencode | `yoneda setup opencode` (plugin) |
| Codex | `yoneda setup codex` (skill and MCP) |
| Gemini CLI | `yoneda setup gemini` (extension and MCP) |

With hooks installed, a session starts with the repository's context, records each file it reads, and records itself on its commits when it ends.

## Record by hand

```sh
yoneda session record HEAD --cli my-agent --model my-model --summary "Add retry helper"
yoneda session list HEAD
```

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
