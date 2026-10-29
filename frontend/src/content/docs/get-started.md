---
title: Get started
summary: Create an account, make a repository, and push to it with stock Git in about five minutes.
---

## 1. Create an account

Open [yonedarepo.com/signup](/signup), choose a user name and a password of at least 12 characters, and **save the recovery code** it shows you. The code is shown once and is the only way to reset your password.

## 2. Create a repository

Choose **New repository** in the sidebar. Each repository has Code, History, Changes, Agents, Releases, Search and Settings tabs. Repositories are private unless you make them public.

## 3. Install the CLI

The `yoneda` CLI also installs `git-remote-yoneda`, the helper behind `yoneda::` remotes:

```sh
# from a checkout of the YonedaRepo source
cargo install --path backend/crates/yoneda-cli
```

Prebuilt downloads are not published yet. Stock Git works without the CLI; see [Git remotes](/docs/guides/git-remotes).

Sign in from the terminal with device login. The CLI prints a code and opens the approval page in your browser:

```sh
yoneda login
```

The token is stored in `~/.config/yoneda/credentials` (mode 0600). `YONEDA_TOKEN` overrides it.

## 4. Clone, commit, push

```sh
git clone yoneda::https://api.yonedarepo.com/<repo-id> demo
cd demo
echo "# demo" > README.md
git add README.md && git commit -m "Add README"
git push origin main
```

`git push origin main` lands your commit. If someone else landed a different part of the code meanwhile, the server merges and prints `remote: main: landed with server merge, run git pull`. If you both changed the same lines, the push is refused with the path. Pull, resolve and push again.

You can also clone over plain HTTPS or SSH; see [Git remotes](/docs/guides/git-remotes).

## 5. Connect an agent

```sh
yoneda setup claude    # or codex, gemini, opencode
```

This installs the agent's YonedaRepo skill or plugin and its MCP configuration. Agents use the same tokens, scopes and review rules as people. See [MCP](/docs/guides/mcp).

## Next

- [Repositories](/docs/guides/repositories): visibility, members, forks, organizations, LFS and releases.
- [Changes](/docs/guides/changes): change requests, reviews and checks.
- [CLI commands](/docs/reference/cli): every command in one place.
