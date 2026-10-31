# Enterprise plan

Status: plan. Written 2026-10-31 at dev `d3f67f6f`. Builders are working from it.

Four things enterprise buyers ask about deletion and records. Nothing that works today may break; the safety rules in [global-scale-plan.md](global-scale-plan.md) apply.

| Need | Status | Stage |
|---|---|---|
| Org owners delete their org's repos | Built and tested with a session and MCP | Add the missing token and second-owner tests |
| Deleted data really gone | Being built | 1 |
| Undo window | Not built | 2 |
| Legal hold | Being built | 3 |
| Audit log | Being built | 4 |

Operators never get a general delete. Operator actions stay reversible.

**No plan gating.** Our public terms promise every platform feature free, so these are on for everyone.

## 1. Deleted data really gone

Branch `claude/erase-repos`. The mapping added:

- **Live gap:** purge never touches `derived/v1/<repo>/` (search, packs, symbols, facts), which hold file content, or the 64 commit shards, though `privacy.md:101` says code is deleted.
- Attach the wipe at the end of `purgeRepository`, after the Artifacts loop.
- Keep the `repo_settings` tombstone: without it, calls answer `NOT_FOUND`, not `GONE`, and managed cleanup silently stops (`dispatch.ts:92`).
- `repo_purge_target` must still answer after the wipe, because the job is at-least-once.

## 2. Undo window: 30 days, fixed

**What changes:** the purge waits, and restore is possible until it runs.

| Step | When |
|---|---|
| Tombstone, repo tokens revoked, name released, unlisted | At delete, as today |
| `repo.deleted` webhook | At delete, as today |
| **Purge, wipe, managed review cleanup** | **After 30 days** |
| New `repo.purged` webhook | After 30 days. The managed Worker clears reviews on this instead |

**Running it later:** the existing every-minute cron sweeps a new D1 table, `platform_deleted_repos`, for due rows and sends a normal `platform_purge`. Don't use queue hops or a Durable Object alarm: a rollback would drop the chain, or trap. Never park a future purge in a queue: old code purges any tombstone. A `deleted_repo:<id>` row in the owner's `workspace_records` is the durable source, so D1 stays rebuildable.

**Gate:** `purge_target` refuses until `deleted_at + 30 days`, so the authority decides. A purge arriving after a restore acknowledges quietly.

**Restore,** modelled on rename, by the same people who can delete:

1. Check it can restore, and read workspace, name, visibility and `created_at`.
2. Hold the name; if taken, ask for a new one. Names aren't held during the window.
3. A fork needs its parent alive, and re-registers with it. Refuse otherwise.
4. Commit, re-list with the original `created_at`, rebuild members.
5. Refresh access. Re-arm projection, objects, hooks, quarantine and LFS sweeps.

Tokens stay revoked. Managed connections must reconnect.

**During the window** every answer stays as it is today: `GONE`. Quarantine keeps running on tombstones, so a leaked secret doesn't wait 30 days.

**Org delete** warns about repos in the window, and is refused under a hold.

**Tests and dev storage:** new operator-only `POST /admin/repos/<id>/purge-now`, audited, refused under hold. The live tests call it in teardown. No public "skip the window" option: the window exists to survive a stolen token.

**Listing:** a new D1 table, not a `deleted_at` column on `platform_repos`: about 20 queries read that table, and one missed filter would leak a deleted repo.

**Text to change:** "It cannot be undone" (`ConnectPanel.tsx:145`), "permanently" (`account-mcp.ts:73`), `privacy.md:101,118`, and the guides listed in the mapping. The owner reviews legal text.

## 3. Legal hold

**Blocks:** repo delete, purge and wipe, quarantine purge, mirror retirement, release delete, change delete, vacuum, org delete.

**Doesn't block:** landing, compaction, memory retire, LFS orphan sweep, branch delete (history stays because vacuum is blocked), member removal. Quarantine still withholds content from being served.

**Where:** rows `legal_hold` and `legal_hold:<repo>` in the owner's `workspace_records`. No migration. **Never in `policy`:** a rollback would fail every op on that repo, and passed checks would stop counting.

**Fail closed:** a Rust list of destructive ops refuses unless the adapter supplies a verified `_hold` answer, in the shape of `capacity::refuses`. The adapter asks the owner's authority on destructive paths only, so landing costs nothing, and new repos are covered automatically. `_hold` joins `CREDENTIAL_KEYS` so clients can't set it.

**Who:** an org owner sets and releases the org's own hold. An operator hold can be released only by an operator. Every change is audited.

**Error:** `LEGAL_HOLD`, HTTP 423. Queue jobs treat it as "try later".

**A hold beats an erasure request** until released.

## 4. Audit log

**Where:** a sibling `audit:<org>` instance in the existing `WORKSPACES` namespace. No new class, and `workspace_events` already exists there. It's apart from the org authority, so a full log can't break org access.

**Events to add:** login, logout, failed login, OAuth, device approval; repo token create and revoke; visibility, rename, repo delete and restore, retention, webhook create and delete; hold set and release. Org events gain their missing actor.

**Delivery:** events must commit with state (`AGENTS.md`), so repo events need an outbox table: the next `repo_store` migration, in two waves. New queue kind `platform_audit`, only after every binary knows it, since unknown kinds are acknowledged and dropped.

**Integrity:** a hash chain in each row, as `txlog` does. Old rows seal to R2 under `audit/v1/<org>/`, a prefix no purge touches. Retention per org.

**Read:** `GET /orgs/:org/audit?before=<seq>&kind=&actor=`, owners only, tokens need `repo:admin`. Page by `seq`. Export JSON and CSV, neutralising leading `= + - @` in cells. UI at `/orgs/:org/audit`.

**Secrets:** a typed allow-list per event, never passed-through arguments. Webhook URLs log the host only. Reasons are capped and secret-scanned.

## Order

1. Finish deleted-data erase.
2. Legal hold and audit log, in parallel.
3. Undo window, on top of erase and hold.
