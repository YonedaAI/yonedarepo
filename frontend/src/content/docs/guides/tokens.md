---
title: Tokens and access
summary: Personal access tokens, repository tokens, SSH keys and device login, and what each one can reach.
---

## Which credential

| Credential | Prefix | Acts for | Create it |
|---|---|---|---|
| Personal access token | `ypat_` | Your account, within its scopes | **Settings → Personal access tokens**, or `yoneda login` |
| Agent token | `ypat_` | One named agent of your account | `yoneda login --agent <name>` |
| Repository token | `yrp_` | One repository, optionally some paths | Repository **Settings → Repository tokens**, or `yoneda token create` |
| SSH key | | Your account, for Git over SSH | `yoneda ssh setup`, **Settings → SSH keys**, or `yoneda ssh-key add` |
| Browser session | | Your account, in the web app | Signing in |

The server keeps only a hash of each token and checks it on every request. A token is shown once, when it is created. Revoking a token or removing an SSH key takes effect on the next request.

## Personal access tokens

- **Scopes:** `repo:read`, `repo:write`, `repo:land`, `repo:review`, `repo:admin`, `account:ssh-keys`.
- **`account:ssh-keys`** lists, adds and removes your SSH keys and reaches nothing else: alone, it opens no repository, token, organization or API route. `yoneda login` ticks it by default; the **Create token** form does not. An SSH key clones and pushes as your account, so adding one also needs `repo:read`, `repo:write` and `repo:land` (or `repo:admin`) on all repositories. `repo:admin` manages keys too.
- **Expiry:** 1 to 90 days. The web app offers 1, 7, 30 or 90 days (default 30).
- **Repositories:** all of yours, an allowlist of up to 100 repository ids, or one organization's.
- Up to 50 live tokens per account.
- **Revoking a token removes the SSH keys it added**, such as the one `yoneda ssh setup` adds, and the confirmation says how many. Keys you add while signed in to the website stay, and so do keys added before tokens were recorded with their keys. A token that only expires keeps its keys until you revoke it or remove them.
- On a repository where you are a member, a token holds only what both its scopes and your role allow.

`yoneda login` creates one through device login and stores it for the CLI; `yoneda auth token` prints it for a script (`export YONEDA_TOKEN=$(yoneda auth token)`). Every token `yoneda login` created is listed under **Settings → Signed-in CLIs**. There is no CLI command to create a token otherwise.

## Agents

An agent is a named credential under your account. `yoneda login --agent review-bot` shows a code; you open the link, see the agent's name and machine, and approve it.

- **Scopes:** `repo:read` and `repo:write` are ticked; `repo:land` and `repo:review` are yours to add. An agent can't hold `repo:admin` or `account:ssh-keys`.
- **Repositories:** none are chosen until you choose. Pick some, or all repositories, including ones created later.
- **Expiry:** 1 to 90 days, 30 unless you change it.
- **Limits:** 10 live agents per account, and one per name. Sign one out to make room.
- **What it can't do:** create tokens, add SSH keys or create repositories, on any route.
- **Who it is:** commits, comments and reviews read `review-bot (agent of ada)`, not `ada`.
- **Reviews:** you may approve what your agent wrote. It can't approve your work, or another of your agents' work, and it never adds a second approval to yours.
- **Revoke:** **Settings → Signed-in CLIs → Sign out**. It stops on its next request.

## Repository tokens

```sh
yoneda token create ci --scopes read,write
yoneda token create docs-bot --scopes read,write --paths docs/,README.md
yoneda token list
yoneda token revoke ci
```

- **Scopes:** `read`, `write`, `check`, `review`, `land` (the CLI's default is `read,write`). Beside `check`, `check:<name>` lets a token post the required check `<name>` when the landing rules name no posters for it.
- **Paths:** 1 to 100 files or directory prefixes. Every read, search, blame and write outside them is refused with `Path is outside your grant`. Without paths the token covers the whole repository.
- Repository tokens do not expire; revoke them when done. Only the owner or an admin creates them.

## What each transport accepts

| Transport | Accepts |
|---|---|
| Git over HTTPS, Git LFS | Personal or repository tokens without paths, as the password |
| Git over SSH | SSH keys |
| `yoneda::` helper | Personal access tokens (`repo:read` to clone) |
| REST API and MCP | Personal and repository tokens (paths enforced), or the browser session |

## Device login

`yoneda login` follows the device flow of RFC 8628: the CLI shows a single-use code like `BCDF-GHJK`, which expires after 10 minutes, and you approve it in a signed-in browser at `/device`, choosing the scopes, expiry and repositories. The API is `POST /api/v1/device/code` and `POST /api/v1/device/token`.

## Troubleshooting

| Message | What to do |
|---|---|
| `Path is outside your grant` | The token's paths do not cover the file; use a broader token |
| `create the branch first` | A token with paths lands only what its paths cover, every commit down to the branch, and empty commits are refused. A new branch would bring its whole history: create the branch at a commit already on one, then land on it |
| Git refuses a path-restricted token | Git reads the whole repository; use a token without paths, or the API |
| `401` on a request that worked before | The token expired or was revoked; create a new one |
