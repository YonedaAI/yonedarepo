# Backup plan

Status: options, nothing built. Written 2026-11-01. Nobody uses the product yet, so nothing here is needed today. Choose before the first paying customer.

## What can be lost

| Data | Where | Today's protection |
|---|---|---|
| Git objects and bundles | R2, under `platform/v1/<repo>/` | R2's own durability only. R2 has no versioning, no snapshots and no S3 object lock |
| Branches, commits, Landings, reviews, memories | The repository's Durable Object (SQLite) | Durable Object point-in-time recovery |
| Accounts, tokens, organizations | The account Durable Objects | The same |
| Listings | D1 | Rebuildable from the above |

Artifacts is not a backup: it mirrors what we push, holds Git data only, and caps new repositories at 1 GB against our 10 GB.

## Options for Git objects

| Option | Extra data | Cost at 10 GB | Protects against | Doesn't protect against |
|---|---|---|---|---|
| 1. Nothing | None | $0 | Hardware failure, through R2's durability | A bad purge, a bug, a stolen token |
| 2. Bucket lock on the main bucket, about 7 days | Deleted objects stay for the lock period | Small | A bad purge or deletion for 7 days | Losing the bucket or the account |
| 3. Second R2 bucket with a lock, copied by a scheduled job | Double | About $0.15 a month, plus one write per new object | Option 2, plus damage to the main bucket | Losing the Cloudflare account |
| 4. A copy outside Cloudflare | Double | Depends on the provider, plus egress-free reads from R2 | Everything above, including the account | Breaks the rule to stay on Cloudflare |

Prices are R2's standard storage at $0.015 per GB-month.

**The cost of option 2:** a lock also holds up a real erase, so a permanent delete wouldn't remove files until the lock period passes. Option 3 has the same effect on the copy, and its copy needs its own erase, or erased data stays there.

## Options for Durable Object data

Git objects alone don't restore a repository: Landings, reviews and memories are in its Durable Object.

| Option | What it gives | Effort |
|---|---|---|
| A. Point-in-time recovery only | Recent history, per object, for Cloudflare's retention window | None |
| B. Scheduled export of each repository to R2 | Restore beyond that window, and after a deleted object | One job per repository, and a restore path to write and test |

## Recommendation

1. **Now:** option 1 and A. There's nothing to protect yet.
2. **Before the first paying customer:** option 2 and B, and write the restore steps.
3. **When a customer asks for it:** option 3.

## Done means

A backup counts only once a restore has worked: restore one real repository on dev from it, then clone it and run `git fsck`.
