---
title: MCP
summary: Connect any MCP client to your account or to a single repository. Every tool runs the same operation as the REST API, with the caller's own scopes.
---

## Endpoints

| Endpoint | Scope |
|---|---|
| `https://api.yonedarepo.com/api/v1/mcp` | Your account: repositories and organizations, plus every repository tool with a `repo` argument |
| `https://api.yonedarepo.com/api/v1/repos/<id>/mcp` | One repository |

Both are stateless Streamable HTTP: POST only, JSON responses, protocol versions `2025-06-18` and `2025-03-26`. Authenticate with `Authorization: Bearer <token>`: a personal access token or a repository token, each within its own scope. There is no OAuth sign-in flow for MCP clients; use a token. A request from a browser page on another site (a foreign `Origin` header) is refused.

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

Or let the CLI write it: `yoneda setup claude`, `codex`, `gemini` or `opencode`; see [Connect an agent](/docs/agents/connect).

## Tools

The account endpoint adds:

| Tools | What they do |
|---|---|
| `repo_list`, `repo_create {name, files?, policy?}`, `repo_delete {repo, confirm}` | Your repositories (creating and deleting need `repo:admin`) |
| `org_list`, `org_create`, `org_show`, `org_repos`, `org_delete` | Organizations |
| `org_member_add`, `org_member_remove`, `org_team_create`, `org_team_delete`, `org_team_member_add`, `org_team_member_remove` | Members and teams |

Every repository tool (`git_*`, `symbol_*`) dispatches through the same operation table as the REST API, with the caller's own credential: scopes, roles, repository allowlists and token paths apply exactly as they do for REST. On the account endpoint each takes a `repo` argument (an id or an exact name).

A cloud agent can work without a clone: `repo_create`, `git_commit` (a server-side commit), `git_land`, then `git_grep` or `git_cat_file` to read.

The full tool list is in the [API reference](/docs/reference/api#mcp-tools).

## Troubleshooting

| Symptom | What to do |
|---|---|
| `401` | Send `Authorization: Bearer <token>`; check the token has not expired |
| A tool answers "not found" for a private repository | The token does not reach it: check its allowlist, organization limit or your membership |
| `403` from a browser-based client | Requests from other sites' pages are refused; call the endpoint from a server or a local client |
