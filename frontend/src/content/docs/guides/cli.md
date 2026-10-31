---
title: Install the CLI
summary: The yoneda CLI and its Git helper, git-remote-yoneda. Install, sign in, and use it beside plain Git.
---

## What you get

| Program | What it does |
|---|---|
| `yoneda` | Accounts, repositories, changes, reviews, releases, search, sessions, memories and agent setup |
| `git-remote-yoneda` | The Git helper behind `yoneda::` remotes: lazy clones and pushes of any size; see [yoneda:: remotes](/docs/guides/yoneda-remotes) |

You do not need the CLI to use YonedaRepo: stock Git over [HTTPS or SSH](/docs/guides/git-remotes), the web app, the [REST API](/docs/reference/api) and [MCP](/docs/guides/mcp) all work without it.

## Install

On macOS or Linux:

```sh
curl -fsSL https://yonedarepo.com/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://yonedarepo.com/install.ps1 | iex
```

The script picks the build for your machine, downloads it from yonedarepo.com, checks it against the release's published SHA-256 sums, and only then installs `yoneda` and `git-remote-yoneda` into `~/.local/bin` (`%LOCALAPPDATA%\Programs\yoneda` on Windows). That directory must be on your `PATH` for Git to find the helper; the script says so when it is not, and on Windows adds it to your user `PATH`. Nothing runs as root or needs admin rights.

It also installs `cloudflared`, which [Git over SSH](/docs/guides/git-remotes#ssh) goes through: Cloudflare's own release at a pinned version, checked against a pinned SHA-256. A working `cloudflared` already on your `PATH` is left alone. If the download fails the install still succeeds with a warning, because HTTPS Git works without it.

| Builds | |
|---|---|
| macOS | Apple silicon (arm64) and Intel (x86-64) |
| Linux | x86-64 and arm64, statically linked (any distribution) |
| Windows | x86-64 and arm64 |

| Variable | Changes |
|---|---|
| `YONEDA_INSTALL_DIR` | Where to install (default `~/.local/bin`, or `%LOCALAPPDATA%\Programs\yoneda` on Windows) |
| `YONEDA_VERSION` | Which release (default the latest) |
| `YONEDA_TARGET` | `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `windows-x64` or `windows-arm64` instead of the detected one |

For example `curl -fsSL https://yonedarepo.com/install.sh | YONEDA_INSTALL_DIR=/usr/local/bin sh`. Run the same command again to update. The release's files and sums are listed in [latest.json](https://yonedarepo.com/downloads/cli/latest.json).

## Sign in

```sh
yoneda login                  # device login: approve the code in your browser
yoneda login --no-browser     # print the link and code without opening a browser
yoneda login --with-token     # read a token from stdin instead
```

`yoneda login` prints a code like `BCDF-GHJK` and opens the approval page (`/device`). Approve it there, choosing the token's scopes (default `repo:read`, `repo:write`, `repo:land` and `account:ssh-keys`, which `yoneda ssh setup` uses), expiry (default 30 days) and repositories. The code expires after 10 minutes and works once. Each approved login appears under **Settings → Signed-in CLIs**, where signing it out revokes its token and removes the SSH keys it added.

`yoneda logout` removes the stored token.

## Configuration

| Setting | Where it comes from |
|---|---|
| Token | `YONEDA_TOKEN` when set, else the token `yoneda login` stored |
| Platform | `--origin <url>`, else `YONEDA_ORIGIN`, else the origin you logged in to, else `https://api.yonedarepo.com` |
| Stored token | `~/.config/yoneda/credentials` (or `$XDG_CONFIG_HOME/yoneda/credentials`), mode 0600, sent only to the origin it was stored for |

## Hand the token to a script or an agent

```sh
export YONEDA_TOKEN=$(yoneda auth token)
```

`yoneda auth token` prints the token the CLI would send (`YONEDA_TOKEN` when set, else your login's) on stdout and nowhere else; nothing is sent to the platform. So that a token does not land in a terminal's scrollback or a screen share, it prints only into a pipe, a file or `$(…)`; to see it in the terminal, pass `--show`. It has no `--json` form.

For an agent that should not hold your whole login, create a narrower personal access token in **Settings** instead; see [Tokens and access](/docs/guides/tokens).

## Which repository

Inside a clone with a `yoneda::` remote, repository commands use that remote. Anywhere else, pass `--repo <id>` (and `--origin <url>` for another platform).

## Everyday commands

```sh
yoneda repo create demo --public
yoneda clone <repo-id> demo          # lazy clone through git-remote-yoneda
yoneda change create my-branch --title "Short title"
yoneda change land 3
yoneda search "fn backoff"
yoneda blame src/retry.rs
yoneda context
yoneda status --brief                # one line, no network: commits not on the platform yet
```

Every command is listed in [CLI commands](/docs/reference/cli).

## JSON output

Add `--json` to any command except `help`, `push` and `hook` to get one JSON document on stdout, with the schema `yoneda.cli.<command>.v1`. Errors come back as `yoneda.cli.error.v1` with a stable `code`.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `git: 'remote-yoneda' is not a git command` | `~/.local/bin` (or your `YONEDA_INSTALL_DIR`) is not on your `PATH`; add it and open a new shell |
| `checksum mismatch` while installing | The download was changed or cut off; nothing was installed. Run the command again |
| `no prebuilt yoneda for …` | Your system is not one of the four builds; use stock Git, the web app and MCP |
| `refusing to print a token to the terminal` | `yoneda auth token` prints into a pipe; add `--show` to see it |
| `yoneda login` cannot open a browser | Use `yoneda login --no-browser` and open the printed link yourself |
| A command answers 401 | The token expired or was revoked: run `yoneda login` again, or check `YONEDA_TOKEN` |
| A command asks for `--repo` | You are outside a `yoneda::` clone; pass `--repo <id>` |
