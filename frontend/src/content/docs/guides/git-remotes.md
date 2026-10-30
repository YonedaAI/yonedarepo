---
title: Git over HTTPS and SSH
summary: Clone, fetch and push with the Git you already have. Partial and shallow clones, SSH keys, and the limits of each push.
---

## HTTPS

```sh
git clone https://api.yonedarepo.com/git/<repo-id>.git
```

- **Credentials.** Any user name, and a token as the password: a personal access token (`ypat_`) or a repository token (`yrp_`). Git asks after the server's `401`; a credential helper remembers the answer. A bearer token in an `Authorization` header works too.
- **Access.** Fetching needs read; pushing needs write, and pushing to a protected branch (`main`, `release`, `release/*`) also needs land.
- **Public repositories** clone and fetch with no credentials at all.
- **Path-restricted tokens** cannot use Git: Git reads and writes the whole repository. Use the API or a token without paths.

## Partial and shallow clones

Fetches speak Git's protocol v2, which Git uses by default since 2.26.

```sh
git clone --filter=blob:none https://api.yonedarepo.com/git/<repo-id>.git   # files on demand
git clone --depth 1 https://api.yonedarepo.com/git/<repo-id>.git            # latest commit only
git fetch --deepen 50
git fetch --unshallow
```

- `--filter=blob:none` is the one partial-clone filter served; others are refused with `use --filter=blob:none`.
- `--depth`, `--deepen` and `--unshallow` work; `--shallow-since` and `--shallow-exclude` are refused with `use --depth or --deepen`.
- Protocol v0 (`git -c protocol.version=0`) serves full clones only.

## SSH

Git over SSH reaches the platform through Cloudflare Tunnel. Two commands set up a machine; neither needs admin rights.

### 1. Install the CLI

It brings `cloudflared` along, unless you already have one that works. On macOS or Linux:

```sh
curl -fsSL https://yonedarepo.com/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://yonedarepo.com/install.ps1 | iex
```

### 2. Run the setup

Sign in with `yoneda login` (the approval page ticks **SSH keys** for you; keep it, and leave the repositories at all), then:

```sh
yoneda ssh setup
```

It uses `~/.ssh/id_ed25519` or generates one, adds the public key to your account, writes a marked `# yoneda begin` block to `~/.ssh/config` without touching your other entries, and copies the public key to the clipboard if it can. It then tries `ssh -T`, which accepts the host key on first use as you would at the prompt, and prints a `git clone` line. Run it again whenever you like: it changes only what is out of date.

### 3. Clone

```sh
git clone ssh://git@ssh.yonedarepo.com/<repo-id>.git
```

`ssh -T git@ssh.yonedarepo.com` answers `Hi <account>! You've successfully authenticated, but YonedaRepo does not provide shell access.`

### Manual setup

Add the public key under **Settings → SSH keys** or with `yoneda ssh-key add ~/.ssh/id_ed25519.pub`, install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), then add to `~/.ssh/config`:

```text
Host ssh.yonedarepo.com
  ProxyCommand cloudflared access ssh --hostname %h
```

### Keys

- Keys: Ed25519, ECDSA (P-256, P-384, P-521) and RSA of 2048 to 16384 bits. Security-key (`sk-`) keys are not accepted.
- An account holds up to 50 keys. An SSH key acts as its account: it fetches what the account reads and pushes where it writes.
- Removing a key stops it on the next request.

## Limits

These apply to HTTPS and SSH alike. Pushes through the [`yoneda::` helper](/docs/guides/yoneda-remotes) are uploaded commit by commit and are not bound by the pack limit.

| Limit | Value |
|---|---|
| Pack data per push | 64 MiB |
| Objects per push | 40,000 |
| Size of one object | 100 MiB (use [Git LFS](/docs/guides/lfs) for larger files) |
| Object bytes per push | 2 GiB |
| Push options per push | 64 |

A file over 50 MB is accepted with a warning suggesting Git LFS.

## What a push accepts

- **Branches and tags only** (`refs/heads/*`, `refs/tags/*`). Other refs are refused.
- **Annotated and lightweight tags.** Tags never move and are never deleted once created.
- **`--atomic`** moves all the pushed working branches and tags, or none. A protected branch cannot be part of an atomic push: it moves only by landing.
- **Push options.** `-o yoneda.reads=<path>,…` declares the files a session read (see [Declared reads](/docs/guides/sessions#declared-reads)); other `yoneda.*` options are refused, and options without that prefix are ignored.
- **Not accepted:** shallow pushes (from a shallow clone) and signed pushes (`--signed`).

How a push to `main` lands next to other writers is on [Concurrent pushes](/docs/guides/pushing).

## Troubleshooting

| Message | Meaning |
|---|---|
| `Push exceeds 64 MiB of pack data` | Push fewer commits at a time, or push through the `yoneda::` helper |
| `Push has an object of N MiB; the limit is 100 MiB per file` | Track the file with Git LFS |
| `secret detected in <path>:<line>` | A file holds a credential; see [Security](/docs/security#what-a-push-is-checked-for) |
| `Not a Git repository URL: use /git/<repository id>.git` | The URL needs the repository's id, not its name |
| `ssh: Could not resolve hostname` or a hang on connect | The `ProxyCommand` entry is missing, or `cloudflared` is not installed: run `yoneda ssh setup` |
