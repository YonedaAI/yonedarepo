# Organization audit log

Who did what in an organization, for its owners. It's behind `AUDIT_LOG`, off by default. Off writes neither the log nor sign-in events, and `/orgs/:org/audit` answers 404.

## Reading it

| | |
|---|---|
| Page | `/orgs/:org/audit`, owners only |
| API | `GET /api/v1/orgs/:org/audit?before=<seq>&kind=&actor=&limit=` |
| Export | `GET /api/v1/orgs/:org/audit/export?format=json\|csv`, with the same filters |
| Chain check | `GET /api/v1/orgs/:org/audit/verify?after=<seq>` |

- Tokens need `repo:admin`, and an org-limited token reaches only its own org.
- Pages are newest first, at most 200 rows. Pass `next` as `before`. Rows page by `seq`, because many can share a time.
- An export is capped at 100,000 rows. A longer log fails the download rather than ending it early, so continue with `before`.
- CSV cells that a spreadsheet would run as a formula get a leading `'`.

## What's logged

| Kind | Comes from |
|---|---|
| `org.*`: created, deleted, members, teams | The org's authority |
| `pat.created`, `pat.revoked` | A member's account, for tokens limited to that org |
| `ssh_key.added`, `ssh_key.removed` | A member's account, to every org they belong to, since a key reaches all of them |
| `account.recovered` | A member's account: it revoked their tokens and keys |
| `legal_hold.set`, `legal_hold.released` | The owner's account, for the org or one of its repositories |
| `repo.created`, `repo.deleted`, `repo.restored`, `repo.renamed` | The repository. A fork and an import are creates; a fork names its `parent` |
| `repo.visibility_changed` | The repository |
| `repo.member_put`, `repo.member_removed` | The repository, for an account or a team |
| `repo.token_created`, `repo.token_revoked` | The repository, for its own `yrp_` tokens |
| `repo.policy_changed` | The repository: its landing rules, by digest, required checks and approvals |
| `repo.retention_changed` | The repository |
| `webhook.created`, `webhook.deleted` | The repository, with the URL's host only |

Repository events are for repositories an org owns. A person's repository has no log, so its events are dropped when they're copied. A change that changes nothing, such as setting the same visibility, leaves no row, and neither does a failed action or a create that failed part way.

A person's sign-ins stay on their own `workspace_events` and never reach an org: `auth.login`, `auth.logout`, `auth.login_failed`, `auth.device_approved` and `auth.device_denied`. Failed logins share one row an hour, since the address limiter (30 a minute) and the account's own limit (10 a minute) still allow thousands a day. Each person keeps their newest 1,000 sign-in rows.

## How it works

1. An event commits in its own authority, in the same transaction as the change.
2. After the answer, the adapter copies new events to `audit:<org>`, a sibling instance in `WORKSPACES`.
3. The log keeps a cursor per source, so a repeated copy appends nothing and a failed one is picked up by the next.

A failed or slow log never fails or slows the action. The org's own events also catch up on every read. A member's wait for that member's next credential change. A repository's wait in the repository for its next audited change, or for its purge, which copies them before the erase. A read doesn't reach them: the page would have to call every repository the org owns.

A repository's events wait in `hook_outbox`, under hook id 0, which no hook has (`repo_store/audit_outbox.rs`). That table was already an ordered outbox, so this needs no `repo_store` migration, and an older binary leaves those rows alone.

`seq` is the order rows reached the log, and `at` is when they happened, so rows from different sources can differ.

## Integrity and secrets

- Each row's `hash` covers the row and the previous row's `hash`, as `txlog` does. Verify finds an edited, moved or removed row, including the newest. The log is tamper-evident only against someone without the means to rewrite every later row and the head as well; sealing rows outside the Durable Object comes later.
- Only the fields allow-listed per kind enter (`accounts/audit_details.rs`). An unknown kind leaves no row, and a field that isn't listed or has the wrong type is dropped.
- Free text is scanned with `secret_scan`, then capped at 200 characters. Webhook URLs keep their host only.

## Turning it on

1. Deploy the Workers first. This wave adds no migration or Durable Object class.
2. Set `AUDIT_LOG` to `on` in `infra/envs/<env>.json` for both the platform and front (`agents`) Workers, since sign-ins go through both. Run `cargo xtask infra gen --env <env>`.
3. Expect the first copy of each org to bring its past events. Those from before actors were recorded show `Not recorded`.

Turning it off stops copies and hides the routes. Rows stay.
