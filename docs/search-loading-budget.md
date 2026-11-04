# Search read budget

Three real MiMo queries on dev took 8,248 / 8,752 / 13,555 ms to usable
results. Candidate content reads took 6,534 / 6,936 / 11,134 ms; stored
segments took 1,118 / 1,329 / 2,441 ms. This slice addresses repeated exact
content queries, not the cold scan or its ranking/candidate limits.

With SEARCH_CODE_MEMO on, reuse only completed code results keyed by repository,
exact commit/tree, object store, authority history chain, quarantine epoch,
query, path, case/word flags, result limit and search schema. Resolve the target
and read fresh authority status before lookup. Bypass forks and restricted grants.
Keep record/memory searches and public principal redaction fresh on every request.
Cache no refs, current versions, admission decisions or unfinished I/O. Insert
only after the complete search succeeds; report zero index builds on a hit.
Refused partitions remain retryable: an HTTP 200 answer that names an index
refusal never fills the cache. Binary/oversize file exclusions and the existing
1,000-candidate ranking budget retain their documented scan semantics.

Hit budget: no segment, blob or grep work and no extra authority round trip over
the existing target/status path. Misses keep the current bounded scan. Retain at
most 128 completed values, 4 MiB total and 256 KiB per entry including keys;
deserialize on retrieval so a caller cannot mutate another request's value.

Prove read reuse with real workerd R2 counts. Test content/options and history,
store/quarantine fences, current access, restricted/fork bypass, mutable groups,
errors and independent pending requests. Keep dev/prod generated configuration
in parity. Root measures three live samples after placement validation/deployment
so this slice's effects are separate. No live expensive query is run by this slice.

Local evidence: the initial real-workerd regression failed because a repeat read
still fetched two stored segments. It now fetches zero R2 objects and keeps the
same code payload, with zero new partitions built. After merging current dev,
19 targeted tests across five files, 17 infrastructure tests and six runtime
boundary/logging checks pass. Type/style, format/xtask Clippy, this worktree's
Wasm/frontend builds, generated config parity and size/line budgets pass.
The refused-partition test injects that one refusal; the cache read count,
history reset/import, authorization, quarantine and public reads use workerd.
No frontend layout changes, deployment, live query timings or load burst are
claimed here; those remain the integration/deployment owner's validation.
