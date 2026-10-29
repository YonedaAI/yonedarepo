---
title: Git remotes
summary: Clone and push with HTTPS, SSH or the yoneda:: helper.
---

## HTTPS

```sh
git clone https://api.yonedarepo.com/git/<repo-id>.git
```

Use a repository token (`yrp_`) or personal token (`ypat_`) as the password, with any user name. Git asks after the server's `401`; a credential helper remembers it. Fetching needs read, pushing needs write. Public repositories clone with no credentials.

Fetches speak protocol v2 (Git 2.26 and later), with partial clones (`--filter=blob:none`) and shallow clones (`--depth`, `--deepen`, `--unshallow`).

## The yoneda:: helper

```sh
git clone yoneda::https://api.yonedarepo.com/<repo-id> demo
```

The helper uses your `yoneda login` token (or `YONEDA_TOKEN`). Use it for pushes over the HTTPS limits and for history imported into the platform.

## SSH

```sh
yoneda ssh-key add ~/.ssh/id_ed25519.pub
git clone ssh://git@ssh.yonedarepo.com/<repo-id>.git
```

Ed25519, ECDSA (P-256/384/521) and RSA keys of 2048 bits or more are accepted. SSH currently connects through a tunnel: install `cloudflared` and add the `ProxyCommand` that `yoneda ssh-key add` prints to `~/.ssh/config`. `ssh -T git@ssh.yonedarepo.com` greets your account.

## How pushing to main behaves

- `git push origin main` always prints `* [new branch] main -> main`. A push based on an older `main` still lands, merged on the server, or is refused as a conflict.
- After a server merge Git prints `remote: main: landed with server merge, run git pull`; `git pull --ff-only` then fast-forwards.
- `git push --force origin main` lands like any other push. It never rewrites or deletes `main`.
- Working branches move by compare-and-swap on the value Git saw; `--atomic` moves all of them or none.

## Limits

| Limit | Value |
|---|---|
| Pack per push (HTTPS) | 64 MiB |
| Objects per push | 40,000 |
| Size per object | 16 MiB |
| Objects per fetch | 40,000 |

Larger pushes use the `yoneda::` helper. Plain HTTPS and SSH do not accept annotated tags (`git tag -a`) or push options yet; the helper does.
