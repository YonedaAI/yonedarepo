# Load testing the platform for agents

Status: stages 2 and 3 have tools, built 2026-10-31 and tried against a stub only. No stage has run on dev. The owner replaced their 5.7-hour plan with the one-hour [real-use simulation](#real-use-simulation). Written 2026-10-30.

Goal: find where the platform stops scaling for agents. So far 1,000 writers passed and nothing failed, so the ceiling is unknown.

## Rules

- Dev only. Prod gets its small smoke, never a load test.
- Write the request budget before running (below).
- At least 3 runs per size. Report min, median and max, using server-side timing (Server-Timing and logs).
- Test data is pure repositories: imported open-source repositories or the owner's dev test repositories, never this codebase. Keep them.
- Nothing else runs on dev during a test. A second kit run replaces the kit's session and fails the first with 401s.
- Warn the owner before a run that raises container caps or costs money.

## What we know

Dev, 2026-10-30, kit from one machine through the bench Worker (`tools/fanout-bench/worker.js`, `tools/platform-fanout-bench.mjs`):

| Test | Result | Rate | Slowest 5% |
|---|---|---|---|
| 100 writers, 1 repository | 100 of 100 | 116 landings/s | land 485 ms |
| 1,000 writers, 1 repository | 1,000 of 1,000 | 168–424 landings/s | land 0.9–4.5 s, commit 0.8–1.2 s |
| 20 repositories × 10 writers | 200 of 200 | 117 landings/s | land 1.3 s |
| Repository create | 20 of 20 | median 3.5 s | max 6.2 s |

Not measured: more than 1,000 writers, more than 20 busy repositories, sustained load, agents far from `aws:us-east-1`, the SSH gateway's limit, or check and pack-builder queues under pressure.

## Request budget

Agree these before the first run. They are starting targets, not commitments.

| Measure | Target |
|---|---|
| Landing errors | 0, other than expected conflicts answered as such |
| Land p95, 1 repository at 5,000 writers | under 10 s |
| Land p95, 100 busy repositories | under 3 s |
| Read p95 during any burst | under 1 s |
| Check start wait | under 60 s at the tested fleet size |
| Monthly cost of one full run | written down before and after |

## Client events budget

`platform-client-events.ts` counts platform requests by client kind (admin Traffic page), behind `TRAFFIC_EVENTS`. Written before the code. Measure on against off before prod turns it on.

| Measure | Target |
|---|---|
| Subrequests added | 0 |
| Awaits added before the response | 0 |
| CPU added per request | under 50 µs |
| Land p95, 1,000-writer burst, on against off | at most 5% worse, 3 runs each |
| Read p95 during that burst | at most 5% worse |
| Data points per request | at most 1: reads 1 in 10, everything else all |
| Failed or missing binding | no response changes |

## Traffic report budget

`TRAFFIC_REPORT` adds outcome and duration to client points, leaves internal accounts out, and opens every range on the Traffic page. Written before the code. Measure on against off before prod turns it on.

| Measure | Target |
|---|---|
| Data points per request | At most 1, as above. With `REGION_SIGNALS` on, 1 write in 10 has a second, its own |
| Points written in a transaction | 0: all after the answer |
| Awaits added before the response | 0 |
| Added to each request | One clock read, one request-scoped store |
| D1 reads per request | 0 |
| D1 reads for the internal list | At most 1 per isolate every 5 minutes, after the answer, and only for a counted request with an account |
| Front Worker calls for the list | At most 1 RPC to the platform per isolate every 5 minutes, only for a signed-in ping |
| List can't be read | The last list stands. With none yet, the point is dropped: a lost point is acceptable, our own traffic in a figure isn't |
| Queries per report | 10 on the SQL API, as today, and 1 on GraphQL. 9 at 90 days, which has no previous period |
| Land p95, 1,000-writer burst, on against off | At most 5% worse, 3 runs each |
| Failed or missing binding | No response changes |

## Region signals budget

`platform-write-origin.ts` samples where writes come from, behind `REGION_SIGNALS` (global regions stage R1). Written before the code. Measure on against off before either environment turns it on.

| Measure | Target |
|---|---|
| Subrequests added | 0 |
| Reads of D1 or an authority added | 0 |
| Work on a GET or HEAD | a switch and method check; no random draw, no watch. A command that may move refs also makes one async-context lookup, which finds nothing |
| I/O awaited before the response | None: the digest and the point run after it |
| CPU added per sampled write | under 50 µs, plus one SHA-256 after the answer |
| Land p95, 1,000-writer burst, on against off | at most 5% worse, 3 runs each |
| Data points per write | at most 1, one write in 10 |
| Failed or missing binding | no response changes |

Sign-up adds one field to two commands and one column to one `INSERT`: no new subrequest.

### GitHub import (`FAST_IMPORT`)

Written before the code, from the hosted numbers we hold (a Worker to Durable Object call 10-50 ms, an R2 write 200-1000 ms). **Not measured on dev yet.**

Today's cost of one commit: 2-3 new trees, each read down every tier (Cache API, R2 twice or more, the authority's staged read, then Artifacts) and then written up to R2 and the edge. A Workflow lends no `waitUntil`, so those writes are awaited. Then one authority call, and one Workflow step per 20 commits. Measured on dev: 1.5 commits/s (233 commits in 149 s).

| Measure | Budget |
|---|---|
| **Click to usable (files read, `git clone` of ours working)** | **Artifacts' fetch plus a few seconds. The bar is a `git clone` of the same repository: 1.0-1.5 s from GitHub to a Mac, 2026-10-31 (pflag 1.1 s, whisper 1.5 s, cobra 1.4 s; 3 runs each)** |
| Artifacts finished to files shown | under 1.5 s: from the request, not the Workflow (dev, 2026-10-31: 1-4 s from request to Artifacts asked, most of it the Workflow starting). A look every 0.25 s, 1 log call per 1,000 commits, 3-6 tree reads, 3 authority calls, the page reading every 0.5 s. Recording history is no part of it |
| Floor, dev, 2026-10-31 | Artifacts' fetch: 2.8-4.2 s (pflag, whisper), against a whole `git clone` at 0.8-1.3 s |
| History | at least 50 commits/s: 5,000 commits under 2 minutes |
| One wave, 250 commits, one Workflow step | under 5 s: 1 log call, about 750 tree reads straight from Artifacts 32 at a time, no R2 or edge writes, 1-4 authority calls |
| One authority transaction | at most 250 commits and 1 MiB of changed paths (a single larger commit goes alone, at most 10,000 paths); well under the 19 MB the size spike deleted safely in one transaction |
| Progress | polled every 1 s, moves at least once per wave |

Bench: `tools/import-bench.mjs`. Report the Workflow's own timing (`output.timing`), at least 3 runs, min, median and max. `DIRECT_IMPORT` has its own budget: `docs/direct-import.md`.

## Stages

Stop a stage at the first of: errors above 1%, p95 over 3× its target, or a Cloudflare limit error. Record what broke. Expected conflicts answered as conflicts are not errors.

### 1. One busy repository

1,000, 2,000, 5,000 and 10,000 writers, using `tools/platform-fanout-bench.mjs --writers N`. Run item 9 first as a baseline. Watch batch size, authority time and queueing in Server-Timing.

Answers: the most an agent fleet can land on one branch.

### 2. Many busy repositories

10 writers on each of 20, 100, 500 and 1,000 repositories, extending kit item 10. Repository creation takes about 3.5 s each, so prepare repositories ahead and reuse them.

Answers: whether repositories really scale independently, and whether D1 or the account authorities bottleneck first.

### 3. Sustained load

100 landings/s for 30 minutes. Watch log compaction, shard outboxes, queue depth, the dead-letter queue, error rate and cost.

Answers: whether background work keeps up, which a burst cannot show.

### 4. Clones and fetches

Real-history repositories at about 100 MB and 1 GB. 10, 100 and 500 clients: partial, full and shallow, using `tools/staging/clone-probe.mjs` for the comparison with GitHub. Include a lazy-fetch run.

Answers: egress cost, pack-builder pressure, and R2 read rates.

### 5. Container pools

| Pool | Cap today | Test |
|---|---|---|
| `CheckContainer` | 4 | 50 checks at once; measure queue wait |
| `PackBuilder` | 4 | 20 repositories needing packs at once |
| `HarnessContainer` | 20 | 25 managed runs on free models, or with a spend cap |
| `SshGateway` | 2, 1 running | Open SSH clones until sessions fail; see [ssh-scaling.md](ssh-scaling.md) |

Answers: what cap each pool needs, and whether its queue stays fair between accounts.

### 6. Limits and distance

- Check that `AUTH_LIMITER` (30 a minute) and `PUBLIC_LIMITER` (300 a minute) refuse what they should, and that a large fleet behind one address is not caught by mistake.
- Run the bench from Europe and Asia. The platform is placed in `aws:us-east-1`.

## Real-use simulation

**The owner's replacement for the 5.7-hour plan:** one hour that behaves like real work, not a request hammer. `tools/platform-real-use.mjs`, built 2026-10-31. Not run for its hour yet. Proved on dev on 2026-11-01: `region` arm, 2 minutes, 220 requests, 0 failed; `today` arm, 1 minute, 107 requests, 0 failed.

**Every number here is an assumption.** There is no real traffic yet. `--dry-run` counts requests from the scripts themselves, so this table can't drift from the code.

| Assumption | Value | Why |
|---|---|---|
| Day | One 24-hour day played in 60 minutes (a simulated hour is 2.5 minutes) | The owner asked for one hour. Only the day's rhythm is compressed: each session keeps its real pace, with think time between steps |
| Sessions at once, peak | 150 | A small team product: about 1,500 daily users if 1 in 10 is active at the peak. Sets the rate; `--peak-sessions` changes it |
| Regions | North America 45%, Europe 35%, Asia 20% | Guess from where developers are. Each follows its own working day (UTC−5, +1, +8), so the load moves round the world |
| Rhythm, people | Quiet at night (2–3% of peak), busy 09:00–17:00 local, a dip at noon | An office day |
| Rhythm, agents | Follows people by an hour, never below 30% of peak | People start agents, and some run all night |
| Accounts, repositories | 24 accounts, 3 repositories each; the popular ones get most sessions (Zipf) | Many accounts, so `ypat_` reads reach many authorities, and a real long tail |
| Repository content | 60 small files, about 2 KB each | Size is known and skipped on purpose (the owner) |

The mix, as printed by `--dry-run`:

| Session | Share | Who | Requests | Think, s | What it does |
|---|---|---|---|---|---|
| `browse` | 28% | Person | 14.0 | 67 | Opens Home and a repository, reads 1–5 files, some blame and history |
| `review` | 10% | Person | 10.2 | 93 | Reads an open Landing, comments, approves, lands 7 in 10 |
| `search` | 7% | Person | 8.9 | 53 | Searches across repositories 2–4 times, opens a hit |
| `agent` | 30% | Agent | 15.0 | 71 | Reads memories, context, tree and files, searches, branches, commits, records a session and a check, opens a Landing, lands 3 in 10 |
| `mcp` | 15% | Agent | 7.6 | 20 | MCP initialize, tools/list, 3–8 tool calls |
| `git` | 10% | Agent | 4.6 | 20 | Clone, and a push 4 times in 10 |

Agents are half the sessions because the product is built for them. The result of the arithmetic: 155 sessions a minute and about 30 requests/s at the peak, about 5,600 sessions and 65,000 requests in the hour.

**Two arms, same day and same seed.** The owner's rule is that data stays in its region, so the default arm is `region`.

| | `--arm region` (default) | `--arm today` |
|---|---|---|
| Accounts, repositories | Each region's start there, `region-hint-sim-*`, by location hint | All near the pinned Worker, `real-use-*` |
| Who answers | The platform's routes in that region ([same-region test](global-scale-plan.md#same-region-test)) | The pinned Worker |
| Pages and assets | The front Worker, pinned: this arm can't move them | The same |
| What's left | `hop.*` in each answer lists what still left the region; the summary totals it | – |

**How it runs:**

1. People carry a session cookie, and on `today` go through `dev.yonedarepo.com`, so the front Worker is in the path. Agents go to `api.dev.yonedarepo.com` with a `yrp_` or `ypat_` token.
2. Each region's requests leave a client Worker placed there (`yonedarepo-dev-region-na`, `-eu`, `-ap`). They enter Cloudflare in that region, as a real user's would, less the user's own last mile.
3. Workers can't run Git, so `git` sessions send Git's own requests as bytes (`tools/fanout-bench/git-forms.mjs`). Real `git` runs from the Mac every 2 minutes: clone, commit, push, fetch. It reaches only the public path, so on `region` it uses only North American repositories. The Mac's Cloudflare location is whatever a trace reports (San José, Costa Rica on 2026-10-31), not one of the three regions.
4. Checks are reports (`POST /commits/<id>/checks`). **No container starts and no model runs,** so the run costs only requests.
5. Arrivals are open loop: a slow platform meets the same people, as in life.
6. `tests/workers/real-use-scripts.test.ts` plays every script through the real routes, so a stale request form fails there, not an hour in.

**Stop rules,** judged each 15 s over the last minute, per class, from 20 requests up: errors above 1%, p95 over 3× target, or a Cloudflare limit error. Targets: read 1 s, write 3 s (the budget above), Git clone 6 s (ours; the budget has none). A lost race (`409 CONFLICT`, `MERGE_REQUIRED`, `STALE_HEAD`, `STALE_PARENT`, `NOT_READY`, `ALREADY_EXISTS`) is counted but isn't an error.

**What it leaves:** accounts `realuse_<arm>_<n>` and their repositories stay in `.local/platform-live/pool-real-use-<arm>.json` for the next run. Each account's password is derived from the kit's, never stored. Tokens are fresh, revoked at the end, and expire in a day. Rows go to `real-use-<stamp>.rows.jsonl`, the summary to one timestamped evidence file. A lock file refuses a second run.

**Before the hour:**

1. Deploy (the three regional clients must exist), then warn the owner. Cost basis: about $0.60 per million platform requests at list price, so 65,000 requests is about $0.04, and background derive jobs add to that. Assume under $1. No caps change.
2. `node tools/platform-real-use.mjs --setup-only`: first run signs up 24 accounts, about 2 minutes, because `AUTH_LIMITER` allows 30 sign-ins a minute. Each sign-up sends a welcome mail to Resend's test inbox.
3. `cargo xtask admin internal --env dev <names>`, with the names from `.local/platform-live/pool-real-use-<arm>.json`, so these accounts stay out of the traffic figures.
4. Make sure nothing else runs on dev and no deploy can happen during it.
5. `node tools/platform-real-use.mjs --yes`.

**On the `region` arm,** one serving object answers each region, where a Worker would scale wider, so its concurrency isn't a finding about a real region. Queue jobs stay on the pinned Worker in both arms.

**Doesn't cover:** real-history repositories, real container checks, model calls, SSH, anonymous public traffic, and more than 150 sessions at once. Those have their own stages above.

## Running stages 2 and 3

Deploy once before the first run, in this order. The tools need both, and the first run stops at its preflight if the bench client is older.

1. `cargo xtask deploy --env dev`: the platform gains `GET /repos/<id>/compaction`, the bench client gains its relay, and `yonedarepo-dev-bench2` appears.
2. Warn the owner; the full plan costs money.
3. Make sure nothing else runs on dev.

| Command | Does |
|---|---|
| `node tools/platform-load-stages.mjs --dry-run` | Prints runs, time and requests; sends nothing |
| `node tools/platform-load-stages.mjs --yes` | Stage 3, then stage 2, 3 runs of each size |
| `node tools/platform-load-stages.mjs --stages 2 --client2 https://yonedarepo-dev-bench2.mlong-f01.workers.dev --yes` | Stage 2, then its largest size again on 2 clients |
| `node tools/platform-load-stages.mjs --results` | Rebuilds the table below from the evidence |

Full plan, as printed by `--dry-run`: 33 runs, about 5.7 hours, about 3.6M platform requests.

| Stage | Runs | Shape |
|---|---|---|
| 3 | 3 each | 1 repository at 100/s for 30 minutes, spread across 32 top-level directories |
| 3 | 3 | The same, every write under `load/`: one search partition, so each derive job rebuilds it |
| 3 | 3 | 20 repositories at 5/s each |
| 2 | 3 each, in both arms | 20, 100, 500 and 1,000 repositories × 10 writers, no checks |

- **Arms.** `tokens` (`yrp_`) skip D1 and the account authorities. `pat` (`ypat_`) read both on every request, so only this arm says anything about them. An account holds at most 50 live PATs, so writers share 10, all in one account: it measures one account's authority, not many.
- **Repositories** are saved in `.local/platform-live/pool-*.json` and reused. Nothing deletes them. Stage 3 repositories keep growing: 3 runs add about 3 GB each (estimate from 5–6 KB per landing).
- **Credentials** are fresh each run and revoked after it. PATs also expire after a day. Paths are unique to the run.
- **Evidence** is one timestamped file per run in `.local/platform-live/`. It refuses to write if it holds a token.
- **The sustained stop** is judged per 60-second segment, so a broken run ends within about 2 minutes. Sustained load has no target of its own in the budget, so it uses the 3 s of busy repositories: stop at 9 s. `--target-p95-ms` changes it.
- **Hosts.** Every bench refuses anything but dev, from `infra/envs/dev.json`, and the bench client refuses it too.

Single runs: `tools/platform-manyrepo-bench.mjs --no-checks --principals pat` and `tools/platform-fanout-bench.mjs --workload sustained --repos 20 --layout single`. Without `--no-checks`, many-repo starts a container per repository.

### What the sampler reads

Read-only, every 15–30 s, from up to 5 repositories across the run. A source it cannot read is listed under `unreadable` in the evidence, never read as quiet.

| Figure | Source | Limit |
|---|---|---|
| Log floor, tail rows, `db_bytes`, table row estimates | `GET /repos/<id>/compaction`, owner only | Row estimates are the top rowid; deletes don't lower them |
| Object outbox, projection lag | `GET /repos/<id>` | Asks all 64 shards, so 2 repositories only |
| Queue depth, dead letters | Cloudflare GraphQL, `CF_ANALYTICS_TOKEN` | 5-minute groups, minutes late. Read them after the settle |
| Worker errors, Durable Object kills, D1 query counts and p90 | Cloudflare GraphQL | Minutes late. Queries match Cloudflare's docs; **not yet run against the live API** |

**Cannot be read:**

| Missing | Why | Use instead |
|---|---|---|
| D1 errors | Cloudflare publishes no D1 error count | `d1_errors`: bench answers naming D1, plus Worker errors |
| Bytes per table | No `dbstat` on Durable Object SQLite | Bytes per version overall, rows per version by table |

So the "real bytes per landing by table" archive needs comes only as those two figures, unless a run also takes `SUM(length(...))` per table.

## Results

<!-- results:start (tools/platform-load-stages.mjs --results) -->
None yet.
<!-- results:end -->
