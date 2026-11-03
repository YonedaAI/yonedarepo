# Automatic locality: first implementation

This supersedes the fixed account-region default for automatic placement. With
`AUTOMATIC_LOCALITY=on`, actual agent/human request location selects US East or
Western Europe. Unknown/unsupported locations keep their current path. Nothing
requires a region picker, and existing repository URLs and ordered history stay.

## Request budget, before measurement

- Off: no copy lookup, fill or placement change on reads/creates.
- A request reaching a supported location enrolls one nearby copy per repository:
  one registry RPC, shared within the request, plus one copy lookup per eligible
  tree/blob. A cold object retains its current authoritative read.
- Fill at most 16 objects and 4 MiB of encoded content per request, awaited by that
  read. Each object must fit 1 MiB encoded; the Rust store validates its Git id.
- Each nearby store stops filling at 512 MiB database size. A miss, full store,
  oversized object or failed copy falls back to the existing authoritative path.
- Access and ref freshness retain their current checks and version floors. No
  access grant, ref or mutable push bundle is answered from a file copy.
- A purge adds a registry fence plus one fence RPC for each enrolled region. Its
  existing durable queue job cannot acknowledge until every copy is fenced.

No latency claim is made from this budget. Request execution is still affected by
Worker placement, authentication, the authority and the first cold fetch. Measure
from real US/European clients before enabling the availability claim.

## What this slice copies

Existing and new ordinary repositories acquire durable SQLite copies of the
content-verified trees and small blobs they read. Subsequent reads of those ids
use the copy automatically. New ids fill on demand as the authoritative history
advances; stale cached bytes cannot represent another Git id. Commits, refs,
large files and inherited fork objects retain their authoritative paths.

This is an on-demand file copy, not a complete regional mirror or a backup. Full
large-history copies and routing all request computation locally remain later
work. Customer-managed backup copies remain a separate enterprise feature.

## Deletion and quarantine

The private Rust `RepositoryReadCopy` class holds an enrollment registry and one
store per repository/region. The registry advances a publication epoch before a
purge fans out to every enrolled store. In one SQL transaction, each store
keeps the maximum epoch and deletes the affected bytes, even when older
fences arrive late. Blocked ids are durable at the copy as well as the registry. A late fill with the older
epoch is rejected. Whole-repository purges seal the registry and each copy
permanently; the tiny seal remains after its content is gone. A failed fence
fails the purge job and is retried, including when the read switch is off.

Never remove `READ_COPIES` after it has been enabled: the durable purge path still
needs that binding. Push bundles are not copied as immutable data; quarantine
rewrites them. Private copies have no public bucket or API route.

## Deployment

The new class uses the appended `v9` Durable Object migration, without altering
existing class identities or repository SQL migrations. Both environments keep
`AUTOMATIC_LOCALITY=off`. Deploy this code before enabling that variable. Cloudflare cannot roll back across that class migration; a rollback must use a
compatible build retaining the class, migration history and binding. Local workerd proves state,
authorization and race behavior, not physical placement: Cloudflare's location
[location hints](https://developers.cloudflare.com/durable-objects/reference/data-location/)
are best effort and count only when a new object is first reached. HTTP/API
request location is covered; SSH gateway-origin requests do not identify the
end client here and retain their existing path.
