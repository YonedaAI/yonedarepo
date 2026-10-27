# Remote MCP, tokens and the CLI

This page has two parts:

- **The source platform** (`api.dev.yonedarepo.com`, prod `api.yonedarepo.com`): personal access tokens, device login, the `yoneda` CLI with plain `git`, the account MCP and the agent plugins.
- **The agent layer** ([below](#agent-layer-local-agents-and-repository-keys)): repository keys and the attempt workflow of the agents website.

## Platform quick start

1. Install the CLI (it also installs the `git-remote-yoneda` helper):

   ```sh
   cargo install --path backend/crates/yoneda-cli
   ```

2. Sign in: `yoneda login --origin https://api.dev.yonedarepo.com`. The CLI prints a code and opens `https://dev.yonedarepo.com/device`. Approve the code there with the scopes, expiry and repositories you choose. The CLI stores the resulting personal access token in `~/.config/yoneda/credentials` (mode 0600). `YONEDA_TOKEN` overrides it.
3. Create and clone a repository, then use plain git:

   ```sh
   yoneda repo create demo                                  # CLI repositories land solo (no approvals)
   git clone yoneda::https://api.dev.yonedarepo.com/<repo-id> demo
   cd demo && git commit -am "change" && git push origin main
   ```

   `git push origin main` lands. Disjoint concurrent changes from other clones merge on the server, and the push succeeds; then `git pull`. A same-line conflict is reported with its paths (`yoneda conflicts` lists them again): pull, resolve, commit, push again.

   The clone holds the platform's commits byte for byte, so commit ids are the same as in `yoneda log`, `GET /refs` and the Artifacts clone. A push replays each local commit with its own author, committer and message, so the platform's commit has the local id. Main may get a platform commit on top of a pushed one (a merge, or the record of a landed changeset); `git pull` fast-forwards to it. Only commits the platform cannot rebuild exactly (split into parts, empty, or carrying a signature or `encoding` header) get a platform id of their own, recorded in `.git/yoneda/<repo-id>.map`.
4. Read on the server instead of opening files: `yoneda grep <query>`, `yoneda blame <path>`, `yoneda symbols <path>`, `yoneda log [path]` and `yoneda diff <base> <head>`, each with `--at <version>` for an earlier landed version. `yoneda status --brief` prints one line from local data only (no network call): the repository, the branch and how many of its commits are not on the platform yet.

Each repository's **Connect** tab in `/source` shows these commands with that repository's id and the configured API origin.

## Personal access tokens and device login

A personal access token (`ypat_…`) is account-wide:

| Property | Values |
|---|---|
| Scopes | `repo:read`, `repo:write`, `repo:land`, `repo:review`, `repo:admin` (create, delete, tokens, policy) |
| Repositories | all (default), or an allowlist of repository ids |
| Expiry | 1–90 days (default 30), revocable at any time |

The server keeps only a hash and verifies the token on every request. Create and revoke tokens on the **Tokens** page in `/source` (shown once, with copy), or through the API with the session cookie: `GET/POST/DELETE /api/v1/tokens`. The same page lists and creates repository tokens (`yrp_…`, one repository, optional paths).

Device login follows RFC 8628: `POST /api/v1/device/code`, approval at `/device` (signed in, session only), then the CLI polls `POST /api/v1/device/token`. Codes are `XXXX-XXXX`, single use, and expire after 10 minutes.

## Account MCP

`POST https://api.dev.yonedarepo.com/api/v1/mcp` with `Authorization: Bearer <ypat_…>` (a session cookie or a repository token also works, within its own scope). It is stateless Streamable HTTP with JSON responses (protocol `2025-06-18` or `2025-03-26`), like the per-repository `/api/v1/repos/<id>/mcp`.

| Tools | Notes |
|---|---|
| `repo_list` | repositories the credential can use |
| `repo_create {name, files?, policy?}` | needs `repo:admin`; `policy {approvals:0, required_checks:[]}` lands solo |
| `repo_delete {repo, confirm}` | needs `repo:admin`; `confirm` must equal the repository name |
| all 31 platform tools (`git_*`, `symbol_*`) | each takes a required `repo` (id or exact name) |

The platform tools dispatch through the same operation table as REST and the per-repository MCP, with the caller's own credential: scopes and the allowlist apply exactly as they do for REST. A typical cloud-agent loop is `repo_create`, `git_commit` (server-side, nothing to push), `git_land`, then `git_grep` or `git_cat_file`.

### Plugins

| Client | Install |
|---|---|
| Claude Code | `/plugin marketplace add YonedaAI/yonedarepo`, then `/plugin install yoneda@yoneda`. `yoneda setup claude` prints these two commands and writes the project's `.mcp.json`. |
| Codex | `yoneda setup codex`: the skill (`plugins/codex/skills/yoneda/SKILL.md`) into `~/.agents/skills/yoneda/`, and `[mcp_servers.yoneda]` in `~/.codex/config.toml` (`$CODEX_HOME` moves the config) |
| Gemini CLI | `yoneda setup gemini`: `plugins/gemini/` into `~/.gemini/extensions/yoneda/` with its MCP URL set to `--origin`, and the server in `~/.gemini/settings.json` |

Each `setup` takes `--origin <url>` (default: `$YONEDA_ORIGIN`, else the signed-in origin) and writes no token: the agents read `YONEDA_TOKEN` when they connect. The skill files are compiled into the CLI, so they match the installed version.

The Claude Code plugin (`plugins/yoneda/`) adds:

- the `yoneda` skill: the git workflow for `yoneda::` remotes
- the account MCP, with `Authorization: Bearer ${YONEDA_TOKEN}` read from the environment
- a SessionStart hook that runs `yoneda status --brief`, only in checkouts with a `yoneda::` remote

Set `YONEDA_TOKEN` before starting Claude Code. For production, also set `YONEDA_MCP_URL=https://api.yonedarepo.com/api/v1/mcp`.

Without the plugin, use this `.mcp.json` (or the Codex block, appended to `~/.codex/config.toml`):

```json
{
  "mcpServers": {
    "yoneda": {
      "type": "http",
      "url": "https://api.dev.yonedarepo.com/api/v1/mcp",
      "headers": { "Authorization": "Bearer ${YONEDA_TOKEN}" }
    }
  }
}
```

```toml
[mcp_servers.yoneda]
url = "https://api.dev.yonedarepo.com/api/v1/mcp"
bearer_token_env_var = "YONEDA_TOKEN"
```

Codex reads user skills from `~/.agents/skills/`; `yoneda setup codex` installs the skill there.

## Agent layer: local agents and repository keys

Sign in, open a repository and choose **Connect local agent**. Create a read or contribution key with a 1–31 day expiry. Save the key privately when it appears: the server retains only its hash. Revoke it in the same panel; subsequent MCP requests fail immediately. Account recovery also revokes all repository keys. Keys cannot access other repositories or the owner API.

Set `YONEDA_MCP_TOKEN` in the environment of the client process, using your password manager or a private shell prompt. Never put the value in a URL, command argument, committed configuration or prompt. Replace the example endpoint below with the one shown by the website.

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.yoneda]
url = "https://YOUR-WORKER.workers.dev/mcp/YOUR-REPO"
bearer_token_env_var = "YONEDA_MCP_TOKEN"
```

Alternatively, `codex mcp add yoneda --url https://YOUR-WORKER.workers.dev/mcp/YOUR-REPO --bearer-token-env-var YONEDA_MCP_TOKEN` writes the same configuration. Restart Codex with the environment variable available. This uses the official [HTTP bearer token setting](https://developers.openai.com/codex/config-reference/); it was also checked against the installed CLI's `mcp add --help`.

### Claude Code

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

### Explore and contribute

Ask a fresh agent to call `repo_context`, search prior context and inspect `decision`, `why`, `graph` and `artifact_get`. It can distinguish agent assertions, independently captured source, evaluator observations and the human decision. `context_search` returns a cursor for bounded pagination.

A contribution key additionally permits:

1. `attempt_begin` with a stable request UUID, intent, criteria and prior context IDs. This freezes the current published base and verification policy and returns the attempt ID, intent ID, base revision and one-hour deadline. Retrying the same request resumes the attempt.
2. `attempt_read` lists a directory or reads a file of the attempt's source (the frozen base until the first commit). `attempt_commit` commits file changes (`content_b64`, `executable`, or `delete`) onto the attempt's own branch of the project's platform repository; each call builds on the previous one. Use `context_publish` with the attempt ID and intent ID to preserve typed findings and alternatives. The platform derives the author; a client cannot claim owner or verifier authority.
3. `attempt_submit` with the attempt ID. The platform closes contribution writes, binds the branch head it observes, and rebuilds that tree as one fresh commit on the frozen base before independent clean evaluation. Client-supplied revision claims are ignored. Retrying submission cannot change the bound revision.
4. `attempt_status` reports the attempt. Open the website to inspect its candidate and checks. Only a human with the owner session can select it and land it on the platform.

The key never reaches the platform: the agent layer commits with the project's own repository token, which cannot land on protected refs.

### Limits and evidence

Hosted coding attempts additionally receive `delegate_agent` and `delegation_status` through their attempt-scoped MCP server when the owner enables subagents in the run. Identity comes from the active container lease. Children inherit approved provider/model/source/context and produce independently checked alternatives under shared limits. Repository keys for local agents deliberately do not grant paid hosted-agent creation; their contribution workflow above remains separate. See [delegation operation and limits](runbook.md#agent-concurrency-and-delegation).

The remote endpoint implements stateless Streamable HTTP JSON-RPC: POST JSON responses, no persistent sessions or server-initiated SSE stream. Read keys cannot begin attempts or publish context. No MCP tool selects candidates or moves `main`. Platform credentials are never returned to a client. In-flight requests may complete after revocation; later requests reauthenticate.

Each `attempt_commit` carries at most 500 regular files of 1 MiB each within a 4 MiB request, including executable bits and base64 binary transfer. Symlinks and submodules must be converted. Expired attempts fail without scheduling paid hosted inference. Local workerd tests cover durable grants, revocation after eviction, cross-repository denial, canonical-write denial, attribution, platform branch commits, frozen revision submission and fresh capture on the base. Actual third-party client connections are recorded separately in the release evidence.

### Offline CLI

`yoneda` (crate `backend/crates/yoneda-cli`) lets a local agent or person work offline and sync later. The work is one long optimistic transaction pinned to the clone's base version; landing applies the platform's usual path-level checks and same-file three-way merge.

```sh
cargo install --path backend/crates/yoneda-cli
yoneda login --origin https://YOUR-PLATFORM --with-token   # reads the token from stdin; ~/.config/yoneda/credentials, mode 0600
yoneda clone rXXXXXXXXXXXXXXXXXXXX work          # git clone for a person reading the whole repo, else an API snapshot
cd work && git commit -am "offline work"         # plain Git, no network
yoneda status                                    # base version, pending commits, platform and projection lag
yoneda sync --land                               # push oldest first, then land; exit 2 on CONFLICT
yoneda pull                                      # rebase pending commits onto the latest main
```

`YONEDA_TOKEN` overrides the stored token; a stored token is sent only to its own origin. A repository token needs `read`, `write` and `land` for `sync --land`. Each pushed commit moves the checkout's `offline/<id>` branch by compare-and-swap, so a sync rerun after a crash or lost acknowledgment adopts commits that already arrived instead of pushing them again. On CONFLICT the three sides are written to `.yoneda/conflicts/<path>.{base,ours,theirs}` (ours = local, theirs = main). Keys without land rights use `yoneda sync --attempt <attempt-id> [--mcp-url URL]` with `YONEDA_MCP_TOKEN`: the commits go through `attempt_commit` and `attempt_submit` above. Symlinks and submodules are refused; files over 32 MiB (1 MiB for attempts) cannot sync. The local workerd test is `cargo test -p yoneda-cli -- --include-ignored`.
