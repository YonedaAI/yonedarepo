---
title: Tokens and access
summary: Personal access tokens, repository tokens, SSH keys and device login, and what each one can reach.
---

## Which credential

| Credential | Prefix | Acts for | Create it |
|---|---|---|---|
| Personal access token | `ypat_` | Your account, within its scopes | **Settings → Personal access tokens**, or `yoneda login` |
| Repository token | `yrp_` | One repository, optionally some paths | Repository **Settings → Repository tokens**, or `yoneda token create` |
| SSH key | | Your account, for Git over SSH | **Settings → SSH keys**, or `yoneda ssh-key add` |
| Browser session | | Your account, in the web app | Signing in |

The server keeps only a hash of each token and checks it on every request. A token is shown once, when it is created. Revoking a token or removing an SSH key takes effect on the next request.

## Personal access tokens

- **Scopes:** `repo:read`, `repo:write`, `repo:land`, `repo:review`, `repo:admin`.
- **Expiry:** 1 to 90 days. The web app offers 1, 7, 30 or 90 days (default 30).
- **Repositories:** all of yours, an allowlist of up to 100 repository ids, or one organization's.
- Up to 50 live tokens per account.
- On a repository where you are a member, a token holds only what both its scopes and your role allow.

`yoneda login` creates one through device login and stores it for the CLI. Every token it created is listed under **Settings → Signed-in CLIs**. There is no CLI command to create a token otherwise.

## Repository tokens

```sh
yoneda token create ci --scopes read,write
yoneda token create docs-bot --scopes read,write --paths docs/,README.md
yoneda token list
yoneda token revoke ci
```

- **Scopes:** `read`, `write`, `check`, `review`, `land` (the CLI's default is `read,write`).
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
| Git refuses a path-restricted token | Git reads the whole repository; use a token without paths, or the API |
| `401` on a request that worked before | The token expired or was revoked; create a new one |
