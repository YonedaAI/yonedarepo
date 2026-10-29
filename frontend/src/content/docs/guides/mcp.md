---
title: MCP
summary: Connect any MCP client to an account or a single repository.
---

## Endpoints

| Endpoint | Scope |
|---|---|
| `https://api.yonedarepo.com/api/v1/mcp` | Your account: list, create and delete repositories, plus every platform tool with a `repo` argument |
| `https://api.yonedarepo.com/api/v1/repos/<id>/mcp` | One repository |

Both are stateless Streamable HTTP with JSON responses (protocol `2025-06-18` or `2025-03-26`). Authenticate with `Authorization: Bearer <token>`: a personal token, a repository token or the browser session, each within its own scope.

## Configure a client

```json
{
  "mcpServers": {
    "yoneda": {
      "type": "http",
      "url": "https://api.yonedarepo.com/api/v1/mcp",
      "headers": { "Authorization": "Bearer ${YONEDA_TOKEN}" }
    }
  }
}
```

Or let the CLI do it: `yoneda setup claude`, `codex`, `gemini` or `opencode`.

## Tools

The account endpoint adds `repo_list`, `repo_create {name, files?, policy?}` and `repo_delete {repo, confirm}` (both need `repo:admin`). Every platform tool (`git_*`, `symbol_*`) dispatches through the same operation table as the REST API, with the caller's own credential: scopes and repository allowlists apply exactly as they do for REST.

A typical cloud-agent loop needs no clone: `repo_create`, `git_commit` (a server-side commit), `git_land`, then `git_grep` or `git_cat_file` to read.

The full tool list is in the [API reference](/docs/reference/api#mcp-tools).
