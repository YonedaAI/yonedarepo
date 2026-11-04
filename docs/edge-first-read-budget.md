# Edge-first immutable reads

A warm README read currently checks its regional copy before its local Cache API
copy. The observed aggregate `read.nearby` wait is about 104 ms, while local edge
reads are about 2 ms; this does not establish whether the regional copy missed.

With `EDGE_FIRST_READS=on`, a read probes the existing repository/object/kind edge
key first. It waits at most the existing 50 ms hedge interval, then retains the
regional-copy → R2 → recorded/staged/store fallback. A miss probes edge only once.
The switch off preserves the current traversal and fill lifetime.

Budget: an edge hit performs no foreground regional permit/get or R2 read. The
existing bounded regional fill runs through request `waitUntil`; without that
lifetime owner, it remains awaited. Edge misses add at most 50 ms before the
regional path. No new cache, access TTL, mutable metadata or cross-request promise
is introduced. Fresh authorization, path grants, quarantine and fork guards stay
above the same immutable bytes; existing object-kind checks remain in force.

Split regional measurements into permit/get/fence waits and hit/miss/blocked
counts so an aggregate wait is not misreported as a miss. Background fill times
have separate names and need not appear in the response's timing header.

Local proof uses actual workerd Cache API, R2 and SQLite copy objects, including
held fills, cache miss/kind mismatch, fallback, private access, token revocation,
path grants, quarantine and forks. Root owns dev deployment, three dedicated
1,000-writer/readback runs and at least three retained-history browser runs.
Measure min/median/max, real content completion, server phases and regressions
before claiming this switch improves live latency. Production parity is staged
in source; this slice does not deploy either environment.

Request lifetime follows Cloudflare's `ctx.waitUntil()` contract:
https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil
