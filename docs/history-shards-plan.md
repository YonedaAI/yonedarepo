# History shards plan

Status: plan, not built. Written 2026-10-31. **Don't build it yet:** nothing is near the limit.

## Why

Each repository has one authority database, and Cloudflare refuses writes at about 10.7 GB (measured). Git objects and file contents already live in object storage, so code size doesn't fill it. Activity does: commit records, file paths, checks, sessions and landings.

The growth rate is an estimate, not a measurement: about 5 to 6 KB per landing, so about 2M landings to 10 GB. That's about 23 days of nonstop work at 1 landing a second. The hour-long real-use test will report the real figure.

This plan replaces archive stages B and C in `docs/global-scale-plan.md`.

## When to build

Start when either is true:

| Trigger | Signal |
|---|---|
| The largest repository passes **5 GB** | `repo.storage` at 5 GB, also sent by email |
| A real user's repository is on course to reach 8 GB within 3 months | Admin, largest repositories, growth over time |

Until then these protect us:

1. Warning emails at 8 and 9 GB.
2. `REPO_STORAGE_GUARD`, which refuses new work near the limit while reads and deletes keep working.
3. Archive stage A, once its savings are measured.

## Design

Split by age. A repository's authority keeps what needs one writer. Old history moves out, because it never changes once written.

| Data | Stays in the authority | Moves to a shard |
|---|---|---|
| Branch tips, the landing order, queued landings | Yes | No |
| Recent commits | Yes | No |
| Old commit records, file paths, checks, sessions | No | Yes |

1. Near a threshold, seal the oldest history into a new read-only Durable Object, `history:<repo>:<n>`.
2. A repository has as many shards as it needs, so it has no size wall.
3. The authority keeps a small map of which versions live in which shard.
4. A read of old history asks the shard. Reads stay SQL, so blame, history and search keep working.

**Why not R2:** archive stage B moved this detail to R2 files. Storage is cheaper, but every old query must fetch and scan files, and about 30 readers would change. Shards keep SQL and leave those readers nearly as they are.

## Hard parts

| Risk | Rule |
|---|---|
| Clones and forks truncate silently if rows vanish (`rows.rs`) | A reader never sees a gap: it asks the shard, or refuses |
| `[]` for a cold commit skips stale-read checks | Never store an empty stand-in |
| `touches` returning nothing lets path-limited tokens pass | Raise on a sealed commit, never answer empty |
| `known_blob` and `require_reachable` | Must reach shards, or deleted branches' blobs get served or real ones refused |
| Late rows: checks and sessions can arrive after sealing | Readers merge local and sealed rows |
| A new Durable Object class ships alone | Reuse an existing namespace if that works; decide first |
| Deleting rows is one-way | Only after shadow reads match |
| Repository deletion | Purge must find every shard, or data outlives the repository |

## Rollout

1. Write only: seal shards, delete nothing.
2. Shadow: read both, compare, log differences.
3. Dev: full live tests, `tools/staging/compaction-flow.mjs`, then a soak.
4. Delete on dev. Then prod, on the owner's word.

Differential tests against `yoneda-refmodel` must pass on a sharded store.

## Open questions

1. Real bytes per landing, by table.
2. What size starts sealing.
3. How much a sealed read costs in latency and money.
4. How shards work with regions: a shard should live in its repository's region.
