# Overview admission snapshot budget

Written before implementation, 2026-11-03.

An ordinary Overview already reads fresh repository status before selecting its
tree. A measured request then spent 182ms fetching a separate published head.
That one sample identifies a candidate round trip; it is not an expected saving.
A later normal control measured 11–16ms median head-selection phases. The goal
is one less dependent hop, not a claim of a typical 182ms improvement.

Behind `OVERVIEW_ADMITTED_SNAPSHOT`, ask the existing status command for a
snapshot of the selected branch. Rust selects it with the existing snapshot
rules, inside the same synchronous authority transaction that authorized and
read status. Only a whole-repository, non-fork read with no explicit commit or
historical version may use it. A minimum-version floor above the admitted
version, a pending projection or a missing head keeps the existing path.
Bare SHA selectors also keep their existing commit meaning, even when a
branch happens to share that name; fully qualified branch names stay branches.

The switch starts off in both environment declarations. It also requires the
existing Overview bootstrap and deferred-activity switches. The optional hint
is stripped before public status serialization. A distinct typed internal
parameter supplies the selected root to the existing directory reader; no user
JSON field can authorize a read. Fresh grants, withholding and object-store
selection remain in force. No cache, migration, background work or new storage.

Budget for an eligible core read: one existing status RPC, zero published-head
selection RPCs, no added authority RPC, and one immutable root-tree read. The
same selected commit feeds latest-commit metadata, README and deferred history.
The returned hint is bounded to version, ref, commit, tree and parents; it does
not contain tree entries, activity, credentials or another access snapshot.
The SQL snapshot adds bounded current-ref/record lookups, not historical replay.
This removes the separate `head.fetch` selection lookup, not the existing
`read.trees` / head-holder tree RPC or the object reads it performs.

Fallback budget and semantics remain unchanged when the switch is off or the
hint cannot be used. No request may use `status.refs` as a snapshot, serve a
last-projected commit while that branch is pending, or skip current admission.

Acceptance requires targeted native and real-workerd checks for moving main,
pending projection, empty head, explicit historical/commit selectors, archived
history, forks, path grants, withholding, access denial and switch-off behavior.
Generated contracts, Wasm, types and touched-language checks must pass before a
controlled dev comparison. No live test, deployment or latency claim is part of
the source implementation. Normal dev page measurements must precede enabling
this path in production; writer/load tests and models are outside this slice.

## Local verification

Three native tests cover atomic current selection, the pending/missing/fork/
restricted exclusions, and a current read after actual log compaction. The
initial native test failed because status did not yet return a selection.

Thirty-seven targeted real-workerd Overview tests pass. Eligible current reads
make one status RPC and zero separate published-head selection lookups. Named
and id routes strip the hint before returning public status. A landing racing
admission preserves the admitted commit, README and deferred-history window.
Actual pending projection serves no stale tree; the existing path resumes after
projection. Historical Overview still reads through an archived log segment.
Whole-repository reads still apply fresh withholding; directory grants,
revocation and private denial retain their previous behavior.

Two additional regressions were reproduced before their fixes: a wrong-branch
hint at the same version bypassed selection, and a bare SHA ref changed meaning
when a same-named branch pointed elsewhere. Both now retain the old selector
behavior; an explicitly qualified SHA branch still selects that branch.

The own-worktree Wasm build, generated contract check, configuration drift
checks, off-by-default regional/environment guard, Rust fmt/Clippy, adapter
TypeScript and frontend production build pass. These are local results with
scripted fixtures, not deployed latency or a completed release gate. The new
switch remains off in both environment declarations pending a controlled dev
comparison.
