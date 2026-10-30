---
title: Quickstart
summary: Create an account, make a repository and push to it with stock Git in about five minutes. No extra tools needed.
---

## 1. Create an account

Open [yonedarepo.com/signup](/signup) and enter your email address and a password of 12 to 128 characters, or continue with GitHub or Google. Save the **recovery code** it shows you: it is shown once and is the only way to reset your password. See [Accounts and sign-in](/docs/accounts).

## 2. Create a repository

Choose **New repository** in the app, pick an owner (you or one of your organizations), a name, and **Private** or **Public**. The new repository starts with a README.

Each repository has an id like `r3f1c0d2e4a5b6c7d8e9f` (`r` and 20 hex digits). Git URLs and the API use the id; the app shows it under **Settings → Connect**, with ready-to-copy clone commands.

## 3. Create a token

Open **Settings → Personal access tokens**, name a token, choose the scopes `repo:read`, `repo:write` and `repo:land` (pushing to `main` lands, which needs `repo:land`), and copy it. It is shown once.

## 4. Clone, commit, push

```sh
git clone https://api.yonedarepo.com/git/<repo-id>.git demo
cd demo
echo "# demo" > README.md
git add README.md && git commit -m "Add README"
git push origin main
```

Git asks for a user name and password: any user name works, and the password is your token. A credential helper remembers it.

If someone else landed work on `main` meanwhile, the push still lands, merged on the server:

```text
remote: main: landed with server merge, run git pull
```

Run `git pull` to bring your clone up to date. If you both changed the same lines, the push is refused with the paths instead; see [Concurrent pushes](/docs/guides/pushing).

## 5. Go further

- [Git over HTTPS and SSH](/docs/guides/git-remotes): SSH keys, partial and shallow clones, limits.
- [Install the CLI](/docs/guides/cli): lazy clones, change requests, search and agent setup from the terminal.
- [Connect an agent](/docs/agents/connect): Claude Code, Codex, opencode or Gemini CLI.
- [Changes](/docs/guides/changes): propose a branch, review it, run checks and land it.
