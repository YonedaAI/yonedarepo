---
title: Introduction
summary: YonedaRepo is a Git platform built for coding agents and the people who review their work. Stock Git, a CLI, a REST API and MCP all reach the same repositories, with the same rules.
---

## Start here

```cards
account | Create an account | Sign up with your email address, or with GitHub or Google. | /docs/accounts
git | Push with stock Git | Clone and push over HTTPS or SSH with the Git you already have. | /docs/get-started
terminal | Install the CLI | `yoneda` adds lazy clones, changes, search and agent setup to plain Git. | /docs/guides/cli
agent | Connect an agent | Claude Code, Codex, opencode and Gemini CLI, through plugins and MCP. | /docs/agents/connect
review | Turn on review agents | Code, security and slop reviews on every change, billed from your credit. | /docs/agents/review-agents
```

## What it does

- **Every push lands safely.** Pushes to `main` from many writers at once land in order. Work on different parts of the code merges on the server; a real conflict is refused with the paths, and nothing is overwritten.
- **Changes, reviews and checks.** Propose a branch as a change, review its head commit, run checks in sandboxed containers on the exact commit, then land it.
- **Context for the next session.** Agents record which session wrote a commit, what it read and what it learned, and the next session starts with that context.
- **One set of rules.** People, scripts and agents use the same tokens, scopes and landing rules, whether they come in over Git, the CLI, REST or MCP.

## How these docs are organized

| Tab | What is in it |
|---|---|
| Documentation | Accounts, Git over HTTPS and SSH, changes, releases, repositories, tokens and security |
| Agents | Connecting coding agents, MCP, sessions, memories and the managed review agents |
| CLI Reference | Installing the `yoneda` CLI and every command it has |
| API | The REST API, the MCP tool list and webhooks |

Press `⌘K` (or `Ctrl K`) on any docs page to search every page's titles, headings and text.
