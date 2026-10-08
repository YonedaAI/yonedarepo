# Local agents and repository keys

Sign in, open a repository and choose **Connect local agent**. Create a read or contribution key with a 1–31 day expiry. Save the key privately when it appears: the server retains only its hash. Revoke it in the same panel; subsequent MCP and Git requests fail immediately. Account recovery also revokes all repository keys. Keys cannot access other repositories or the owner API.

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

Ask a fresh agent to call `repo_context`, search prior context and inspect `decision`, `why`, `graph` and `artifact_get`. It can distinguish agent assertions, independently captured source, evaluator observations and the human decision. `context_search` returns a cursor for bounded pagination. The canonical Git URL returned by `repo_context` is read only.

A contribution key additionally permits:

1. `attempt_begin` with a stable request UUID, intent, criteria and prior context IDs. This freezes the current published base and verification policy and returns an isolated Git URL, attempt ID, intent ID and one-hour deadline. Retrying the same request resumes the attempt.
2. Clone that URL, edit source and push its default branch. Use `context_publish` with the attempt ID and intent ID to preserve typed findings and alternatives. The platform derives the author; a client cannot claim owner or verifier authority.
3. `attempt_submit` with the attempt ID. The platform closes contribution writes, observes and binds the fork's exact HEAD, validates regular source files and schedules independent capture and clean evaluation. Client-supplied revision claims are ignored. Retrying submission cannot change the bound revision.
4. `attempt_status` reports the attempt. Open the website to inspect its candidate and checks. Only a human with the owner session can select it and authorize canonical publication.

Git needs the same repository key as a bearer header. Supply it through environment-backed Git configuration, scoped to a single command. For example, after setting `YONEDA_GIT_URL` to the returned URL:

```sh
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader \
GIT_CONFIG_VALUE_0="Authorization: Bearer $YONEDA_MCP_TOKEN" \
  git clone "$YONEDA_GIT_URL" contribution
```

Use the same environment prefix for `git -C contribution push origin HEAD:main` (or the repository's actual default branch). The key is absent from command arguments and the saved remote URL. Do not enable Git HTTP tracing while authenticated.

## Limits and evidence

Hosted coding attempts additionally receive `delegate_agent` and `delegation_status` through their attempt-scoped MCP server when the owner enables subagents in the run. Identity comes from the active container lease. Children inherit approved provider/model/source/context and produce independently checked alternatives under shared limits. Repository keys for local agents deliberately do not grant paid hosted-agent creation; their contribution workflow above remains separate. See [delegation operation and limits](runbook.md#agent-concurrency-and-delegation).

The remote endpoint implements stateless Streamable HTTP JSON-RPC: POST JSON responses, no persistent sessions or server-initiated SSE stream. Read keys cannot begin attempts or publish context. No MCP tool selects candidates or writes canonical Git. Artifacts credentials are minted briefly inside the trusted Git broker and revoked; they are never returned to a client. In-flight requests may complete after revocation; later requests reauthenticate.

Contributions currently support bounded regular files (500 files, 8 MiB decoded total), including executable bits and base64 binary transfer. Symlinks and submodules must be converted. Expired attempts fail without scheduling paid hosted inference. Local workerd tests cover durable grants, revocation after eviction, cross-repository denial, canonical-write denial, attribution, frozen revision submission and capture handoff. Actual third-party client connections and live Artifacts Git transfer are recorded separately in the release evidence.
