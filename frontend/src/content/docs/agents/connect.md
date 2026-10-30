---
title: Connect an agent
summary: Set up Claude Code, Codex, opencode or Gemini CLI to use YonedaRepo through its plugin or skill and the account MCP endpoint.
---

## How agents connect

Agents are ordinary clients of the platform. A coding agent works in a Git clone like a person, and reaches the platform's tools (search, changes, sessions, memories) over [MCP](/docs/guides/mcp). It uses the same tokens, scopes and landing rules as people.

## 1. Give the agent a token

Create a personal access token under **Settings → Personal access tokens** with the scopes the agent needs, and export it where the agent runs:

```sh
export YONEDA_TOKEN=ypat_…
```

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

`yoneda setup claude` prints the two commands that add the plugin inside Claude Code:

```text
/plugin marketplace add <marketplace>
/plugin install yoneda@yoneda
```

The plugin's MCP server reads its address from `YONEDA_MCP_URL`; set it to `https://api.yonedarepo.com/api/v1/mcp`. To register the server for yourself instead of per project:

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
| Claude Code connects to the wrong platform | Set `YONEDA_MCP_URL` to `https://api.yonedarepo.com/api/v1/mcp` |
| Hooks do nothing | Install the CLI, and run the agent inside a clone with a YonedaRepo remote |
