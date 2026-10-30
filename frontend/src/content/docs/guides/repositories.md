---
title: Repositories
summary: Create a repository, choose who can read and write it, set its landing rules, and delete it.
---

## Create

| Where | How |
|---|---|
| Web | **New repository**: an owner (you or one of your organizations), a name, **Private** or **Public** |
| CLI | `yoneda repo create <name> [--owner <org>] [--public]` |
| API | `POST /api/v1/repos` |
| MCP | `repo_create {name, files?, policy?}` on the account endpoint (needs `repo:admin`) |

Each repository has an id like `r3f1c0d2e4a5b6c7d8e9f` used in Git URLs and the API, and a name shown in the app. To bring in existing code, see [Import a repository](/docs/guides/import).

## Visibility

```sh
yoneda repo visibility <id> public    # anyone reads, no sign-in; only members write
yoneda repo visibility <id> private
```

Or **Settings → Visibility**. A public repository is cloned by stock Git with no credentials and listed on [Explore](/source/explore). A private repository answers "not found" to everyone who is not a member. Only the owner (for an organization's repository, an organization owner) changes visibility; the change applies within a second.

## Members

Add accounts or organization teams under **Settings → Members**, with a role:

| Role | Can |
|---|---|
| `read` | Read and clone |
| `write` | Also commit, push working branches and post checks |
| `land` | Also review and land on protected branches |
| `admin` | Also act as the owner, except deleting the repository and managing admins |

A team is added as `team:<org>/<team>`. Removing a member refuses their next request. A member's personal token holds only what both its scopes and the member's role allow.

## Landing rules

**Settings → Landing rules** (or `yoneda policy set '<json>'`) sets the policy for the protected branches `main`, `release` and `release/*`:

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

| Key | Meaning |
|---|---|
| `approvals` | Approvals of the head commit needed to land, from accounts other than its author |
| `required_checks` | Checks that must pass on the head |
| `runners` | Checks the platform runs itself: a command, or a model call; see [Changes](/docs/guides/changes#checks) |
| `auto_approve` | Kinds of change that count as approved: `docs`, `formatting`, `comment_only` |
| `secret_allow` | Accepted secret-scan false positives; see [Security](/docs/security#what-a-push-is-checked-for) |

A command runner may name `paths` (up to 32): only files at or under them are shipped to its check container. Without `paths` the whole tree ships. Either way the checked commit's tree is shipped without history.

`yoneda policy show` prints the current rules. Unprotected branches move with write, like any Git branch.

## Settings

| Section | What it holds |
|---|---|
| Landing rules, Checks | The policy above; the checks the platform runs and who may post each |
| Secret exceptions | Accepted secret-scan false positives |
| Webhooks | Signed event deliveries; see [Webhooks](/docs/guides/webhooks) |
| Plugins | Managed review agents and third-party plugins |
| Members, Repository tokens | Who can use the repository; see [Tokens and access](/docs/guides/tokens) |
| Large files (LFS) | The LFS storage quota; see [Git LFS](/docs/guides/lfs) |
| Visibility, Connect | Public or private; clone commands and the repository id |
| Delete repository | Delete it, typing its name to confirm |

## Delete

```sh
yoneda repo delete <id> --confirm <name>
```

Or **Settings → Delete repository**. The name must be typed to confirm. A repository with forks cannot be deleted until they are.
