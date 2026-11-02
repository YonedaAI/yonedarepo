# Load testing the platform for agents

Status: stages 2 and 3 have tools, built 2026-10-31 and tried against a stub only. Stage 6's distance bench, archive stage A's measurement and the Basin soak were built 2026-11-01, against stand-ins only. No stage has run on dev. The owner replaced their 5.7-hour plan with the one-hour [real-use simulation](#real-use-simulation). Written 2026-10-30.

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

## Repository analytics budget

`REPO_ANALYTICS` adds the repository, bytes, duration and a landing's outcome to the points we already write, and opens the repository Insights page and the admin landings and repository reports. Off by default, and it needs `TRAFFIC_EVENTS` and `TRAFFIC_REPORT` on. Written before the code. Measure on against off before either environment turns it on.

| Measure | Target |
|---|---|
| Points per request | At most 1: the request's own client point carries the new fields. A landing from a browser session has no client point, so it writes its one. With `REGION_SIGNALS` on, 1 write in 10 has a second, its own, as today |
| Points per job | 1 when a check run finishes, and 1 when the clearance job lands or fails to |
| Points written in a transaction | 0: all after the answer |
| Subrequests added to a request | 0 |
| Authority or D1 reads added to a request | 0 |
| Awaits added before the response | 0 |
| Switch off | A switch check where a note would go, and the point is byte for byte today's |
| CPU added per request, on | Under 50 µs |
| A clone's bytes | From the pack tally already kept. Nothing is added between R2 and the client: a stored pack stays piped with no JavaScript |
| A clone's point | Written when the last byte has gone, inside `waitUntil`, once. A cancelled clone still writes it |
| D1 reads per check run | 1 after it finished: an account that's ours leaves no point |
| Insights view | 1 authority read, every view, which decides access; then at most 1 SQL API statement per isolate, repository and range every 5 minutes |
| Contributors | At most the newest 5,000 commits and 5,000 changesets read |
| Admin landing report | 2 SQL API statements, read only while the Traffic page is open |
| Admin repository report | 2 SQL API statements and 1 D1 read |
| Land p95, 1,000-writer burst, on against off | At most 5% worse, 3 runs each |
| Clone time, largest stored pack, on against off | At most 1% worse, 3 runs each |
| Worker Wasm | Under 10 KB more. No new dependency |
| Failed or missing binding | No response changes |

## Operations and infrastructure report budget

`OPS_REPORT` opens the admin Operations and Infrastructure tabs. It reads, and writes nothing to any request's path. Off by default. Written before the code.

| Measure | Target |
|---|---|
| Added to any request but these pages | 0 |
| Operations view | 1 SQL API statement |
| Infrastructure view | 4 GraphQL requests, one per section so one refused query leaves the others up; held 60 seconds per isolate |
| GraphQL budget | 300 a 5 minutes for the account: Superfan spends 1 a run, so 10 views a minute is at most 40 |
| A section that fails | Says so; the others stand |
| Failed or missing binding | No response changes |

## Operator audit budget

`OPERATOR_AUDIT` splits the operator log, adds its filters and detail panel, and records failed admin attempts and staff reads. It needs D1 migration `0015`. Off by default. Written before the code.

| Measure | Target |
|---|---|
| Added to a customer's request | 0 |
| Staff opening a repository | At most 1 D1 read and 1 D1 write per operator and repository, per isolate and hour, after the answer |
| Refused admin attempt | At most 1 D1 write per caller, per isolate and 5 minutes, after the answer; at most 60 an isolate an hour, so a stranger can't fill the table |
| Failed operator action | 1 D1 write after the answer, as a successful one has today |
| Purge job | 1 D1 update when it ends |
| Log read | 1 D1 statement a page, 50 rows, as today |
| What a row can hold | No token, secret, IP address or user agent |
| A failed audit write | Logged; the answer doesn't change |

## Visitor budget

`VISITORS` adds a daily rotating, salted hash to browser pings, and opens the admin Visitors tab. It needs D1 migration `0016`. Off by default. Written before the code.

| Measure | Target |
|---|---|
| Points per ping | 1, as today. No new write |
| Added to a page request | 0: only pings carry the hash |
| Cookies, IP addresses or user agents stored | 0 |
| Salt reads | At most 1 RPC to the platform per front isolate and UTC day, or 1 a minute while it fails; 1 D1 batch per answer |
| Salt kept | Today's and yesterday's; older ones are deleted, so a past hash can't be rebuilt |
| Hash | One SHA-256 per ping, after its rate limit |
| Sign-up | One more field on one RPC, and 1 D1 update, only when it has a source |
| Visitors view | 1 SQL API statement, at most 20,000 rows, and 3 D1 statements |
| No salt to be had | The ping is written as today, with no hash: a view is never lost |
| Failed or missing binding | No response changes |

## Agent report budget

`AGENT_REPORT` counts an agent credential as an agent, adds a digest of its token id and a self-reported client name to its points, and opens the admin Agents tab. Off by default, and it needs `REPO_ANALYTICS` on, so `TRAFFIC_EVENTS` and `TRAFFIC_REPORT` too. No repository migration. Written before the code. Measure on against off before either environment turns it on.

| Measure | Target |
|---|---|
| Points per request | At most 1: the request's own client point carries the new fields. With `REGION_SIGNALS` on, 1 write in 10 has a second, its own, as today |
| An agent's reads | All of them, not 1 in 10, or a credential that only reads could go unseen. Reads by anyone else stay 1 in 10 |
| Points written in a transaction | 0: all after the answer |
| Subrequests added to a request | 0 |
| Authority or D1 reads added to a request | 0 |
| Awaits added before the response | 0 |
| Added to an authority call | A switch check, then a request-scoped note for an agent only |
| Added after the answer | One SHA-256 of the token id, for an agent only |
| What a point can hold | 16 hex of that digest and a name from a fixed list. No token, token id, agent name or user agent |
| Switch off | A switch check where a note would go, and the point is byte for byte today's |
| CPU added per request, on | Under 50 µs, plus the SHA-256 |
| Agents view | 3 SQL API statements (at most 20,000, 1,000 and 1 rows) and 1 D1 read, only while the tab is open |
| Land p95, 1,000-writer burst, on against off | At most 5% worse, 3 runs each |
| Worker Wasm | No change: TypeScript only. No new dependency |
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

## Archive stage A budget

Four switches on the platform Worker, all off today (`docs/runbook.md`, "Trimming commit data"). **They change new writes only:** nothing already stored shrinks, so the owner's repositories can't show a saving. So the same work runs on two fresh imports of a real history, one per arm, and each repository is only ever written by its own arm.

| Switch | Saves | Costs on the write path | How it is measured |
|---|---|---|---|
| `CHECK_EVIDENCE_ONCE` | One copy of each verdict's evidence, up to 16 KiB | None on the write. One subquery on a read of a run | The exact bytes the API returns. Evidence is smaller than a database page, so a size can't show it |
| `REF_CHAIN_SHARED` | Up to 5,000 `ref_chain` rows per new branch | Should be faster: the walk stops at main. One more read per path-history read | Database size, before and after 20 branches |
| `SHARD_FORGET_RECORDED` | A shard's copy of each batch-landed commit | 1 shard call per shard touched, per projection, after the answer | All 64 shards' size before and after 200 landings |
| `COMPACTION_SWEEP` | Log rows of an idle repository past its retention | 1 D1 read a minute, then per repository per day 1 queue job, 1 authority wake and, with Basin bound, 1 R2 read | Segments due, read from `GET /repos/<id>/compaction`. Nothing is due under 10,000 versions |

Written before the first run:

| Measure | Budget |
|---|---|
| Land p95, on against off | At most 5% worse, 3 runs each |
| Commit p95, on against off | At most 5% worse, 3 runs each |
| New branch p95 | No worse |
| A run's check reads | Every log still answers with the switch on |
| Worker Wasm | No change: the switches are built, and the only code added is TypeScript |
| Requests, one run | About 1,000: 2 per branch, 3 per landing, 11 per check, 66 per size read |
| Time | About 6 minutes a run, 21 an arm with its import (estimate) |
| Both arms | About 6,000 requests, 24 container check runs, under $0.25 at list price. No model |

**Source:** `expressjs/express`. It has 6,183 commits and 3,913 on main's first-parent chain (counted 2026-11-01), so a branch copies thousands of rows and doesn't stop at the 5,000-row bound. Not the owner's repositories: `--baseline` only reads those, and the tool refuses to write to anything not named `archive-measure-*`.

**The change for the on arm,** in the platform Worker's `vars` in `infra/envs/dev.json`, then `cargo xtask infra gen --env dev` and a deploy:

```json
"CHECK_EVIDENCE_ONCE": "on",
"REF_CHAIN_SHARED": "on",
"SHARD_FORGET_RECORDED": "on",
"COMPACTION_SWEEP": "on"
```

| Command | Does |
|---|---|
| `node tools/platform-archive-measure.mjs --dry-run` | Prints the plan and the change above; sends nothing |
| `node tools/platform-archive-measure.mjs --baseline` | Reads the owner's five repositories, writes nothing, about a minute |
| `node tools/platform-archive-measure.mjs --arm off --yes` | Imports once, then 3 runs. Refuses if this checkout's `dev.json` has a switch on |
| `node tools/platform-archive-measure.mjs --arm on --yes` | The same, after the deploy. Refuses unless `dev.json` has all four on. It can't see what is deployed |
| `node tools/platform-archive-measure.mjs --results` | Rebuilds the table below from the evidence |
| `node tools/platform-archive-measure.mjs --cleanup --yes` | Deletes this tool's two imports, nothing else |

## Basin soak budget

Do landings counted by Basin match the repository's log, and what does the stream cost? `tools/platform-basin-soak.mjs` reads only: Basin SQL, each repository's log and cursor, and Cloudflare's metrics. Run it once a day. Written before the first check.

| One check | Budget |
|---|---|
| Basin SQL | 1 query, then 1 or more per repository: 5,000 rows a page. 10 MB minimum each, so $0.000025 |
| Platform | 2 reads per repository, 1 more per 500 versions. Waits for no queue |
| Sign-ins | 2, both signed out at the end: a daily sign-in would otherwise evict the owner's browser |
| Cloudflare metrics | 5 GraphQL queries |
| Time | About 3 minutes for 20 repositories (estimate) |

**How a repository is compared.** The log is the authority, so every version it holds in a window must have one `land` row in the table, of the same kind and commit.

| Rule | Why |
|---|---|
| A window starts at the first version the stream sent, and after its last gap | Everything before a cursor started was given up on purpose, and a gap is logged and counted |
| A window ends at the cursor, and 15 minutes before now | Sends flush in 3 to 7 minutes |
| A version missing from the table, a row the log never held, or a wrong kind or commit fails the check | The check names the versions |
| A duplicate is counted, not failed | Sends are at least once |
| A batch's `merged` rows are held to the count on its `land` row | The log doesn't list merged commits, so this checks the stream against itself, not the log |
| A deleted repository can't be compared | It is listed under `not_compared`, with its rows, never counted as matching |
| Fewer than 100 landings compared answers `too_few`, not a pass | A quiet dev proves nothing |

**What must hold before prod binds it.** `node tools/platform-basin-soak.mjs --gates` judges the first group from the evidence.

| Gate | Bound |
|---|---|
| Days | 7 days with a passing check |
| Failed checks | None. Any drift outside a logged gap stops the soak |
| Size | 1,000 landings and 3 repositories compared in one check |
| Dropped events | 0 in `pipelinesUserErrorsAdaptiveGroups`, and 0 `decodeErrors`. A schema mismatch drops events in silence |
| Metrics | Every source read, every check |
| Cost | Under $5 a month at dev's busiest day, after what's included |
| Privacy (owner) | `privacy.md` doesn't list the stream. It holds the actor, branch name and commit id of every landing |
| Erase (owner) | **Basin SQL is read-only.** An erased repository's rows stay in the table. Either a way to remove them or the owner's word |
| Unbind on dev | Landings, compaction and reads carry on, and no hold is left |
| Stopped stream on dev | Compaction crosses a segment, the hold releases, and the gap is logged |

**Cost basis,** read 2026-11-01. Billed since 2026-08-03 and generally available since 2026-10-01 ([changelog](https://developers.cloudflare.com/changelog/product/basin/)).

| Item | Price | Included each month |
|---|---|---|
| [Stream ingress](https://developers.cloudflare.com/basin-pipelines/platform/pricing/) | Free | |
| SQL transform | $0.04/GB | 50 GB |
| Sink to Parquet or Iceberg, uncompressed | $0.06/GB | 50 GB |
| [Basin SQL](https://developers.cloudflare.com/basin-sql/platform/pricing/), compressed bytes scanned | $0.0025/GB, 10 MB minimum per query | 10 GB |
| [Catalog operations](https://developers.cloudflare.com/basin-catalog/platform/pricing/) | $9 per million | 1 million |
| Catalog compaction, only if turned on | $0.005/GB and $2 per million objects | 10 GB and 1 million |
| [R2](https://developers.cloudflare.com/r2/pricing/) | $0.015/GB-month, $4.50 per million Class A, $0.36 per million Class B | Shared with the account, so not taken off here |

Catalog operations have no metric this tool reads, so they're named as not counted. A sink rolls a file a minute on dev, so a day of steady landings writes about 1,440 files, and Basin SQL slows as files add up.

### GitHub import

Budget, bench and what is proved: [clone-import.md](clone-import.md).

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

#### Distance

Global regions stage R2. The [same-region test](global-scale-plan.md#same-region-test) timed one client at a time, so it can't say what a fleet far away sees. This runs bursts from each region on today's path, with North America as the control: the clients are far away and the data stays in `enam`.

**No new Worker.** `yonedarepo-dev-region-na`, `-eu` and `-ap` already exist, and now answer the bench client's protocol too (`bench-client.js`). Nothing is created, so nothing needs removing.

Written before the first run:

| Measure | Budget |
|---|---|
| Runs | 3 of each size from each region, 18 bursts: 100 and 1,000 writers |
| Land p95 | Under 10 s at 1,000 writers, from any region. Stop at 30 s |
| Read p95 during a burst | Under 1 s. Stop at 3 s |
| Errors | 0 outside expected conflicts. Stop above 1%, or at a Cloudflare limit error |
| Requests per burst | 4 per writer plus about 30: commit, landing, read and a token each |
| Requests, whole plan | About 45,000, about 53 minutes (estimate), under $0.10 at list price |
| Repositories | 19 made and deleted. No owner's repository is touched |
| Limiter round | 360 anonymous reads and 40 refused sign-ins, from one address, 65 s apart |
| Two regions at once | 240 reads each from Europe and Asia: 480 together against a limit of 300 |

**What it reports:**

1. **Real delay:** per request, client time less the server's own total. That leaves the road both ways and the edge, under load, as p50 and p95.
2. **Where the client ran:** each answer's `cf-ray` names the colo it entered at. Placement holds a Worker near one region until volume spreads it ("Cloudflare may run instances across a more distributed area"), so a burst that spread shows here instead of reading as distance.
3. **The limiters:** what passed and what was refused. Counts are approximate by Cloudflare's docs, so a round holds if it refused and passed between half and twice the limit.
4. **One counter or many:** a limiter counts per Cloudflare location, in the location where the Worker runs. Today every region reaches the pinned Worker, so two regions should share one counter. Regional cells lose that: see the [plan](global-scale-plan.md#r3-spikes-rechecked-2026-11-01).

**What it can't say:** the in-region path under load. One serving object answers each region there, so its concurrency says nothing about a real one.

| Command | Does |
|---|---|
| `node tools/platform-distance-bench.mjs --dry-run` | Prints the plan; sends nothing |
| `node tools/platform-distance-bench.mjs --yes` | Runs it. Nothing else may run on dev: a limiter round spends all the bench clients' one address |
| `node tools/platform-distance-bench.mjs --results` | Rebuilds the table below from the evidence |

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
- **Evidence** is one timestamped file per run in `.local/platform-live/`; stage 6, archive stage A and the Basin soak use `.local/scale-next/` at the repository root, so it outlives a worktree. It refuses to write if it holds a token.
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

### Archive stage A

<!-- archive-results:start (tools/platform-archive-measure.mjs --results) -->
None yet.
<!-- archive-results:end -->

### Distance

<!-- distance-results:start (tools/platform-distance-bench.mjs --results) -->
None yet.
<!-- distance-results:end -->
