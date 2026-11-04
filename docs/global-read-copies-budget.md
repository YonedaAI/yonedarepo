# Worldwide creation and read-copy budget

Source slice only. Existing repository ids, authority namespaces, registry names,
object stores and forward-only migration history remain unchanged.

The existing `AUTOMATIC_LOCALITY` switch controls this path. Trusted original
`Request.cf.continent` selects one of enam, weur, apac, oc, sam or afr. HTTP headers,
account preferences and the API Worker's execution region are not client signals.
An explicitly selected authority and EU jurisdiction retain their identities and
stores. For unrestricted authorities, the physical first-get hint still follows
the creator. An authority selection is not an API-execution or physical hint.

Creation places new source, shard and combiner objects with the origin hint before
their first access. Asia, Oceania, South America and Africa retain asynchronous
warmup; this change must not add a blocking 64-shard startup to those creates.
Current US/Europe startup behavior and the dev-only explicit test hint stay intact.

A normal content read may add one fresh registry permit and one regional lookup.
Warm content still uses the existing edge-first path. Permission promises remain
request-owned. A request can fill at most 16 objects, 4 MiB total, and 1 MiB per
object; a copy keeps its existing 512 MiB store bound. No unbounded background I/O
or cross-request pending work is introduced. Copies of commit records and fork
objects retain their existing bypasses. A failure falls back to the admitted
source path. Global purge must fence every previously enrolled region, including
regions no longer eligible for new reads, before acknowledging completion.

EU-jurisdiction repository content may only enroll/fill/read the weur copy. This
restriction cannot alter the hint used by a new default-jurisdiction repository
whose creator happens to be outside Europe. Registry and copy command regions
reuse the core account-region contract. Forward-only read-copy migration0002 widens
SQL CHECK constraints by rebuilding only identity and region tables atomically,
preserving rows, epochs, seals, objects and blocked ids. Applied0001 stays unchanged.

Deploy the updated shared Rust source provider before enabling the regional entry
path. During mixed versions an unsupported new-region copy is a miss and falls
back to admitted source bytes. Never roll the source provider back below migration
knowledge after its copy stores migrate: an older binary refuses the newer schema,
and required purge fencing must remain available even when copy reads are off.

Validation covers all six regions, original geographic metadata versus spoofed
headers, authority and namespace preservation, denied/revoked reads, withholding,
late fills, deletion fences, restart and copy identity. Tests use local workerd and
native SQLite. They prove routing/hint intent and durable behavior, not physical
placement. Cloudflare location hints are best effort; sam and afr currently fall
back to nearby supported Durable Object locations. Root owns live location checks,
three retained-history runs, three 1000-writer bursts and deployment acceptance.

References: [Durable Object location](https://developers.cloudflare.com/durable-objects/reference/data-location/).

## Local validation

The initial native six-region test failed on the old allowlist, then on0001's SQL
CHECK constraint after the allowlist widened. The new migration resolves both.
Initial workerd cases also reproduced missing regional copies and foreign EU copy
access. Final own-Wasm workerd validation passes78 cases across creation origin,
local copies, cross-authority flows and forks. The import held-warmup regression
was caught and fixed without changing its one-second test bound.

Ten native cases pass, including real file-backed close/reopen in each region and
0001 upgrade/repeat preservation of identity, epoch7, seals, objects and withheld
ids. Older migration knowledge refuses the new schema; fault-injected old-provider
refusals are labeled simulated, and the actual admitted source read still succeeds.
The changed adapter passes types/style and three platform-boundary checks; Rust
formatting/Clippy, own Wasm, migration ledger, layer and source-line gates pass.

These results are local source validation. No provider access, deployment, physical
location result, worldwide latency result or live writer burst is claimed here.
Historical foreign copies of EU repositories are not retroactively erased by the
new eligibility restriction. Purge still fences every historical enrollment;
retiring such copies is a separate bounded maintenance action if required.
