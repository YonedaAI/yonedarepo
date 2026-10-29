---
title: CLI
summary: Install the yoneda CLI, sign in, and use it beside plain Git.
---

## Install and sign in

```sh
# from a checkout of the YonedaRepo source; also installs git-remote-yoneda
cargo install --path backend/crates/yoneda-cli
yoneda login                 # device login in your browser
yoneda login --with-token    # or read a token from stdin
```

`yoneda login` prints a code and opens the device page; approve it there with the scopes, expiry and repositories you choose. The token is stored in `~/.config/yoneda/credentials` (mode 0600). `YONEDA_TOKEN` overrides it.

## Which repository

Inside a clone with a `yoneda::` remote, repository commands use that remote. Elsewhere pass `--repo <id>` (and `--origin <url>` for another platform).

## Everyday commands

```sh
yoneda repo create demo
yoneda change create my-branch --title "Short title"
yoneda change land 3
yoneda grep "fn backoff"
yoneda blame src/retry.rs
yoneda context
yoneda status --brief        # one line, no network: commits not on the platform yet
```

## Agents

```sh
yoneda setup claude|codex|gemini|opencode
```

installs the agent's skill or plugin and MCP configuration. Each `setup` takes `--origin <url>` and writes no token: agents read `YONEDA_TOKEN` when they connect.

The full list is in the [CLI reference](/docs/reference/cli).
