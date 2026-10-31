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

Thresholds get confirmed by the spike.

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
4. Reuse the compaction shape: plan, seal, write, read back, done, in one transaction (`maintenance/compaction.rs`, `writeVerified`, `purgePrefix`).
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
