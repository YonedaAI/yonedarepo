# Git at agent scale: what to change next

Status: proposed, 2026-11-04. Nothing here is built. Each performance item gets its request budget written first, goes behind a switch, and is benched with the 1,000-writer burst and real-history repositories (at least 3 runs, server-side timing, min/median/max), per AGENTS.md.

The aim: as agents multiply branches, pushes and fetches, a fetch should cost the platform almost nothing, and a push to one branch should never wait on another. The landing guarantees on `main` (ordered log, declared reads, server-side merge) stay as they are.

## Where we start

| Path | Today | Where |
|---|---|---|
| Full clone | Streams one stored pack from R2 (`PACK_CACHE=on`); a job builds `main`'s pack after each push | `cloudflare/worker/repo-pack-cache.ts`, `repo-pack-jobs.ts` |
| Fetch with haves | Builds a pack per client: the authority walks the commits, the Worker diffs each against its first parent and writes an undeltified pack | `backend/crates/yoneda-platform/src/platform_git_upload.rs` |
| Stored-pack key | sha256 of the exact sorted wants, filter and depth, so only identical requests share a pack | `repo-pack-cache.ts` |
| Push storage | Verified objects written as bundles (frames), indexed by the authority | `cloudflare/worker/repo-bundles.ts` |
| Push advertisement (v0) | Every ref, plus up to 64 recent and sparser older `main` commits as `.have` | `cloudflare/worker/repo-git-http.ts:185-200` |
| Fetch advertisement (v2) | `ls-refs` honours `ref-prefix` | `backend/crates/yoneda-platform/src/platform_git_v2.rs:50-84` |
| Ref moves | Every ref, working branches included, moves in the one repository authority | `repo_store` |
| Formal checks | Reference model with differential tests against real Git; ACID contract tests; no model checker or deterministic simulation | `yoneda-refmodel`, `repo_store/tests/{differential,acid}.rs` |

## 1. Serve fetches from stored packs, indexed by log version

Every landing on `main` already has a log version, which is a total order per repository. Use it as the index for packs:

1. On each landing on `main`, the existing pack job writes an L0 pack holding exactly the objects that landing added, keyed `(repo, from_version, to_version]`.
2. A fetch maps its haves and wants to `main` versions (the newest version whose tip the client has; the version it wants) and answers with the packs covering that range. A have that maps to no version falls back to today's per-client pack.
3. Many CI jobs fetching the same new commit now read the same R2 object, which the edge cache can hold.

Accept: a fetch one landing behind does no tree walk or diff in the Worker; the pack passes `index-pack` and `fsck --strict`; the fallback path is still covered by tests.

## 2. Tier the packs, and plan fetches over the tiers

Per-landing packs alone mean a client a day behind downloads thousands of files. Combine them in the background:

1. Tiers grow geometrically: L1 covers 16 L0s, L2 covers 16 L1s, and so on. A cover can be served before it is repacked; repacking only improves compression.
2. Keep every level; delete nothing. A fetch picks the largest covers that fit its range, then smaller ones at the edges: O(log Δ) lookups for a client Δ versions behind.
3. Reuse the log compaction pattern (`repo_store/maintenance/compaction.rs`): plan, write and read back, then record in one transaction; reruns are idempotent.
4. Quarantine and purge already drop stored packs (`docs/runbook.md`); covers follow the same rule.

Accept: a client 10,000 landings behind gets at most a few dozen packs; plan time grows with log Δ, not Δ.

## 3. Send pack links (`packfile-uris`), with the inline pack as fallback

Git can answer a fetch with links to packs rather than the bytes. The Worker then only negotiates; R2 and the edge serve the bytes.

1. Answer with the URLs of the chosen packs and an empty inline pack, when the client asks for `packfile-uris`.
2. Stock Git asks only when `fetch.uriProtocols` is set. `yoneda` sets `fetch.uriProtocols=https` in the clones it configures (`yoneda clone`, `yoneda local init`, the credential helper setup). Everyone else gets today's inline stream.
3. URLs are short-lived and scoped to the pack; access is checked when the link is issued, as stored packs are today.

Accept: a configured client's clone and fetch move no pack bytes through the Worker; an unconfigured one behaves as now.

## 4. Advertise less on push, scoped to the caller

The push advertisement lists every ref, so it grows with every agent branch. Stock Git sends a zero old id for a ref it was not shown, which would turn an update into a create, so the pushed branch has to stay visible. What the platform has that plain Git servers don't: it knows who is pushing.

1. Advertise `main`, protected branches, and the branches the calling token or account created. An agent's token sees its own work, not every other agent's.
2. Record each pushed pack's base (the `main` version advertised). A branch pack built against `main` alone can then be served, unchanged, to anyone fetching that branch who has that `main` version (feeds item 1).
3. Keep the `.have` history of `main`.

Accept: the advertisement size is flat as branch count grows (measure at 10, 1,000 and 100,000 branches); `--force-with-lease` and `--atomic` still pass their tests.

## 5. Take working-branch moves off the serial path, if the burst says so

`main` landings must stay ordered, since that is where the declared-read and merge guarantees live. Working-branch moves only need compare-and-swap per ref.

1. First measure: in the 1,000-writer burst, how much authority time goes to working-branch moves vs landings on `main`.
2. Only if it is a real share: move working-branch refs to per-branch shards (as commits already sit in `CommitShard`), each a compare-and-swap on its own key. `main` and protected branches stay in the repository authority and its log.
3. What to resolve first: `--atomic` pushes that mix `main` and a working branch, and whether working-branch moves keep their log entries.

Accept: working-branch push p95 is unchanged from 1 to 1,000 concurrent writers; `main` landings and their log are unchanged.

## 6. A formal model and deterministic simulation

1. TLA+ spec of landing: OCC validation, the merge outcome, staging-to-R2 handoff, retries after a lost answer, and local-to-cloud sync. Check: no lost update, no landing without its objects, sync reaches a fixed point.
2. Deterministic simulation of `yoneda-local`, the cheapest place to start: one Rust process, one-thread authority, no Cloudflare. Seeded scheduling of pushes, crashes between record and reply, and sync failures; invariants checked after each step.
3. Keep `yoneda-refmodel` as the oracle; failing seeds become regression tests.

Accept: the spec checks under TLC for 3 writers and 2 refs; the simulator runs at least 10,000 seeds in CI time with invariants green.

## 7. Report reliability with every burst

Add to the burst output: landing success rate (landed / attempted, lost races counted apart from errors), retries per landing, fetch failures, and push-to-fetch time (push acknowledged until an independent reader fetches that commit).

Accept: each burst result file carries these four numbers; `docs/load-testing.md` lists them.

## 8. Move a team in through a proxy (option)

`yoneda local init` already pairs with an existing remote. The same idea in the cloud: a repository mirrors an existing GitHub repository read- and write-through, so a team moves its agents first and its people later, with no cut-over day. Decide product scope before building.

## Order

| Step | Item | Depends on |
|---|---|---|
| 1 | 7 (metrics) | nothing; makes the rest measurable |
| 2 | 1 (version-indexed packs) | the pack job |
| 3 | 2 (tiers) | 1 |
| 4 | 3 (pack links) | 1 |
| 5 | 4 (scoped advertisement) | 1 for pack reuse |
| 6 | 6 (model and simulation) | runs alongside |
| 7 | 5 (branch shards) | the step 1 measurement |
| 8 | 8 (proxy) | an owner decision |

Ideas adapted from OpenAI, ["Scaling Git at OpenAI"](https://openai.com/index/scaling-git-at-openai/) (2026).
