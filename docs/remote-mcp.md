# Remote MCP, tokens and the CLI

How agents and other clients reach the source platform (`api.dev.yonedarepo.com`, prod `api.yonedarepo.com`): personal access tokens, device login, the `yoneda` CLI with plain `git`, the account MCP and the agent plugins. Agents are ordinary clients: they use the same tokens, scopes and review rules as people.

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
| all 49 platform tools (`git_*`, `symbol_*`, from `platform_tools.json`) | each takes a required `repo` (id or exact name) |

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
