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

The CLI is a Rust program, built with Cargo (Rust's toolchain, from [rustup.rs](https://rustup.rs)). From a copy of the YonedaRepo source:

```sh
cargo install --path backend/crates/yoneda-cli
```

This installs both `yoneda` and `git-remote-yoneda` into `~/.cargo/bin`, which must be on your `PATH` for Git to find the helper.

> [!NOTE] Prebuilt downloads and a package-manager install are not published yet. Until they are, use stock Git, the web app and MCP, which need nothing installed.

## Sign in

```sh
yoneda login                  # device login: approve the code in your browser
yoneda login --no-browser     # print the link and code without opening a browser
yoneda login --with-token     # read a token from stdin instead
```

`yoneda login` prints a code like `BCDF-GHJK` and opens the approval page (`/device`). Approve it there, choosing the token's scopes (default `repo:read`, `repo:write`, `repo:land`), expiry (default 30 days) and repositories. The code expires after 10 minutes and works once. Each approved login appears under **Settings → Signed-in CLIs**, where signing it out revokes its token.

`yoneda logout` removes the stored token.

## Configuration

| Setting | Where it comes from |
|---|---|
| Token | `YONEDA_TOKEN` when set, else the token `yoneda login` stored |
| Platform | `--origin <url>`, else `YONEDA_ORIGIN`, else the origin you logged in to, else `https://api.yonedarepo.com` |
| Stored token | `~/.config/yoneda/credentials` (or `$XDG_CONFIG_HOME/yoneda/credentials`), mode 0600, sent only to the origin it was stored for |

The CLI never prints the stored token. To give a token to an agent or a script, create a personal access token in **Settings** and export it as `YONEDA_TOKEN`.

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
| `git: 'remote-yoneda' is not a git command` | `~/.cargo/bin` is not on your `PATH`; add it and open a new shell |
| `yoneda login` cannot open a browser | Use `yoneda login --no-browser` and open the printed link yourself |
| A command answers 401 | The token expired or was revoked: run `yoneda login` again, or check `YONEDA_TOKEN` |
| A command asks for `--repo` | You are outside a `yoneda::` clone; pass `--repo <id>` |
