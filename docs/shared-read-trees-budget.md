# Shared tree reads: request budget

The three post-coalescing dev bursts completed every operation, but read p95 was
5,431 / 7,328 / 7,730 ms versus the earlier 3,243 / 4,107 / 4,086 ms. Server timing
attributes most of the added read wait to nearby-copy calls. Commit preparation
already uses the repository's tree holder; ordinary file readers still fetch shared
directory trees independently before reading their individual blobs.

`SHARED_READ_TREES=on` lets an authorized file/directory request ask the existing
holder once for the directories its exact selected root/path needs. Returned trees
enter the existing bounded, content-addressed tree memory. No new access cache,
Worker-wide pending promise, revision selection, or blob cache is introduced.

Budget: zero holder calls for an entirely remembered path; at most one holder RPC
for a cold directory walk, and no per-directory nearby-copy calls when it answers.
Individual blob reads and fresh request authorization keep their current path.
A burst of readers of one cold tree must cause one underlying holder tree read,
while independent Worker requests remain independent if an RPC is abandoned.

The experiment applies only to non-fork repositories and requests whose trusted
geographic signal matches the repository's cell. Foreign/unknown regions keep
nearby copies rather than acquiring a potentially distant holder hop. Holder
readers never enter this route helper. Missing/unavailable holders fall back to the
existing exact-root tree walk. The switch is off unless configured explicitly.

Validate cold and warm operation counts, exact historical/staged roots, directory
grants, forks, quarantine, revocation, unavailable holders and cancellation in
workerd. Repeat the 1,000-writer burst three times on retained dedicated dev
fixtures and measure real-history navigation with server timing before acceptance.
Record min/median/max and any remaining latency regression; passing functional
readbacks alone does not establish a performance improvement.
