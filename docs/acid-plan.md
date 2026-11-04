# ACID landings plan

Status: draft, 2026-11-04. Nothing here is built yet; "Today" rows describe `dev` at `705060e3`.

Goal: state exactly which transaction guarantees a landing gives, prove each one with a test, and close the gaps, so "ACID" is a claim we can defend line by line.

## Foundation: Git's object model stays

1. Objects stay standard Git: immutable, content-addressed blobs, trees, commits and tags. No new object types, no extra headers, no rewritten history.
2. Any Git client keeps working unchanged: clone, fetch and push see an ordinary repository.
3. Transactions act on **refs**, never on objects. The transaction log (`yoneda-core/src/txlog.rs`) records ref transitions and the paths each touched; replaying it rebuilds refs.
4. Every guarantee must be checkable from plain Git plus the log: the landed commit is an ordinary commit, and its parents show the order.

## Transaction boundary

| Item | Boundary |
|---|---|
| Unit | One landing: one ref transition (or one `git push --atomic` batch) |
| Scope | One repository. The repository's Durable Object SQLite is the authority |
| Commit point | The SQLite transaction that moves the ref and appends the log entry |
| Out of scope | Transactions across repositories; semantic correctness beyond the required checks |

## Today

| Property | Holds | Evidence | Gap |
|---|---|---|---|
| Atomic | Yes, per repository | Ref compare-and-swap and hash-chained log entry in one transaction (`repo_store/land.rs:1-12`) | A `--atomic` push that mixes a protected branch with working branches: working branches move as one batch, protected ones land separately (`repo-git-moves.ts:1-5`). All-or-nothing across both is unproven |
| Consistent | Partly | Gates are judged on the exact head and decided again inside the land transaction (`land_gates.rs`, `landings-plan.md:257`) | A platform merge commit lands under the **original** commit's gates (`merging.rs:177-196`); checks on the merged tree run after main moves, and a failure proposes a revert (`version_projection.rs:111`, `repo-checks.ts:76`). Main can briefly hold a tree nobody checked |
| Isolated | Partly | Backward validation against log entries after the base: a later write to a declared read is a conflict (`txlog/occ.rs`). Batches prevent write skew between members (`merging.rs:218`, Adya G2-item). Land-when-cleared holds a Landing whose reads or writes meet one ahead of it | An explicit landing with no declared reads is checked for same-file writes only (merged three-way). That is close to snapshot isolation: write skew through files nobody declared can land |
| Durable | Yes | The reply waits for the SQLite transaction to be durable (output gate, `commit_shard.rs:115`). Staged objects stay in the authority until R2 confirms each write (`repo_store/staging.rs`) | The failure model is unwritten. Acknowledgment loss (client times out after commit, retries) is not covered by a named test |

### Isolation levels as built

| Path | Level |
|---|---|
| Explicit landing, no declared reads | Snapshot-isolation-like: no lost update (three-way merge or conflict), write skew possible |
| Explicit landing, declared reads | Serializable over the declared read set |
| Batch (land combiner) | Serializable over declared reads; a member with none counts its writes as reads |
| Land when cleared | Same as batch, plus separation in queue order |

Declared reads are agent claims. The 2026-10-31 memory run found recorded reads missed shell `sed` and `head` (`landings-plan.md:91`), so serializability is only as strong as read coverage.

## Work, in order

Each step starts with a failing test, puts new behavior behind a branch-policy switch, and keeps every Git object unchanged.

1. **Contract tests for what holds today.** In the differential suite (`repo_store/tests/differential`, oracle `yoneda-refmodel`, checked against real Git), add one scenario per anomaly: dirty write (G0), lost update, stale read with declared reads, write skew within a batch. These should pass now; they pin the claims.
2. **Write skew test for explicit landings.** Two changes from the same base: A reads `x`, writes `y`; B reads `y`, writes `x`; neither declares reads. Expect both to land today. This test documents the gap before step 4 closes it.
3. **Atomic mixed push.** `git push --atomic` moving `main` and a working branch where the `main` landing is refused: expect no ref moved. Fix in `repo-git-receive.ts` if it fails.
4. **Strict isolation switch.** Policy `isolation: "serializable"` makes an explicit landing with no declared reads count its writes as reads, as batches already do. Default stays as today until measured.
5. **Checks before main moves.** Policy `merged_checks: "before"`: a platform merge commit is held, the required checks run on the merged tree, then it lands with `expected_head`; a moved head rebuilds the merge. Measure the added landing time with the 1,000-writer burst before turning it on anywhere.
6. **Read coverage.** Record reads from `claude-bash` for `cat`, `head`, `tail`, `sed -n`, `grep` and `rg` paths. Measure coverage on the memory run's tasks.
7. **Failure model and durability tests.** Name the failures covered: isolate crash mid-request, Durable Object restart, R2 write failure, acknowledgment loss. Add a test per failure where one is missing (start with acknowledgment loss: a retried push gives the same outcome and one log entry).
8. **Publish the contract.** A guarantees section in `README.md` stating boundary, isolation level per path and the failure model, with links to the tests. Only claims with a passing test go in.

## Wording until step 8 lands

"Each landing is an atomic, durable transaction in one repository, serializable over the reads an agent declares." Do not say "ACID for Git" without that scope.
