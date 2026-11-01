# Platform analytics plan

To save as `docs/analytics-plan.md`.

Status: Phase 1 built behind `TRAFFIC_REPORT`, off. Phase 3 steps 1 and 2 and Phase 6 built behind `REPO_ANALYTICS`, off. The rest is plan. Written 2026-10-31 at dev `4755d9c1`.

## What this answers

1. **Human adoption:** are developers finding us, signing up and coming back?
2. **Agent adoption:** how many distinct agents use us, and do they succeed?
3. **Autonomous delivery:** how much software landed, validated, with no human in the loop?

**Bad news first:** today we can answer almost none of this.

| Gap | Evidence |
|---|---|
| Prod collects nothing | `TRAFFIC_EVENTS` is off, and Basin is bound nowhere |
| No agent exists as a thing | `ypat_` drops the token id, so an agent and a person both read `user:<account>` |
| Refused landings mostly vanish | Gate refusals return an error before any write (`land.rs:166`) |
| "Autonomous" can't be proven | `reviews.principal` can't tell a person's approval from an agent's |
| Counts are of requests, not outcomes | No status or duration is stored; "valid token" isn't "succeeded" |
| No internal account flag | Our own use can't be excluded by account |
| No per-repo clone or push record | Counts carry no repository, bytes or duration |

## Built on what we already run

The outside proposal's metrics are the goal. Its architecture isn't. No new collector, queue, aggregation Worker or analytics database, and no generic `PlatformEvent` type.

| Need | Use | Why |
|---|---|---|
| Sampled counts, visitors, operations | Analytics Engine, dataset already bound | One write per request, kept three months |
| One row per landing, history, autonomy | Basin change log | 32 fields already: actor, latency, queue wait, checks, refusals. Built, never bound |
| Accounts, repos, sign-ups, funnel | D1 | Already holds them, wakes no Durable Object |
| Queues, dead letters, errors, p95 | Superfan and the Cloudflare GraphQL reads | Already built for the load tools |

Rules:
- New paths sit behind a switch, off by default.
- Write the request budget first. Each request gets at most one Analytics Engine point.
- No network I/O in a transaction: points are written after the answer.
- No repository migration unless named below; those ship in two waves.
- Nothing here adds a Durable Object class.

## Definitions

| Term | Meaning |
|---|---|
| Verified agent | A platform-issued credential marked for an agent, or a managed agent. Shown as "agent credentials": one can run many processes |
| Self-reported agent | Named only by the client: `cli`, `model`, user agent. Always labelled |
| Unknown automation | Automated, no attribution |
| Landing | One change on the base branch, excluding imports and ref moves |
| Landing success rate | Landed ÷ (landed + refused + failed) |
| Autonomous landing | Landed with no approval from a human credential. Until step 3.3 ships, labelled "no human approval recorded" |

## Phase 1: Make the numbers true

1. Finish `traffic-fix`: mark all our tools' traffic.
2. Add `internal` to accounts (D1 migration, additive). Set it for our own and test accounts, and leave them out of every figure.
3. Store outcome and duration on client points: success, failed, unauthorized, rate limited.
4. Every chart follows the selected range. Today `by_day` is always 30 days.
5. Ranges: 24 hours (hourly), 7 and 30 days (daily), 90 days (weekly).
6. Compare with the previous period.
7. Mark estimates: reads are sampled 1 in 10, so show `≈` and say so.
8. Count signed-in page views as humans, unless `traffic-fix` finds a real reason not to.
9. One shared chart: hand-written SVG with hover values. No chart library.

## Phase 2: Basin on

1. Run `tools/platform-analytics.mjs setup` on dev, bind `pipelines`, deploy.
2. Filter queries to real landings and add a daily rollup.
3. Add the credential id (hashed) and its kind to each row: additive, new schema version.
4. Soak on dev, then prod.

Counts start on the day it's bound: there's no backfill.

## Phase 3: Landings and autonomy

1. Record each gate refusal with its reason as a point, written after the answer.
2. Report: success rate, latency P50/P95/P99, queue wait, retries, refusals by reason, checks run and failed, direct pushes counted apart.
3. **Repository migration, two waves (`0046` is taken by repository limits, so the next free number):** store the credential kind on `reviews` and `TxEntry`, so a human's approval can be proven.
4. Report the autonomous landing rate. This is the headline number.

Steps 1 and 2 as built: `recordClient` (`platform-client-events.ts`) writes the request's one point after the answer, carrying what `repo-usage.ts` noted: a landing's outcome and reason, its queue wait and the rounds the platform repeated it. The Traffic page reads it (`GET admin/traffic/landings`). "Retries" is what the server can see: rounds it repeated, and landings asked for again once they had landed. A client that gives up and pushes a new commit isn't one.

## Phase 4: Agents

1. Add a purpose to personal tokens when created (agent or person), and keep the token id on the principal.
2. Build the Agents tab: active credentials, sessions, repositories reached, organizations, reads, writes, landings, failures, success rate, retry rate, concurrency.
3. Client names (Claude Code, Codex, opencode and so on) stay labelled self-reported.

## Phase 5: Visitors and the funnel

**Decision: a daily rotating, salted hash, no cookie.** It gives unique daily visitors and approximate sessions without tracking anyone across days.

**The cost:** new versus returning visitors isn't possible. That would need a cookie, which breaks `privacy.md:147`. Add one later only with consent and the owner's word.

1. Visitors, sessions, entry and exit pages, referrers, countries, device, browser.
2. Store sign-up referrer and UTM in D1 against the account, so a campaign can be followed to a repository.
3. Funnel: Visitor → Docs → Sign-up → Repository → First push → First landing.
4. Retention: active again a week later.

**Before prod:** the owner reviews `privacy.md`. Lines 6, 67, 75, 106 and 147 change. Client points aren't listed there today, which is already a gap.

## Phase 6: Repositories

1. Add the repository, bytes and duration to clone and push points.
2. New repository Insights page beside `ctc`: activity, human versus agent, clones, landings, failed landings, contributors.
3. Admin Repositories tab: most active, largest, fastest growing.

As built, and what it can't say yet:

- Human versus agent reads "People in the browser" against "Tokens and agents" until Phase 4 can tell a person's token from an agent's.
- Fastest growing is bytes pushed over the range: nothing keeps a repository's past sizes, and commits made through the API add no bytes. Largest stays the database size the derive job samples.
- Clones count packs sent to a fetch that had nothing, so a partial clone's later blob fetches count too. A clone served from the import mirror isn't counted.
- Contributors are commits the repository recorded, from the newest 5,000. A commit still in its shard joins when it lands.

## Phase 7: Operations and Infrastructure

1. Operations tab: outcomes and P50/P95/P99 by operation and client.
2. Infrastructure tab: queue depth and wait, dead letters, retries, failures, storage growth, Worker errors, D1 latency. The data is minutes old, and the page says so.

## Phase 8: Audit

1. Operator log gets a People and System split; People is the default, so test cleanup and backfills leave it.
2. Filters: actor, action, target, outcome, date.
3. A row opens a detail panel: request id, time zone, actor, origin, outcome, metadata. No tokens.
4. `admin_audit` gets outcome, request id and actor kind (D1 migration, additive).
5. Purges show requested, queued, completed, failed.
6. Record staff reading a customer's private content, and failed admin attempts.
7. Org log: finish `audit-events`. Landing rule changes, forced landings, webhooks and exports need the outbox migration from `docs/enterprise-plan.md`, in two waves.

Never audited: reads, or every push and landing.

## Phase 9: Later

Per-organization analytics, exports and a reporting API, then public `yonedarepo.com/stats`, with only figures we can explain and defend.

## Page layout

Admin's **Traffic** tab becomes **Analytics**, with six tabs: Overview, Visitors, Agents, Repositories, Operations, Infrastructure. Audit log stays separate.

Overview shows six cards with period comparison: Visitors, Active agents, Active repositories, Landings, Success rate, Active organizations. Below them, one chart per dimension, because agent traffic would flatten human traffic on a shared axis.

All of it follows the UI rules in `AGENTS.md`.

## Prod

| Step | Needs |
|---|---|
| `TRAFFIC_EVENTS` on | Privacy text reviewed, then "ship" |
| `AUDIT_LOG` on | "ship" |
| Basin bound | Dev soak, then "ship" |

## Limits we accept

- Dev has no real users, so dev proves the code works and only prod gives real numbers. Check it with seeded data and stubs.
- Basin counts are a floor with no history.

### Analytics Engine limits

Spiked 2026-10-31: Cloudflare's docs, then read-only queries on `yonedarepo_dev_site_events` (2,486 points).

| Question | Answer | Source |
|---|---|---|
| Blobs | 20 a point, 16 KB in total | [Limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/) |
| Doubles | 20 a point | Limits |
| Index | 1 a point, 96 bytes | Limits |
| Index cardinality | No limit published. A value unique to each row is "not recommended": it slows aggregates | [Sampling](https://developers.cloudflare.com/analytics/analytics-engine/sampling/) |
| Writes a request | 250. We write at most 1, or 2 with `REGION_SIGNALS` on (1 write in 10) | Limits |
| Query rate | **No number published.** One statement a request, 10 KiB long; over a limit answers 429, 503 or 507 with `Retry-After` | [SQL API limits](https://developers.cloudflare.com/analytics/sql-api/limits/) |
| Retention | Three months | Limits |
| Price | Workers Paid includes 10M points and 1M reads a month, then $0.25 and $1.00 a million. Billing isn't active yet | [Pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/) |
| `COUNT(DISTINCT blob)` | **Works**, run on dev. `uniq()` answers 422 | [Aggregates](https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/aggregate-functions/), dev |

What this changes:

- **Phase 5 can use `COUNT(DISTINCT)`, but not on today's index.** It counts stored rows, and Analytics Engine drops rows when one index is busy: dev kept 948 of 2,627 points in one hour, `_sample_interval` up to 11. The docs say unique counts are only reliable on the index, so the visitor hash has to be the point's index. Not tested yet.
- **Sampling isn't only ours.** Any count can be an estimate, so `≈` follows `_sample_interval` as well as our 1 in 10 on reads.
- **90 days has no comparison.** The period before it is past retention.
- **Weeks are folded in the Worker.** `INTERVAL '1' WEEK` answers 422, and `toStartOfWeek` returned a Sunday where the docs say Monday.

## Verification

| Phase | Proof |
|---|---|
| 1 | Our own traffic reads 0 after a live test run; every chart follows the range |
| 2 | Landings counted by Basin match the repository's log, on dev (`tools/platform-basin-soak.mjs`) |
| 3 | A refused landing appears with its reason; a human approval and an agent approval read differently; rollback tested on dev |
| 4 | Two tokens read as two credentials; a person's session is never an agent |
| 5 | No cookie set, no IP stored; hash changes daily |
| 6 | A clone appears on that repository only; a private repository's data reaches nobody without access |
| 8 | Test cleanup never appears under People |
| All | Targeted tests, fmt, clippy, tsc, biome; test exit codes checked with no pipe; screenshots looked at, wide and 375px, light and dark, in empty, loading, error and full states |

## Critical files

| Area | Files |
|---|---|
| Points | `cloudflare/worker/site-events.ts`, `site-ping.ts`, `platform-client-events.ts`, `platform-traffic-queries.ts`, `platform-site-traffic.ts`, `shared/site-traffic.ts` |
| Basin | `cloudflare/worker/repo-changelog.ts`, `cloudflare/basin/change-log.schema.json`, `tools/platform-analytics.mjs`, `infra/envs/` |
| Identity | `cloudflare/worker/repo-pat.ts`, `repo_store/auth.rs`, `repo_store/reviewers.rs`, `txlog/entry.rs` |
| Landings | `repo_store/land.rs`, `land_tickets.rs`, `change_records.rs` |
| Admin | `frontend/src/features/admin/AdminTraffic*.tsx`, `AdminLists.tsx`, `AdminParts.tsx`, `cloudflare/worker/platform-admin-queries.ts` |
| Legal | `frontend/src/content/legal/privacy.md` |

## On approval

1. Save this file as `docs/analytics-plan.md` in its own worktree and merge it to dev.
2. Merge `org-repo-fix`, then `traffic-fix` when it's done.
3. Run the Analytics Engine limits spike.
4. Start Phase 1, then Phase 2 alongside it.
