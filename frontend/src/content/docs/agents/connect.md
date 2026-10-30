---
title: Connect an agent
summary: Set up Claude Code, Codex, opencode or Gemini CLI to use YonedaRepo through its plugin or skill and the account MCP endpoint.
---

## How agents connect

Agents are ordinary clients of the platform. A coding agent works in a Git clone like a person, and reaches the platform's tools (search, changes, sessions, memories) over [MCP](/docs/guides/mcp). It uses the same tokens, scopes and landing rules as people.

## 1. Give the agent a token

Export a token where the agent runs. With the [CLI](/docs/guides/cli) signed in, reuse its login:

```sh
export YONEDA_TOKEN=$(yoneda auth token)
```

Or create a personal access token under **Settings → Personal access tokens** with only the scopes and repositories the agent needs, and export that.

Every setup below reads the token from `YONEDA_TOKEN` when the agent starts; none of them writes a token into a file.

## 2. Set up the agent

With the [CLI](/docs/guides/cli) installed:

```sh
yoneda setup claude      # or: codex, gemini, opencode
```

| Agent | What `yoneda setup` writes | Hooks |
|---|---|---|
| Claude Code | `.mcp.json` in the current directory, then prints the plugin install commands | Yes, with the plugin |
| Codex | `[mcp_servers.yoneda]` in `~/.codex/config.toml` (or `$CODEX_HOME`), and the skill in `~/.agents/skills/yoneda/` | No |
| opencode | The plugin in `~/.config/opencode/plugins/yoneda/`, and the MCP entry in `opencode.json` | Yes |
| Gemini CLI | The extension in `~/.gemini/extensions/yoneda/`, and the MCP entry in `~/.gemini/settings.json` | No |

All of them point at the account MCP endpoint, `https://api.yonedarepo.com/api/v1/mcp` (`--origin <url>` for another platform).

### Claude Code plugin

Inside Claude Code (version 2.1.224 or later), add YonedaRepo's marketplace and install the plugin. `yoneda setup claude` prints the same two commands:

```text
/plugin marketplace add https://yonedarepo.com/downloads/claude/marketplace.json
/plugin install yoneda@yonedarepo
```

The marketplace is served by yonedarepo.com and the plugin is a download pinned by its SHA-256, so you need no GitHub or other Git account. The plugin connects to `https://api.yonedarepo.com/api/v1/mcp`; `YONEDA_MCP_URL` points it at another platform. To register the MCP server for yourself instead of per project:

```sh
claude mcp add --transport http --scope user yoneda https://api.yonedarepo.com/api/v1/mcp \
  --header "Authorization: Bearer \${YONEDA_TOKEN}"
```

## What the hooks do

In a clone with a YonedaRepo remote, the Claude Code and opencode plugins:

- **Start each session with context:** the repository's memories, recent sessions, open changes, landing rules and contracts.
- **Track what the session reads.** Files it reads become the next push's [declared reads](/docs/guides/sessions#declared-reads), and the memories and contracts on them are added as context.
- **Add context for each prompt** that is relevant to it.
- **Send pushes through `yoneda push`**, so the declared reads travel with them.
- **Record the session** on each commit it pushed, with its transcript (credentials redacted), and offer a draft [memory](/docs/agents/memories).

The hooks run the `yoneda` CLI, so it must be installed where the agent runs. Codex and Gemini CLI get the skill and MCP tools without hooks; they can call the same tools directly.

## Without the CLI

Any MCP client can connect with a JSON configuration; see [MCP](/docs/guides/mcp#configure-a-client). Git itself works with a token over [HTTPS](/docs/guides/git-remotes).

## Troubleshooting

| Symptom | What to do |
|---|---|
| The agent's MCP calls answer 401 | `YONEDA_TOKEN` is not set in the agent's environment, or the token expired |
| `/plugin marketplace add` fails on the URL | Update Claude Code: URL marketplaces with downloaded plugins need 2.1.224 or later |
| Claude Code connects to the wrong platform | Unset `YONEDA_MCP_URL`, or set it to the platform you mean |
| Hooks do nothing | Install the CLI, and run the agent inside a clone with a YonedaRepo remote |
