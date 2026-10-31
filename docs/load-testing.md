# Load testing the platform for agents

Status: plan, not run. Written 2026-10-30.

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

## Stages

Stop a stage at the first of: errors above 1%, p95 over 3× its target, or a Cloudflare limit error. Record what broke.

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

## Build first

- Add `--writers` values above 1,000 and a repository-count flag to the kit, with stop rules.
- The bench client is one Worker. Confirm it is not itself the limit at 10,000 writers (compare against 2 clients).
- A results table in this file, updated per run: date, commit, size, min, median, max, errors, what broke.

## Results

None yet.
