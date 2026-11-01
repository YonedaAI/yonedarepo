# Scale and global plan

Status: plan, not built. Written 2026-10-30 at dev `169fb5b0`.

## Context

Owner wants two things, in this order:

1. Make today's single region safe at scale: repo size, archive, search across repos, analytics, load tests.
2. Then put each person's or agent's repos, Workers, indexing and search near them, using signup location as the default.

Hard rule from the owner: **nothing we have now may break.**

Code reading changed three earlier ideas:

| Earlier idea | What the code says | New plan |
|---|---|---|
| Archive old commit rows to R2 | About 30 readers depend on them; clones and forks **silently truncate** if rows vanish (`rows.rs:262`, `rows.rs:136`) | Keep a local skeleton forever; move only the heavy detail |
| Put the region in the repo ID | IDs are `r` + 20 random hex digits, checked at 35 sites plus installed CLIs. Any tag is ambiguous | Keep the ID format. A directory decides; no row means `enam` |
| Unpin the front Worker | `api.yonedarepo.com` is bound to the platform Worker, and CLI, Git and MCP use it | New thin edge Worker, run on a parallel hostname first |

Corrected size estimate: about 5–6 KB per landing, so about **2M landings to 10 GB** (estimated from columns, unmeasured). That is 23 days at 1 landing/s, or 5.6 hours at 100/s. One import can add about 55 MB.

## Safety rules for every step

1. **No renames.** Repo IDs, Durable Object names, bindings and R2 keys stay. Today's stack becomes cell `enam` unchanged.
2. **Every new path sits behind a switch, off by default.** Off means today's behaviour.
3. **Migrations are additive and ship in two waves.** A repo that has run a migration refuses any older binary with `SCHEMA_TOO_NEW` (`migration.rs:222`), switch or no switch. So wave 1 ships a binary that accepts the new version but doesn't apply it. Wave 2 applies it. Rollback then goes to wave 1, never earlier.
4. **A new Durable Object class ships alone, in its own wave.** Cloudflare blocks rollback across a class change.
5. **Dev first.** Full kit at HEAD, 22 of 22, before any prod wave. Prod only on owner "ship".
6. **Reproduce with a failing test first.** Run archive changes against `yoneda-refmodel` differential tests.
7. **Three steps are one-way:** schema migrations, class changes and deleting SQL rows. Before any delete: write segments, read them in shadow mode, compare, and soak on dev.
8. **Routing never adds a new dependency to a path that has none.** `yrp_` traffic reads no D1 today, and it must keep working if the directory is down.

## Order of work

Same five items as the owner's list, with one swap: load tests move before archive, because archive needs their numbers.

| # | Item | Depends on | Ships alone? |
|---|---|---|---|
| 1 | Track repo size, and refuse cleanly near the limit | Nothing | Yes |
| 2 | Load tests, stages 2 and 3 | 1 | No prod change |
| 3 | Trim and archive commit data | 1, 2 | Yes, in stages |
| 4 | Basin analytics | Its own hold fix | Yes |
| 5 | Search across repos | Nothing | Yes |
| 6 | Global regions | 1–5, then gates below | Stage by stage |

**Updated 2026-10-31:** the owner moved [Landings](landings-plan.md) and the memory test ahead of the load tests. Current order:

1. Item 1: track repo size.
2. Erase deleted repos (below).
3. Landings stage 1: fix the gates. Landings stage 2: memory and context test.
4. Remaining Landings stages.
5. Items 2–6 here, in order.

## Erase deleted repos

**Deleting a repo doesn't erase its database.** It marks the repo gone and purges its R2 files, but nothing clears its SQLite; `deleteAll` appears nowhere in the code. Dev lists 51 repos but holds 1,556 repo objects with data. Prod holds 238. Commit messages, paths and sessions of deleted repos stay stored indefinitely, so this is a privacy and a cost problem.

1. **Wipe after purge.** Once the purge job finishes, clear the repo object and its 64 shards, combiners and head holder.
2. **Keep the GONE answer.** A wiped object would answer `NOT_FOUND`. Keep the tombstone row, or decide that `NOT_FOUND` is fine, before building.
3. **Delete in small batches.** The spike shows one big delete can reset an object for minutes. `deleteAll` needs its own test on a large object.
4. **Backfill** existing tombstones on dev, then prod.
5. **Check the privacy text** in `frontend/src/content/legal/privacy.md`; the owner reviews any change.

## 1. Track repo size

1. **Spike first, in a throwaway dev Worker with its own SQLite Durable Object.** Fill it past 10 GB, then answer:
   - the exact error at the limit
   - whether reads, deletes and FTS deletes work at the limit
   - whether deletes lower `databaseSize`, and whether freed space is reused
   Delete the Worker the same day. Nothing in the platform changes.
2. **Add op `repo_storage`** (owner and `_system` only): database bytes, plus row estimates per large table from `max(rowid)`. `worker-0.8.7` already has `SqlStorage::database_size()`; reach it through `CloudStore`. Extend `store_status` for shards.
3. **Sample without new D1 writes.** At the end of the derive job, at most every 10 minutes per repo, read `repo_storage` and add `db_bytes` to the existing `touchActivity` write (`repo-activity.ts`). New column by migration `0010`.
4. **Show it.** Admin repo detail and a "largest repos" list. Reuse `platform-admin.ts:212` and `platform-admin-queries.ts`.
5. **Alert.** Log `repo.storage` at 5, 8 and 9 GB, and show it in admin.
6. **Clean refusal, behind `REPO_STORAGE_GUARD`.** At 9 GB, refuse **new work only**: prepare, record, record pushed, import and new landing submissions answer 507 `REPO_FULL`.
   - **Everything else keeps working,** so work already accepted can finish: projection, changeset recording, hook fan-out and settle, adoption, compaction, checks, token revocation, quarantine, deletes and migrations. Refusing these would stall compaction and branch reads (`compaction.rs:114`, `rows.rs:157`).
   - **In `batch` landing mode, refuse per item.** A whole-batch refusal requeues forever and clients see TIMEOUT (`repo-land-combiner.ts:98,135`).
   - The headroom matters: a pending migration on a full database blocks every command, reads included (`source_repository.rs:26`).
7. **Map the raw failure.** Today a full database reaches clients as HTTP 400 `DATABASE`, which reads as their fault. Map storage-full to `REPO_FULL` too.

Thresholds confirmed by the spike: keep 5, 8 and 9 GB.

### Spike results (dev, 2026-10-31; one object, deleted afterwards)

| Question | Measured |
|---|---|
| Real limit | Writes refused at about 10.7 GB as `databaseSize` reports it, which fits 10 GiB (inferred). 10,713,108,480 bytes was accepted |
| Error | `Exceeded the maximum database size.` It reached the Worker as a thrown error for the whole request, past a try/catch around each insert. 100 inserts in one request all rolled back; 1 insert then fit |
| At the limit | Reads, small writes, table and index creation, FTS inserts and FTS deletes all worked |
| Do deletes shrink it? | Yes, at once. Deleting 500 rows of 1.9 MB and adding 100 lowered it by 762 MB |
| Is space reused? | Yes. Writes worked again after the delete |
| **Large delete** | **Deleting 950 MB in one transaction reset the object: `Durable Object storage operation exceeded timeout`. It then missed two 120-second requests.** The delete did commit. Deleting 19 MB was fine |
| SQLite tools | No VACUUM, `dbstat`, `page_count` or `freelist_count`. `page_size` is 4096. Per-table size has to come from `SUM(length(...))` |

What this changes:

1. **Step 7:** the failure may not arrive as `DATABASE`; it can be thrown when the transaction commits. Test the real path through the Rust adapter.
2. **Archive:** delete in small batches with a byte budget per transaction. One big delete can take a repo offline for minutes. Find the safe batch size on dev first.
3. **Migrations:** small ones work at the limit, so the headroom matters less than first thought. A migration that rewrites rows is still untested there.

## 2. Load tests (stages 2 and 3)

**Build first:**

| Gap | Fix |
|---|---|
| No server-side view | A read-only sampler: floor, tail rows, `db_bytes`, outbox, queue depth, dead letters, D1 errors |
| Results overwrite each other | One timestamped evidence file per run; results table in `docs/load-testing.md` |
| Stop rules differ from the doc | Put the doc's rules in `tools/fanout-bench/sustained.mjs` and `tools/platform-manyrepo-bench.mjs` |
| Repos are remade each run | Saved ID file; reuse them, as the doc requires |
| Many-repo bench always runs a check per repo | A no-checks flag, or it costs money and hits the 4-container cap |
| Many-repo bench sends 2,000 fetches from one laptop | Run it through the bench Worker |
| `yrp_` tokens skip accounts and D1 | Add a `ypat_` arm, or stage 2 says nothing about D1 |
| Benches accept any host | Refuse anything but dev |
| One bench client | Compare 1 against 2 clients |

**Run:**

1. Stage 3 on one repo: 100 landings/s for 30 minutes, then 20 repos at 5/s each.
2. Stage 2: 20, 100, 500, 1,000 repos.
3. At least 3 runs per size. Warn the owner before raising caps or spending money.

**Expected finding (from reading, unmeasured):** all sustained writes go under `load/`, so each derive job rebuilds that whole search partition, and compaction runs after it in the same job. If this shows up, fix it before archive.

**Outputs archive needs:** real bytes per landing by table, and whether compaction keeps up.

## 3. Trim and archive commit data

**Goal:** raise a repo's life about 5× (estimate; recompute from item 2). This is not unlimited; the skeleton still grows, and step 6 of item 1 is the final stop.

**Never leaves SQL:** `commits` skeleton (id, parents, generation, tree) and everything on the must-stay list: ref tips, fork origins, pins, queued landings, unprojected changesets, commits not yet in Artifacts, hidden refs, repair commits, running bisects, tags.

### Stage A: cheap fixes, no cold reads

| Fix | Why |
|---|---|
| Stop storing check evidence twice | Up to 16 KiB in both `checks` and `check_runs` (`checks.rs:203`) |
| Bound `ref_chain` | Each new long branch adds up to 5,000 rows; about 750 KB per agent branch |
| Forget shard copies after `repo_changeset_record` | `repo-changesets.ts` never calls `forgetChain`, so they leak |
| Run compaction even when no landing follows | Today only a landing triggers it |
| Alarm when compaction stalls | Holds stall it silently |

Pick by measured savings from item 2, and re-measure after this stage.

### Stage B: move detail to R2

1. **Refactor first, with no behaviour change.** Split skeleton and detail reads. `read_set` is NOT NULL and parsed on every graph walk (`rows.rs:127,266`), so walks must stop reading it. Move direct SQL readers (`activity.rs:19`, `agent_reads.rs:20`, `search_records.rs:140`) and trigger `session_text_edit` onto the accessor.
2. **Never store an empty placeholder.** `[]` silently skips stale-read checks (`merging.rs:40`). A cold commit carries a marker, and the reader raises.
3. Add `commit_segments` and a nullable `commits.cold_segment`. Migration `repo_store/0044`.
4. Reuse the compaction shape: plan, seal, write, read back, done (`maintenance/compaction.rs`, `writeVerified`, `purgePrefix`). Delete in small batches, never all at once: the spike shows a 950 MB delete resets the object.
5. Seal by bytes, not by count: 1024 commits can be huge.
6. **Eligible commits:** a `landings` row at or below the log floor, so every existing hold is inherited, and not on the must-stay list. Commits have no version of their own, so imports and fork copies stay local at first.
7. Move `read_set`, check evidence, session `reads`, `changesets.message`.
8. Reads raise `COMMITS_ARCHIVED`; `caller` fetches and retries, as `TXLOG_ARCHIVED` does. Allow repeat retries; today it retries once with at most 40 objects (`repo-ops.ts:150`). Extend `repo-landing.ts:48` and the `_log/` key match at `repo-archive.ts:17`.
9. **Late rows:** checks and sessions can arrive after sealing, so readers merge local and cold rows.

### Stage C: move `commit_paths`, only if measurement says we must

It is the largest grower (about 2.7 KB per landing with its text index), and it has the riskiest readers.

| Reader | Replacement |
|---|---|
| `known_blob`, `require_reachable` | Compact local blob-to-commit rows, kept forever, with binary keys. A "seen" list isn't enough: it would serve blobs from deleted branches (`git_wanted.rs:87`). Estimate about 65 B per row; recompute |
| `touches` | Fetch the segment. **Must raise on a cold commit, never return `[]`,** or path-restricted tokens pass silently (`grants.rs:101`) |
| `path_history`, blame | Local Bloom filter per segment, then fetch matching segments with paging |
| Commit message search | `commit_text` stays local, so old commits stay searchable |
| Commit path search | The delete trigger removes `commit_path_text`. Keep it or accept losing old paths; decide from measured size |
| `memory/candidates.rs:202` | Silently returns nothing on missing rows. Must fetch or raise |
| Fork copy (`fork_copy.rs:161`) | Re-inflates a fork with copied rows. Must keep detail cold |

### Rollout

1. Write-only: seal segments, delete nothing.
2. Shadow: read both, compare, log differences.
3. Dev kit plus `tools/staging/compaction-flow.mjs`, then a soak.
4. Delete on dev. Then prod, one wave, owner "ship".

## 4. Basin analytics

Code and 7 tests exist. It ran on platform-dev and was lost when that stack was retired on 2026-10-27.

**Fix first, or binding it freezes compaction:**

1. **Start at head.** A repo with no cursor starts from the current version, not 0 (`repo-changelog.ts`, compare `start_for_new_hook`).
2. **Limit the hold.** If the stream stalls past a set size or age, release the hold, jump the cursor forward, log it, and accept a gap in analytics. Without the jump, `TXLOG_COMPACTED` repeats (`archive.rs:193`). Analytics must never stop a repo.
3. **Schema drift.** Add `queued_by` to `cloudflare/basin/change-log.schema.json`.

**Then:**

1. Restore `tools/platform-analytics.mjs` from `0779ac19^`.
2. Create a new sink bucket, stream, sink and pipeline on dev. Delete the leftover platform-dev stream.
3. Add the `pipelines` binding in `infra/envs/dev.json`, then `cargo xtask infra gen`.
4. Document the setup in `docs/runbook.md`; xtask does not know this resource kind.
5. Soak on dev, then bind prod.

Limits: 20 streams, sinks and pipelines per account; 1 GB/s per stream; 5 MB per request. Pricing not found.

## 5. Search across repos

Today the browser asks 25 repos, 4 at a time. `GET /repos` also stops at 200.

**Design: a filter, not a global index.** A summary only chooses which repos to ask. Results still come from each repo's own search, so visibility, path grants, org rules, quarantine and the 1-second access bound stay exactly as they are. **The summary can't leak content,** because it is never returned.

1. **Summary.** In `platform_derive`, build a small trigram bitset for each repo from the existing segments (`repo-search-index.ts`), covering file contents and paths. Default branch only.
2. **`SearchDirectory` Durable Object, one per owner, in one namespace.** New class, shipped alone. Rows: repo, bitset, updated time. Rebuildable. It takes repo IDs and has no list-all path.
3. **"Maybe" is always safe.** Treat a repo as a candidate when it has no row, its activity is newer than its summary, its bitset is saturated, or the query is under 3 characters. This covers import, create-with-files and fork, which never run derive (`repo-import-workflow.ts:12`, `repo-create.ts:217`, `repo-forks.ts:88`).
4. **Backfill** existing repos with a job, one owner at a time.
5. **`GET /api/v1/search`.** List the caller's repos with paging, using the same `reachOf`, `_pat` allowlist and org filters as `GET /repos` (`repo-admin.ts:41,75`). Ask each owner's directory, capped per query, then search the newest candidates through the existing `/repos/{id}/search`.
6. **Same cap, better aim.** Still 25 repos per page, now the 25 that can match, with a "more" cursor.
7. **Records.** Commits, sessions, changes and memories stay on the newest 25 repos. FTS can't be filtered this way yet.
8. **Purge.** Remove rows on `platform_purge` and `platform_quarantine`.
9. **Clients.** Swap `searchAllModel.ts` to the new route, behind `ACCOUNT_SEARCH`. Add an MCP tool and CLI command, so agents can use it too.

Searching all public repos is out of scope.

### Request budget (written before the code)

**Built without a new class or a migration:** the directory is a sibling instance in the existing `WORKSPACES` namespace (`search:<owner>`, as `audit:<org>`), and its rows are `workspace_records` (`search:<repo>`). Safety rules 3 and 4 don't apply, so it can ship with a switch alone, and a rollback has nothing to undo.

All of this is behind `ACCOUNT_SEARCH`, off by default. Off, `GET /api/v1/search` answers 404, derive writes nothing and the clients use today's fan-out.

| One `GET /api/v1/search` page | Most |
|---|---|
| D1 listing statements | 5, of 200 repos each (so 1,000 repos per page; a longer account continues on `next`) |
| Directory calls | 16 per page, 200 repo IDs each; repos past that are "maybe" |
| Bytes read per repo in a directory call | 8 positions of its summary, chosen in SQL; the summary never reaches the Worker |
| Repo searches, code | 25, the newest that can match |
| Repo searches, records | 25, the newest overall, on the first page only |
| Repo searches at once | 4 |
| Page time | 20 seconds: nothing starts after that, and what is still running is reported as failed. `next` continues from the last repo started |

A directory that fails or is slow costs the filter, never the search: its repos are "maybe".

| Each `platform_derive` job, switch on | Most |
|---|---|
| Directory calls | 2: a touch, then a put when main has moved |
| Extra authority calls | 1 for the owner, and 1 for main's head on a job for another branch |
| Segment pass | One pass over main's segments when main moved; 256 segments, then the row is "saturated". It stops as soon as the bitset is |

A summary is 2^17 bits (16 KiB, 32 KB as hex), a repo's folded content and path trigrams, hashed. Above two thirds full it is stored as saturated, with no bits.

**Forks.** A new fork holds what its parent does, so `search_fork` leaves a marker row and search skips it until it has activity of its own. Forks made before the switch have no row and are "maybe". A fork whose parent the caller can't list is skipped too until it lands: searching it directly still works.

**Unmeasured on dev:** these are limits, not timings. The dev bench (at least 3 runs, server-side timing, min/median/max) waits for a dev deploy. The only number so far is local workerd: one directory call for 200 rows, 25 runs, min 9 ms, median 10 ms, max 15 ms.

**Known cost:** a landing reaches the summary when its derive job runs. Until then a repo that has a summary and no newer activity row can miss the new content, for as long as the queue takes. Activity that isn't a landing, such as a check result, makes a repo "maybe" until its next derive job: safe, but it searches that repo.

## 6. Global regions

**Design: regional cells.**

| Layer | Holds | Where |
|---|---|---|
| Edge Worker | Routing, cached immutable objects | Unpinned |
| Directory | Handles, repo names, repo → cell for non-`enam` repos | One D1 with read replicas |
| Account authorities | Sessions, tokens, orgs | One namespace; new accounts placed in their home region |
| Cell | Platform Worker, repo Durable Objects, R2, queues, activity D1, check, pack and SSH containers | Per region |
| Single | Downloads, billing ledger, managed agents, AI Gateway, email | One place |

**Indexing** follows automatically: derive jobs are queue work inside the repo's cell. **Search** stays one `SearchDirectory` namespace, because a fork or a chosen region can differ from the owner's cell; each object is placed near its owner. **Managed agents** stay single at first, as API clients going through the router.

**How routing works:**

1. Look in an in-isolate cache first. A repo's cell never changes, so entries never expire.
2. Create writes the directory **primary** before anything else, so "no row" can only mean `enam`.
3. On a directory error, try `enam`. Answer 503 only if `enam` also says "not initialized".
4. Re-check the primary only on that "not initialized" answer, not on every 404.
5. Anonymous admission reads the primary on a miss, or replica lag hides new public repos (`repo-public.ts:46`).

### How a region is chosen

1. **Signup, person or agent:** continent from `request.cf`; store the region code only, never the IP. For an agent this is where it actually runs.
2. **New repo:** the account's region, shown in the create dialog and API, changeable.
3. **New org:** the creator's region. Org repos inherit it.
4. **Fork:** the parent's cell. Forks read parent objects, so a cross-cell fork throws as built.
5. **Existing accounts and repos:** `enam`.
6. **Region is fixed.** A copy tool comes later.

**Signup location is only a default.** Agents often don't run where people live, so item R1 also measures where writes really come from.

### Stages and gates

| # | Stage | Gate to continue |
|---|---|---|
| R1 | Spike 1 (`req.cf` through a binding), then record region on accounts and sample write-traffic continent per account in Analytics Engine | Ships alone; no behaviour change |
| R2 | Load test stage 6 from bench Workers placed in Europe and Asia | **Real delay measured** |
| R3 | Remaining spikes (below) | All answered |
| R4 | Move activity to per-cell storage; add repo → cell table | Kit green, no behaviour change |
| R5 | Add `cells` to `infra/envs`, based on `Spec::ephemeral`, keeping LFS and SSH secrets with each cell's own bucket keys, and `WorkspaceAuthority` by `script_name`. `enam` keeps today's names | **Existing generated wrangler files byte-identical** |
| R6 | Edge Worker on a parallel dev hostname, passing everything through. Rebind the three direct paths: front `PLATFORM` (`front-routes.ts:33,46`), managed `PLATFORM` (`managed/platform.ts:44`), SSH `SELF` (`platform-ssh-gateway.ts:43`). Resolve readable Git names at the edge | Full kit passes through it |
| R7 | API `region` field, behind `CELLS` | Kit item for it |
| R8 | Build `weur` on dev; full kit from Europe | 22 of 22; latency beats R2 |
| R9 | Create dialog region choice | Browser kit item for both cells |
| R10 | Swap `api.` to the edge Worker on dev, then prod. Update `api_origin.rs`, which looks for the domain on the platform role | Owner "ship" |
| R11 | `weur` on prod | **Real users there,** from R1 |
| R12 | `apac` | Signups justify it |

### R1 spike results (2026-10-31)

**Does `request.cf` reach sign-up?** Yes: `accountRoute` and `oauthRoute` run on the Worker the client reached, the front, or the platform on `api.`. No sign-up crosses a binding.

**Through a service binding?** Measured in workerd with `wrangler dev` (two Workers, local). Cloudflare's docs don't state it.

| Call | `cf` at the callee |
|---|---|
| `PLATFORM.fetch(req)` (the front's proxy) | Kept |
| `PLATFORM.fetch(new Request(url, req))` | Kept |
| `PLATFORM.fetch(new Request(url, { headers }))` | Lost |
| `PLATFORM.fetch(url)` | Lost |
| RPC (`accountCreated`) | None: arguments only |

So the region is read where the request arrives and passed on as a value. Git over SSH reaches the platform from the gateway container, so it can't show the client's continent and isn't sampled.

**Not answered:** both Workers are pinned with `placement`. Cloudflare's docs don't say whether `request.cf` reports the client or the placed location. Check before relying on R1's data: the front's dev points should show countries other than the US (`blob4`).

**Stored:** one code per continent, each a Cloudflare location hint: NA `enam`, EU `weur`, AS `apac`, SA `sam`, OC `oc`, AF `afr`. Antarctica, Tor and an unknown continent store nothing and read as `enam`. The account's authority holds the code and `platform_accounts.region` repeats it. `sam`, `oc` and `afr` have no planned cell yet, so R7 must say which cell serves them.

**Write sample:** `write_origin` points in the site events dataset, one write in 10, with the continent and a digest of the account. A repository token's digest is its repository's, because naming the account would add a lookup (safety rule 8).

### Keeping data in its region

**The owner's rule, 2026-10-31: data doesn't go across continents.** A request from Europe is served by Europe's Workers, Durable Objects and storage, and likewise Asia, on Cloudflare only. This replaces stage R2's client × data matrix as the main output. No cells or routing are built here: this says what the design must be.

**Result, 3 runs on dev, 2026-11-01, 0 failures:**

| | Europe today → in region | Asia today → in region | Why |
|---|---|---|---|
| Read, repository token | 162 → **22 ms** | 275 → **15 ms** | Nothing leaves before the answer |
| List | 144 → **11 ms** | 256 → **4 ms** | Nothing leaves before the answer |
| Commit | 224 → **51 ms** | 342 → **41 ms** | Nothing leaves before the answer |
| Land | 205 → **53 ms** | 382 → **33 ms** | Nothing leaves before the answer |
| Sign-in | 244 → **123 ms** | 398 → **76 ms** | Nothing leaves before the answer |
| Read, personal token | 178 → 123 ms | 295 → 257 ms | D1 is the floor: 96 and 238 ms of those |
| Push | 444 → 251 ms | 763 → 426 ms | R2 and the rest of the path |
| Search | 496 → **566 ms** | 670 → **1,142 ms** | **Worse:** D1 and R2 are now further from the code |
| Repository create | 2,439 → **2,959 ms** | 2,361 → **3,814 ms** | **Worse:** 3 D1 calls and 3 queue sends |
| Clone | Not comparable | Not comparable | See below |

Medians in ms at the client. A person there adds their own last mile. North America today, for scale: read 41, list 10, commit 90, land 113.

**The answer:**

1. **The US pins are what keep data in the US.** Remove them and hint the objects, and code, repository objects and accounts all ran in the region, 3 runs of 3: **Amsterdam for Europe, Singapore for Asia.**
2. **Move the Worker, the repository objects and the account together, first.** That one step gives everything in bold above. Neither half alone was measured, and from the hop counts a repository moved without its Worker pays an ocean per call.
3. **Then R2.** It's the largest piece left: one read is 140 ms from Europe and 277 ms from Asia, against 33 and 102 ms from a bucket made in that region. It's what's holding search and push.
4. **Then D1.** Every `ypat_` request and every create pays it: 99 ms from Europe, 234 ms from Asia. **The plan's suspicion was half right:** D1 is the floor, but the account authority isn't once it's local (11 and 8 ms). Read replicas haven't helped yet (below).
5. **Queues and background work have no in-region answer.** Asia needs another way to run them.
6. **What doesn't move:** Asia can't get a guarantee, and Artifacts and Queues have no Asian placement at all. See below.

**Also seen:** static assets come through the pin too. `cf-placement: remote-IAD` on a 982 KB bundle cost Europe 502 ms and Asia 1,233 ms, and that can change on its own, with no region work. In 10 measured operations **no foreground request called the Artifacts binding**, which helps an Artifacts-free Asia.

**What the design must be** (from this result; the cell work itself isn't built or measured):

1. **Requests run where they arrive.** No `placement` on the Workers. Placement is per Worker, so a pin can't differ by region, and with none, one Worker may be enough where the plan drew one per cell. Not tried as such.
2. **A repository's region is fixed at create,** by location hint on the first `get` of all its objects. An account's is fixed at sign-up.
3. **One R2 bucket per region,** chosen by the repository's region.
4. **D1 leaves the hot path.** No `ypat_` request can wait on a primary an ocean away. Replicas, or a token lookup that doesn't need D1, must be proven first.
5. **Background work runs in the region.** Europe: queues with jurisdiction `eu`. Asia: no queue can promise that, so Durable Object alarms.
6. **Artifacts:** a new `eu` namespace for Europe. Asia runs on R2 alone, which is untested on dev.
7. **Containers per region,** one entry each, accepting that a container may not sit beside its object.
8. **What exists stays in `enam`** until a copy tool exists.

**Status:** hop map read from code and config, then checked against this test.

#### Hop map: where each operation goes today

For a person or agent in Europe or Asia. **Crosses** means the hop leaves their continent. Read from code and `infra/envs/dev.json`. Measured on 2026-11-01: requests from Frankfurt and Singapore enter there and answer `cf-placement: remote-IAD`, assets included; every object on this path ran in a US colo (IAD, EWR, ORD, ATL, MIA); R2 and D1 report `ENAM`. Where a queue runs, and where Artifacts does, stays unknown.

| Operation | Hop | Runs in | Crosses? |
|---|---|---|---|
| Every request | Client to the nearest Cloudflare colo | Their region | No |
| Every request | Colo to the pinned Worker (front or platform) | `aws:us-east-1` | **Yes** |
| Page | Front Worker first for every path, assets too (`run_worker_first: true`) | `aws:us-east-1` | **Yes** |
| Page | The page's API calls: front to platform over a service binding | `aws:us-east-1` | **Yes** |
| Sign-in | Rate limiter, then the account's `WorkspaceAuthority` | Colo of the Worker; authority near the pinned Worker | **Yes** |
| Any `ypat_` request | D1 lookup, then the account authority, then any org authority, uncached | D1 primary `ENAM`; authorities near the Worker | **Yes**, 2 or more hops |
| Any cookie request | Account authority (`session`), then any org authority | Near the Worker | **Yes** |
| `yrp_` request | No D1 and no account authority; the repository decides | – | No extra hop |
| Read, list | Head holder (a `LandCombiner`), then the repository authority for what it lacks | Near the Worker | **Yes** |
| Read | Object tiers: memory, Cache API in the Worker's colo, R2, then shard or Artifacts | R2 `ENAM`; Artifacts unknown | **Yes** on a miss |
| Clone | Repository authority for access, refs and the walk; R2 for bundles and stored packs | Near the Worker; R2 `ENAM` | **Yes** |
| Clone, imported history | Artifacts | Unknown | Unknown |
| Push | R2 writes (bundles), authority records, queue sends | R2 `ENAM`; queue location undocumented | **Yes** |
| Commit | Head holder, then a commit shard | Near the Worker | **Yes** |
| Land | Shard read, the branch's combiner, the repository authority | Near the Worker | **Yes** |
| Search | D1 listing, the owner's `search:` directory, each repository's head and R2 index segments | D1 `ENAM`; R2 `ENAM` | **Yes** |
| Repository create | Account authority (name), repository authority, D1 listing, queue (Artifacts store), 64 shards, head holder | All of the above | **Yes** |
| After any write | Queue consumer on the pinned Worker: projection to Artifacts, derive, compaction, hooks | `aws:us-east-1` | **Yes** |
| Large pushes | Pack build in a container | Constrained to `ENAM` | **Yes** |
| Checks, managed agents | Containers | Constrained to `ENAM` | **Yes** |

New Durable Objects land near whoever first asks for them, so today that's near the pinned Worker: **every Durable Object is in the US because the Workers are.**

#### For each crossing hop, the Cloudflare way

Read in Cloudflare's docs on 2026-10-31. Measured figures for what this saves are in the result above and the tables below. **Removing the Worker pin wasn't tried as such:** the test ran platform code in a Durable Object.

| Hop | Cloudflare's way | What it can't do |
|---|---|---|
| Worker pin | Remove `placement`: Workers then "run in a data center closest to where the request was received" | Placement is per Worker, not per hostname or request. [Regional Services](https://developers.cloudflare.com/data-localization/how-to/workers/) can force execution in-region on a custom domain, but not on `workers.dev`, not for subrequests, and not for queues or cron. Code and secrets still deploy globally |
| Static assets | Drop `run_worker_first: true`, or list only the paths that need it: assets then come from the edge without the Worker. [Up to 100 patterns](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/) | The front's page metadata and analytics run first today, so those paths must keep it |
| Repository objects, combiners, shards | [`locationHint`](https://developers.cloudflare.com/durable-objects/reference/data-location/) on the first `get`: `enam`, `weur`, `apac` and more. Or `jurisdiction('eu')` for a guarantee | A hint is best effort, and counts once. **Objects never move.** `sam`, `afr` and `me` don't spawn objects. Jurisdictions are `eu`, `us` and `fedramp`: **Asia can't have a guarantee.** A jurisdiction changes an object's id, so existing names can't take one |
| Account authorities | The same, at sign-up | One account has one home, so a person who travels pays for it |
| R2 | [One bucket per region](https://developers.cloudflare.com/r2/reference/data-location/): location hint `weur`, `apac`, or jurisdiction `eu` | A hint counts only the first time a name is created, and no bucket moves. No read replicas. [Local Uploads](https://developers.cloudflare.com/r2/buckets/local-uploads/) (open beta) writes near the client and then **replicates to the bucket across regions**, and refuses jurisdiction buckets: it breaks the rule, so it's out |
| D1 reads | [Read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/) with `withSession`: replicas in ENAM, WNAM, WEUR, EEUR, APAC and OC, no extra charge. Without `withSession`, everything still goes to the primary | Public beta since 2025-04-10; no GA found. Replicas lag, so a revoked token can read as live unless the session starts at a bookmark or `first-primary` |
| D1 writes | Always the primary. One database per region ([hint at creation](https://developers.cloudflare.com/d1/configuration/data-location/); jurisdiction `eu`, `us`, `fedramp`, fixed for life) | No multi-writer: a shared table has one home continent. **So nothing global can be written from a region without crossing** |
| Cached objects | [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/) in each colo; our objects are immutable, so it's safe | Per colo, never replicated. `cache.put` doesn't work with Tiered Cache. Our own comment says it stores nothing on `workers.dev`, so it needs a custom domain. A first read in each colo still reaches R2 |
| Queues | [Jurisdiction](https://developers.cloudflare.com/queues/configuration/data-location/) `eu`, `us` or `fedramp`, at creation only | **No location hint, and nothing for Asia.** By default messages are handled "across Cloudflare's global network". Where a consumer runs isn't stated |
| Workflows | Nothing documented | No location or jurisdiction on the limits page. Not checked further |
| Artifacts | [Namespace jurisdiction](https://developers.cloudflare.com/artifacts/guides/data-localization/) `eu` or `us`, at creation only, for every repo in it | **No hints and nothing for Asia.** Ours has none and can't take one, so Europe needs a new namespace |
| Containers | [`constraints.regions`](https://developers.cloudflare.com/containers/platform-details/placement/) (`WEUR`, `EEUR`, `APAC`, …) or `jurisdiction` per container entry | [A container isn't guaranteed to run where its Durable Object does](https://developers.cloudflare.com/containers/platform-details/architecture/). The April changelog lists only ENAM, WNAM, EEUR and WEUR; the placement page adds APAC. Unverified until tried. One entry per class, so a region is a class or a Worker of its own (safety rule 4) |
| Metadata | [Customer Metadata Boundary](https://developers.cloudflare.com/data-localization/compatibility/) | Logs and analytics for Durable Objects aren't available outside the US under it. A Durable Object's id is logged outside its jurisdiction. Analytics Engine has no region control. These hold metadata, not repository content |

**What can't be done on Cloudflare today:**

1. **A guarantee in Asia.** Durable Objects, R2 and D1 take hints there, which are best effort. No jurisdiction exists.
2. **Artifacts in Asia.** No hint and no jurisdiction. R2 is already the store of record (`repo-projection.ts`), so an Asian repository has to run without Artifacts. `R2Store` exists, used only locally today. Imports refuse it (`repo-create.ts:240`), and it has never run on dev.
3. **Queues in Asia.** Background work there has no way to stay put. The alternative is Durable Object alarms in the repository's own object, which runs where it landed.
4. **Moving what exists.** Objects, buckets, namespaces and D1 jurisdictions are fixed at creation, so today's repositories stay in `enam` until a copy tool exists.
5. **A global write from a region.** Names, handles and sign-in lookups have one home.

#### Same-region test

`tools/platform-region-matrix.mjs`. 3 runs on dev, 2026-11-01.

**Why it can run without a cell.** A Durable Object's code runs where the object landed, and it's the platform's code. Behind `REGION_HINT_TEST`, an instance of `LandCombiner` named `region-serve:<hint>` runs the platform's real routes, started in `enam`, `weur` or `apac` by a location hint (`repo-region-serve.ts`). A client Worker in that region reaches it through a binding, and nothing else can. No new class, no routing change, and no existing request goes this way.

| | Today's path | In-region path |
|---|---|---|
| Client | Worker in `aws:us-east-1`, `aws:eu-central-1` or `aws:ap-southeast-1` | The same |
| Code | Pinned platform Worker | Platform routes in the region's serving object |
| Repository objects | `enam` | Hinted: region's `enam`, `weur` or `apac` |
| Account | Signed up through the pinned path | Signed up in the region, so its authority starts there |
| R2, D1, queues, Artifacts | As today | **As today, on purpose:** these are what the test counts |

**What it reports:**

1. **Which hops still leave.** Each binding that can leave is wrapped, and each call lands in `Server-Timing` as `hop.r2`, `hop.d1`, `hop.authority`, `hop.queue`, `hop.artifacts`, `hop.shard`, `hop.combiner`. That makes the hop map above measured. What a combiner or repository object calls for itself isn't counted.
2. **Where it ran.** `GET /repos/<id>/where` has the code, each object and the account authority fetch Cloudflare's trace page and answer their colo. That's how [Where Durable Objects Live](https://where.durableobjects.live) works; Cloudflare documents no API for it.
3. **Each piece from each region,** through a binding: D1 by primary and through a session, R2 in the platform's bucket and in a test bucket made with that region's hint, the account authority, the repository objects.

**Not tested:** the queue consumer stays on the pinned Worker, so background work crosses in both paths, and R2 stays in `ENAM` on the in-region path. A test bucket gives R2's local number, not a whole path on it, because queue jobs read the platform's bucket. Real Git can't reach the in-region path, so clone and push there are Git's request forms. Only the first of 64 shards reported its colo.

**What still left the region:**

| Hop | Operations | One call, Europe | One call, Asia | With the Cloudflare way |
|---|---|---|---|---|
| D1 | `ypat_` requests, search, create | 99 ms | 234 ms | Replica: no gain yet, below |
| R2, platform bucket | Clone, push, search, a read that misses | 140 ms | 277 ms | Bucket in region: 33 and 102 ms |
| Queue send | Create; repository writes | About 57 ms | About 178 ms | No location control. Where it goes is unknown |
| Queue consumer | All background work | Not timed | Not timed | None for Asia |
| Pinned front Worker | Pages and assets | 203 and 502 ms | 507 and 1,233 ms | Not tested |

**How to read the odd numbers:**

1. **Clone isn't a regional result.** North America moved nothing, yet in-region clone there took 1.0 to 9.3 s against 1.1 s today. `Server-Timing` stops when the answer starts, 617 against 261 ms from Europe, so the rest came after: probably the pack streaming out of a Durable Object (inferred, not traced). A clone reads R2 about 5 times, all crossing. Its real in-region time is unmeasured.
2. **R2 in Asia is slower than in Europe,** 102 against 33 ms for a read, and 263 against 136 ms for a 4 KB write. Both buckets report their hinted region. Cloudflare doesn't say where `APAC` really is, or why a write takes that long.
3. **"Before the answer" is exact.** Work a request defers, such as a queue send after a landing, ends after `Server-Timing` is written and isn't listed. It's in the background row above.
4. **These repositories are new and their objects are near.** A read of an object held only in R2 pays R2's row above. Later objects weren't tested.
5. **Queue sends** are the phase's total divided by 3: 172 and 533 ms.
6. **The account stays local only if it started there.** Sign-up through a regional client placed it in AMS and SIN. An existing account stays in the US.
7. **One serving object answered each region,** one more local hop than a Worker would pay: 10 ms in Europe, 3 ms in Asia.

<!-- region-results:start (tools/platform-region-matrix.mjs --results) -->
3 runs, last at `18a1b287`, 2026-11-01. Cells: median of run medians in ms (min–max of run medians).

**Clients**

| Client | Placed near | Ran in colo |
|---|---|---|
| North America | aws:us-east-1 | IAD |
| Europe | aws:eu-central-1 | FRA |
| Asia | aws:ap-southeast-1 | SIN |

**Where it ran**

| Client | Path | Hint | Code ran in | Authority | First shard | Main combiner | Head holder | Projector | Account |
|---|---|---|---|---|---|---|---|---|---|
| North America | today | enam | IAD ×3 | ATL ×1, IAD ×2 | MIA ×1, EWR ×2 | ATL ×1, EWR ×1, MIA ×1 | IAD ×3 | EWR ×3 | IAD ×3 |
| North America | region | enam | EWR ×3 | ORD ×1, EWR ×1, IAD ×1 | EWR ×2, IAD ×1 | EWR ×2, MIA ×1 | ATL ×1, IAD ×2 | EWR ×2, ATL ×1 | IAD ×3 |
| Europe | today | enam | IAD ×3 | IAD ×3 | IAD ×3 | ATL ×1, IAD ×2 | MIA ×2, ATL ×1 | EWR ×1, ATL ×2 | IAD ×3 |
| Europe | region | weur | AMS ×3 | AMS ×3 | AMS ×3 | AMS ×3 | AMS ×3 | AMS ×3 | AMS ×3 |
| Asia | today | enam | IAD ×3 | EWR ×2, MIA ×1 | IAD ×2, EWR ×1 | MIA ×1, IAD ×1, ORD ×1 | IAD ×3 | IAD ×1, MIA ×1, EWR ×1 | EWR ×3 |
| Asia | region | apac | SIN ×3 | SIN ×3 | SIN ×3 | SIN ×3 | SIN ×3 | SIN ×3 | SIN ×3 |

**What each operation still reached, on the region's path** (calls per answer, median time)

| Operation | North America | Europe | Asia |
|---|---|---|---|
| Sign-in | limiter 1× 0 ms, authority 3× 105 ms | limiter 1× 0 ms, authority 3× 100 ms | limiter 1× 0 ms, authority 3× 70 ms |
| Read, repo token | combiner 0.2× 15 ms | combiner 0.3× 8 ms | combiner 0.5× 5 ms |
| Read, personal token | d1 1× 14 ms, authority 1× 15 ms, combiner 0× 17 ms | d1 1× 96 ms, authority 1× 11 ms, combiner 0.1× 8 ms | d1 1× 238 ms, authority 1× 8 ms, combiner 0.1× 6 ms |
| List | none | none | none |
| Search | d1 2× 29 ms, authority 2× 34 ms, r2 1.6× 95 ms, repository 4× 77 ms | d1 2× 192 ms, authority 2× 32 ms, r2 1.3× 267 ms, repository 4× 40 ms | d1 2× 481 ms, authority 2× 165 ms, r2 1.3× 566 ms, repository 4× 35 ms |
| Clone | r2 4.7× 305 ms, shard 86.7× 13469 ms, repository 7× 115 ms | r2 4.7× 756 ms, shard 86.7× 5443 ms, repository 7× 60 ms | r2 4.7× 1468 ms, shard 86.7× 4551 ms, repository 7× 48 ms |
| Commit | combiner 0.6× 59 ms, shard 1× 39 ms | combiner 0.6× 9 ms, shard 1× 27 ms | combiner 0.7× 8 ms, shard 1× 16 ms |
| Land | shard 1× 10 ms, combiner 1× 75 ms | shard 1× 9 ms, combiner 1× 29 ms | shard 1× 7 ms, combiner 1× 31 ms |
| Push | combiner 0.3× 571 ms, r2 1× 72 ms, repository 8.3× 158 ms | combiner 0.3× 1824 ms, r2 1× 142 ms, repository 8.3× 81 ms | combiner 0.5× 3490 ms, r2 1× 278 ms, repository 8.5× 53 ms |
| Create | d1 3× 58 ms, authority 2× 72 ms, queue 3× 213 ms, shard 68× 48216 ms, combiner 4× 796 ms, repository 6× 548 ms | d1 3× 289 ms, authority 2× 42 ms, queue 3× 172 ms, shard 68× 109419 ms, combiner 4× 1220 ms, repository 6× 1068 ms | d1 3× 715 ms, authority 2× 21 ms, queue 3× 533 ms, shard 68× 179154 ms, combiner 4× 1930 ms, repository 6× 826 ms |

**Client time**

| Client | Path | Page | Asset | Sign-in | Read, repo token | Read, personal token | List | Search | Clone | Commit | Land | Push | Create |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| North America | Today | 57 (40–66) | 31 (22–32) | 176 (128–178) | 41 (40–68) | 40 (37–42) | 10 (10–11) | 279 (246–406) | 1095 (913–1388) | 90 (90–103) | 113 (95–168) | 236 (210–368) | 1921 (1696–2691) |
| North America | In region, enam | not measured | not measured | 109 (106–132) | 18 (17–19) | 46 (45–47) | 10 (9–10) | 280 (229–291) | 8549 (953–9264) | 84 (66–106) | 89 (76–143) | 244 (212–411) | 2365 (1650–2708) |
| Europe | Today | 203 (165–217) | 502 (472–512) | 244 (236–343) | 162 (134–201) | 178 (159–198) | 144 (132–152) | 496 (379–499) | 1260 (1226–1510) | 224 (203–249) | 205 (171–248) | 444 (432–484) | 2439 (1831–2468) |
| Europe | In region, weur | not measured | not measured | 123 (120–125) | 22 (19–24) | 123 (122–124) | 11 (10–11) | 566 (552–941) | 5149 (2129–5716) | 51 (49–58) | 53 (47–75) | 251 (242–934) | 2959 (2255–3125) |
| Asia | Today | 507 (376–522) | 1233 (1201–1237) | 398 (381–399) | 275 (270–310) | 295 (287–296) | 256 (255–265) | 670 (567–811) | 1788 (1780–2045) | 342 (331–351) | 382 (375–400) | 763 (749–929) | 2361 (2253–2848) |
| Asia | In region, apac | not measured | not measured | 76 (76–79) | 15 (15–15) | 257 (256–257) | 4 (4–5) | 1142 (1119–1210) | 6625 (3247–7091) | 41 (29–63) | 33 (30–62) | 426 (341–692) | 3814 (3608–4488) |

**Server time (`Server-Timing` total)**

| Client | Path | Page | Asset | Sign-in | Read, repo token | Read, personal token | List | Search | Clone | Commit | Land | Push | Create |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| North America | Today | not measured | not measured | not measured | 22 (21–23) | 27 (22–29) | 0 (0–0) | 232 (196–345) | 319 (292–667) | 65 (57–67) | 85 (72–152) | 190 (185–333) | 1885 (1666–2493) |
| North America | In region, enam | not measured | not measured | 91 (91–118) | 4 (4–5) | 34 (34–37) | 0 (0–0) | 245 (195–261) | 734 (281–864) | 63 (52–92) | 76 (64–132) | 217 (184–381) | 2348 (1633–2692) |
| Europe | Today | not measured | not measured | not measured | 50 (27–54) | 70 (45–71) | 38 (22–42) | 190 (187–250) | 261 (231–344) | 89 (73–90) | 68 (51–89) | 174 (171–190) | 2170 (1713–2320) |
| Europe | In region, weur | not measured | not measured | 100 (95–111) | 5 (4–5) | 111 (110–111) | 0 (0–0) | 533 (521–890) | 617 (476–745) | 32 (30–35) | 40 (35–60) | 224 (214–909) | 2930 (2233–3110) |
| Asia | Today | not measured | not measured | not measured | 18 (18–18) | 39 (37–44) | 10 (9–11) | 245 (174–264) | 297 (284–398) | 82 (75–109) | 122 (112–144) | 234 (229–422) | 2082 (1979–2582) |
| Asia | In region, apac | not measured | not measured | 65 (64–70) | 4 (4–7) | 251 (250–252) | 0 (0–0) | 1121 (1101–1198) | 1130 (964–1318) | 38 (15–57) | 27 (19–52) | 411 (324–677) | 3805 (3596–4481) |

**Each piece from each region, one call through a binding**

| Piece, one call | North America | Europe | Asia |
|---|---|---|---|
| trace | 1 (1–2) | 1 (1–1) | 1 (1–1) |
| platform_health | 7 (5–20) | 106 (104–107) | 243 (243–249) |
| d1 | 9 (7–13) | 99 (98–100) | 234 (234–236) |
| d1_session | 9 (7–11) | 100 (97–102) | 273 (272–276) |
| account_authority | 5 (4–6) | 16 (12–16) | 5 (4–7) |
| r2_head | 63 (55–66) | 139 (135–143) | 273 (269–283) |
| r2_get | 63 (57–72) | 140 (137–142) | 277 (269–295) |
| serve_object | 10 (9–10) | 10 (9–13) | 3 (2–3) |
| repo_enam_today | not measured | not measured | not measured |
| shard_enam_today | 15 (14–40) | 100 (100–104) | 238 (236–242) |
| repo_enam | not measured | not measured | not measured |
| shard_enam | 14 (10–15) | not measured | not measured |
| r2_local_put | not measured | 136 (132–136) | 263 (261–306) |
| r2_local_get | not measured | 33 (30–35) | 102 (100–112) |
| r2_local_head | not measured | 31 (29–32) | 98 (98–99) |
| repo_weur | not measured | not measured | not measured |
| shard_weur | not measured | 37 (20–37) | not measured |
| repo_apac | not measured | not measured | not measured |
| shard_apac | not measured | not measured | 7 (7–9) |

**D1 through a session, with read replication on**

| Client | Answered by |
|---|---|
| North America | not measured |
| Europe | not measured |
| Asia | not measured |

**Real Git from the Mac**

| Git, from the Mac | ms | Failed |
|---|---|---|
| clone | 1658 (1428–2119) | 0 |
| push | 493 (389–548) | 0 |
<!-- region-results:end -->

**R3 spikes the docs answer:**

| Spike | Answer |
|---|---|
| 1. Can an Artifacts namespace be regional? | Only by jurisdiction, `eu` or `us`, when it's created |
| 2. Placement on RPC | Still contradicts itself: placement "only affects `fetch` handlers", and the page's own example relies on RPC. Not measured |
| 3. Where does a Durable Object land? Does a hint work through our bindings? | **Yes, both.** `weur` landed in AMS and `apac` in SIN, 3 of 3, for the authority, first shard, combiner, head holder and projector, through the platform's bindings and a Worker binding by `script_name`. `enam` scatters across IAD, EWR, ORD, ATL and MIA. Containers: not guaranteed beside their object, by the docs; not measured |
| 4. Is D1 read replication GA? | No GA found; public beta since 2025-04-10 |
| 5. Where do R2 and D1 live? | `ENAM`, both |

### Spikes for R3

1. Can an Artifacts namespace be regional?
2. Does placement apply to RPC? Cloudflare's page contradicts itself, and `accountCreated` uses RPC.
3. Where do a Durable Object and its container really land with a location hint? Cloudflare doesn't guarantee they're together.
4. Is D1 read replication GA, and does it meet the bound with `withSession`?
5. Where do the R2 bucket and D1 primary live today?

### Known hard parts

| Risk | Plan |
|---|---|
| Wrong cell answers `NOT_FOUND` | A new repo could look missing for a moment (`dispatch.rs:27`). The routing rules above cover it; kit item for it |
| Auth sets the latency floor | Each `ypat_` request reads D1 uncached and calls `WORKSPACES`. Use read replicas, cache within the 1-second bound, and place accounts in their home region |
| In-process calls with no repo in the path | Account MCP, Home refresh, admin detail and delete must call a cell-aware `caller` |
| Create spans global and cell state | Keep `holdName` and `takeBack`; write a new request budget |
| Directory becomes an authority | Region lives on the repo authority too, so the directory stays rebuildable |
| SSH | First `weur` goes through the existing gateway and router. Regional gateways later share host keys, or every client's `known_hosts` breaks |
| Global orgs | One repo, one home. Far members write slowly; cached reads help them |
| Legal residency | A hint is best effort. "EU only" needs a separate `eu` cell, and an R2 jurisdiction can't change later |
| Deploy tooling | `Env`, role uniqueness, shared D1 migrations, `is_prod` gates and the prod guard all assume one stack. Cutover tests fail first, which is useful |
| Rule change | `AGENTS.md:66` "Exactly two environments" becomes two environments, each with one or more cells. Owner approves |
| Public text | "No region to pick" (`featurePages.ts:66`, `global.md`) and the US data statement in `privacy.md` must change before R11. Two tests pin them. Owner reviews the legal text |

## Found along the way

1. **Likely bug:** `setHandle` writes `env.INDEX` (`account-handles.ts:63`), but the front Worker has no D1. Confirm with a failing test.
2. Batch-landed commits stay in shards forever (Stage A).
3. Full databases answer HTTP 400 (item 1).
4. A stalled change-log stream would silently stop compaction, with no limit (item 4).

## Critical files

| Area | Files |
|---|---|
| Size | `backend/crates/yoneda-cloudflare/src/lib.rs`, `backend/crates/yoneda-worker/src/source_repository.rs`, `cloudflare/worker/repo-derived.ts`, `repo-activity.ts`, `repo-api.ts`, `platform-admin.ts` |
| Archive | `repo_store/rows.rs`, `repo_store/maintenance/`, `cloudflare/worker/repo-compaction.ts`, `repo-archive.ts`, `repo-ops.ts` |
| Load | `tools/platform-manyrepo-bench.mjs`, `tools/fanout-bench/`, `docs/load-testing.md` |
| Basin | `cloudflare/worker/repo-changelog.ts`, `cloudflare/basin/change-log.schema.json`, `infra/envs/dev.json` |
| Search | `cloudflare/worker/repo-search-index.ts`, `repo-derived.ts`, `frontend/src/features/search/searchAllModel.ts` |
| Regions | `xtask/src/infra/spec.rs`, `cloudflare/worker/front-routes.ts`, `repo-create.ts`, `oauth.ts`, `accounts.ts`, `site-events.ts`, `frontend/src/features/shell/NewRepositoryDialog.tsx` |

## Verification

| Item | Proof |
|---|---|
| Every item | Targeted tests, fmt, clippy, tsc, biome; full kit 22 of 22 at HEAD on dev; prod smoke after each ship |
| Size | Worker test with real DO: size reads back; guard refuses new work, per item in batch mode; projection, compaction, adoption and reads still work. Spike evidence kept |
| Rollback | For each migration wave, roll back on dev and confirm repos still answer |
| Load | Evidence files, min/median/max over 3 runs, results table filled |
| Archive | Compaction test suite extended; differential test on an archived store; clone, fork, blame, revert and search after archive; shadow compare shows 0 differences |
| Basin | `repo-changelog.test.ts` extended for start-at-head and hold limit; compaction still runs when the stream is stopped |
| Search | Path-restricted and revoked tokens see nothing new; a repo beyond 25 is found; purge removes it |
| Regions | R5 byte-identical check; kit through the parallel hostname; wrong-cell test; `yrp_` traffic works with the directory down; existing repos and CLI 0.2.0 work unchanged |

## On approval

1. Save this file as `docs/global-scale-plan.md` from its own worktree, and merge to dev. No code.
2. Start item 1, spike first.
3. Region work beyond R1 stays design only until its gates pass.
