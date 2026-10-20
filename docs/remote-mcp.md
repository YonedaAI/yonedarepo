# Local agents and repository keys

Sign in, open a repository and choose **Connect local agent**. Create a read or contribution key with a 1–31 day expiry. Save the key privately when it appears: the server retains only its hash. Revoke it in the same panel; subsequent MCP requests fail immediately. Account recovery also revokes all repository keys. Keys cannot access other repositories or the owner API.

Set `YONEDA_MCP_TOKEN` in the environment of the client process, using your password manager or a private shell prompt. Never put the value in a URL, command argument, committed configuration or prompt. Replace the example endpoint below with the one shown by the website.

## Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.yoneda]
url = "https://YOUR-WORKER.workers.dev/mcp/YOUR-REPO"
bearer_token_env_var = "YONEDA_MCP_TOKEN"
```

Alternatively, `codex mcp add yoneda --url https://YOUR-WORKER.workers.dev/mcp/YOUR-REPO --bearer-token-env-var YONEDA_MCP_TOKEN` writes the same configuration. Restart Codex with the environment variable available. This uses the official [HTTP bearer token setting](https://developers.openai.com/codex/config-reference/); it was also checked against the installed CLI's `mcp add --help`.

## Claude Code

Create `.mcp.json` in your working folder:

```json
{
  "mcpServers": {
    "yoneda": {
      "type": "http",
      "url": "https://YOUR-WORKER.workers.dev/mcp/YOUR-REPO",
      "headers": { "Authorization": "Bearer ${YONEDA_MCP_TOKEN}" }
    }
  }
}
```

Start Claude Code from the environment containing the variable and approve the server in `/mcp`. Claude documents [environment expansion for HTTP headers](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json). The configuration contains a variable reference, not a secret.

## Explore and contribute

Ask a fresh agent to call `repo_context`, search prior context and inspect `decision`, `why`, `graph` and `artifact_get`. It can distinguish agent assertions, independently captured source, evaluator observations and the human decision. `context_search` returns a cursor for bounded pagination.

A contribution key additionally permits:

1. `attempt_begin` with a stable request UUID, intent, criteria and prior context IDs. This freezes the current published base and verification policy and returns the attempt ID, intent ID, base revision and one-hour deadline. Retrying the same request resumes the attempt.
2. `attempt_read` lists a directory or reads a file of the attempt's source (the frozen base until the first commit). `attempt_commit` commits file changes (`content_b64`, `executable`, or `delete`) onto the attempt's own branch of the project's platform repository; each call builds on the previous one. Use `context_publish` with the attempt ID and intent ID to preserve typed findings and alternatives. The platform derives the author; a client cannot claim owner or verifier authority.
3. `attempt_submit` with the attempt ID. The platform closes contribution writes, binds the branch head it observes, and rebuilds that tree as one fresh commit on the frozen base before independent clean evaluation. Client-supplied revision claims are ignored. Retrying submission cannot change the bound revision.
4. `attempt_status` reports the attempt. Open the website to inspect its candidate and checks. Only a human with the owner session can select it and land it on the platform.

The key never reaches the platform: the agent layer commits with the project's own repository token, which cannot land.

## Limits and evidence

Hosted coding attempts additionally receive `delegate_agent` and `delegation_status` through their attempt-scoped MCP server when the owner enables subagents in the run. Identity comes from the active container lease. Children inherit approved provider/model/source/context and produce independently checked alternatives under shared limits. Repository keys for local agents deliberately do not grant paid hosted-agent creation; their contribution workflow above remains separate. See [delegation operation and limits](runbook.md#agent-concurrency-and-delegation).

The remote endpoint implements stateless Streamable HTTP JSON-RPC: POST JSON responses, no persistent sessions or server-initiated SSE stream. Read keys cannot begin attempts or publish context. No MCP tool selects candidates or moves `main`. Platform credentials are never returned to a client. In-flight requests may complete after revocation; later requests reauthenticate.

Each `attempt_commit` carries at most 500 regular files of 1 MiB each within a 4 MiB request, including executable bits and base64 binary transfer. Symlinks and submodules must be converted. Expired attempts fail without scheduling paid hosted inference. Local workerd tests cover durable grants, revocation after eviction, cross-repository denial, canonical-write denial, attribution, platform branch commits, frozen revision submission and fresh capture on the base. Actual third-party client connections are recorded separately in the release evidence.
