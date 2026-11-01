---
title: Organizations and members
summary: Share repositories through an organization, with owners, members and teams.
---

## Create an organization

```sh
yoneda org create acme
yoneda org list
yoneda org show acme
```

You become its owner. Organizations and accounts share one namespace, and nobody signs in as an organization. The web app lists your organizations in **Settings** and shows each one's members and repositories on its page.

## Owners and members

| Role | Can |
|---|---|
| `owner` | Manage members and teams, create the organization's repositories, change their visibility, delete the organization |
| `member` | See the organization; reach its repositories through teams or direct repository membership |

```sh
yoneda org member add acme ada --role owner
yoneda org member remove acme ada
```

An organization always keeps at least one owner, and holds up to 1,000 members. A member may leave on their own.

## Teams

```sh
yoneda org team create acme backend
yoneda org team add acme backend ada
yoneda org team remove acme backend ada
yoneda org team delete acme backend
```

A repository grants a team a role like any member: add `team:acme/backend` under the repository's **Settings → Members** with `read`, `write`, `land` or `admin`. See [Repositories](/docs/guides/repositories#members) for what each role can do.

## Repositories

```sh
yoneda repo create api --owner acme
yoneda org repos acme
```

A personal access token can be limited to one organization's repositories; see [Tokens and access](/docs/guides/tokens).

## Delete an organization

```sh
yoneda org delete acme --confirm acme
```

Only owners can, and only once it owns no repositories. Its members and teams go, and **its name is retired for good**: no new account or organization can take it.

## Legal hold

A legal hold keeps what an organization owns from being deleted, for as long as it stands. An owner places one on the organization (it covers repositories made later) or on one repository, from the organization's page or the API:

```sh
curl -X POST   https://yonedarepo.com/api/v1/orgs/acme/hold -H "Authorization: Bearer $TOKEN"
curl -X DELETE https://yonedarepo.com/api/v1/orgs/acme/hold -H "Authorization: Bearer $TOKEN"
```

While it stands, these answer `423 LEGAL_HOLD`: deleting the repository or the organization, purging it (the **Delete** on Recently deleted included), purging quarantined content, retiring a mirror, deleting a release or a change, and vacuum. Everything else goes on: landing, reads, compaction, deleting a branch (its history stays), removing a member, and quarantine still withholds content from being served. A hold also stops the erasure of a repository already deleted, until it is released.

Any member can see a hold; only owners change it, and a token needs `repo:admin`. Operators can place a hold too, on an organization or on any repository, and only an operator can release theirs. Every change is recorded with who made it.

## Over MCP

The account MCP endpoint has the same operations as tools: `org_list`, `org_create`, `org_show`, `org_repos`, `org_delete`, `org_member_add`, `org_member_remove`, `org_team_create`, `org_team_delete`, `org_team_member_add` and `org_team_member_remove`.
