---
title: Repositories
summary: Create, share, fork and organize repositories, with LFS and releases.
---

## Create

- **Web:** choose **New repository**, pick an owner (you or one of your organizations), a name and visibility.
- **CLI:** `yoneda repo create <name> [--owner <org>] [--public]`.
- **Import:** `yoneda repo import <dir> [--name <name>]` uploads the files at a local checkout's HEAD (or a plain directory).
- **MCP:** `repo_create {name, files?, policy?}` with a `repo:admin` token.

Each repository has an id like `r3f1c0d2e4a5b6c7d8e9f` used in Git URLs and the API, and a name shown in the app.

## Visibility

```sh
yoneda repo visibility <id> public    # anyone reads, no sign-in; only members write
yoneda repo visibility <id> private
```

A public repository is cloned by stock Git with no credentials at all and listed on [Explore](/source/explore). Making it private takes effect within a second.

## Members and teams

Add accounts or organization teams under **Settings → Members** with a role: `read`, `write` (push and move working branches), `land` or `admin`. A team is granted as `team:<org>/<team>`. Removing a member refuses their next request at once.

## Landing rules

**Settings → Landing rules** sets the policy for protected branches (`main`, `release`, `release/*`):

```json
{
  "approvals": 1,
  "required_checks": ["test"],
  "runners": {
    "test": { "command": ["npm", "test"], "timeout_seconds": 600 }
  },
  "auto_approve": ["docs", "formatting", "comment_only"]
}
```

A command runner may name `paths` (up to 32): only files at or under them are shipped to its check container, and its evidence names that scope. Without `paths` the whole tree ships. The checked commit's tree is shipped without history either way.

Unprotected branches move with `write`, like any Git branch. See [Changes](/docs/guides/changes) for reviews and checks.

## Forks

```sh
yoneda repo fork <id> [--name <name>] [--owner <org>]
```

A fork needs read access to its parent. Push a branch to the fork, then propose it to the parent with `yoneda change create <branch> --to-parent`. A parent cannot be deleted while it has forks.

## Organizations

```sh
yoneda org create acme
yoneda org member add acme ada --role owner
yoneda org team create acme backend
yoneda org team add acme backend ada
```

Organizations own repositories and share one namespace with accounts. An organization can be deleted only once it owns no repositories; its name is then retired.

## Git LFS

Git LFS works against the repository's HTTPS remote (`/git/<repo-id>.git/info/lfs`). Uploads and downloads go straight to object storage through signed URLs, and each object's size and SHA-256 is verified before it is recorded. A public repository's LFS objects download anonymously. File locking is not supported: lock requests are refused with a message `git lfs` shows.

## Releases

```sh
yoneda release create v1.2.0 --title "1.2.0" -m "Notes" --asset dist/app.tgz
yoneda release list
yoneda release show v1.2.0     # notes and assets, each with its SHA-256
```

A release belongs to a tag. Tags are created once and never move or disappear.

## Delete

`yoneda repo delete <id> --confirm <name>`, or **Settings → Delete**. The name must be typed to confirm.
