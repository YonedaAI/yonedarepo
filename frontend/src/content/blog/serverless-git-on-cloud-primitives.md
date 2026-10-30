---
title: What serverless Git costs, measured on Cloudflare
date: 2026-10-20
author: Matthew Long
category: Research
order: 3
summary: Part III maps the transaction log onto cloud primitives and measures it on Cloudflare. Batched landing landed all 1,000 writers in each of six bursts, with no refused commit, landing or read.
image: /blog/serverless-git-on-cloud-primitives/hero.svg
imageAlt: Diagram of Workers request handlers sending each repository's commits and landings to one serialized authority, with an object store, a durable queue, container checks and a Git projection around it.
caption: A diagram of the architecture described in the paper, showing its primitives and the Cloudflare product that realizes each.
paper: https://yonedarepo-research.vercel.app/papers/serverless-git-on-cloudflare/
---

Part I of this series treats a repository as a transaction log: an agent commits a change, then lands it on a branch by compare-and-swap against the version it read. Neither Part I nor Part II says what that costs once deployed. Part III asks: **what does the transaction system cost on cloud primitives, and where does its serialized part saturate?**

## The problem

An agent writes a small change against a head that moves while it works, and many agents want the same branch at the same moment. The paper cites Anthropic's account of its Scion system, where merges per day grew from about 2,500 in May 2026 to more than 30,000 in September 2026.

Every landing on a branch passes through something that serializes it. If that step is slow, or does too much work per landing, the whole fleet queues behind it.

## Six primitives, one job each

The architecture is written against contracts, not products. The paper names six primitives and maps each onto one Cloudflare product (Table 1):

| Primitive | Contract | Cloudflare realization |
|---|---|---|
| Object store | Immutable, content-addressed puts and gets | R2, and Artifacts for Git objects |
| Serialized authority | Durable state per key, with linearizable compare-and-set on refs and log append | One Durable Object with SQLite per repository |
| Durable queue | At-least-once delivery with retries | Queues and Workflows |
| Stateless compute | Request handlers and map tasks | Workers |
| Container compute | Checks and heavy builds | Containers |
| Git projection | Serves the Git protocol from the log, optionally | Artifacts |

Table 1 also names another documented product per contract (S3, a Spanner row, SQS, Lambda, Fargate) but makes no performance claim about them. Every measurement comes from Cloudflare.

The primitive that decides capacity is the authority. Each repository has exactly one `SourceRepository` Durable Object holding the log, refs, checkpoints, landing queue and lease in its SQLite database. A ref's compare-and-swap, its log entry and the landing record are **one SQLite transaction**. The price is that the authority is a serial resource for the whole repository: two branches of one repository queue behind each other, while two repositories never interact.

## How YonedaRepo uses it

YonedaRepo is the reference realization. Requests run in Workers and the authority holds the log. Commits are recorded in commit-shard Durable Objects chosen by commit id (16 shards, 64 from revision `fef94e7`). Derive jobs, ref projection and check dispatch go through the queue. Checks run in Containers, starting from a warm-start seed in R2 near a branch head. In later revisions R2 is the store of record and Artifacts receives only protected-ref projections.

In the early revisions every commit was pushed to Artifacts and read back before acknowledgment. The first hosted test with 100 concurrent commits failed 91 of them with `ERR artifacts_git_receive_pack_busy`, because Artifacts accepts one receive-pack per repository at a time (observed, not documented). A push queue that combines pushes fixed the failures but kept the serialization.

## What was measured

**Landings that build Git trees and merge commits on the landing path failed under a 1,000-writer burst. Landings that append changesets to the log in batches and build Git objects afterwards did not.**

Rows from the paper's Table 2 follow. Latencies are client-side p95 in milliseconds over successful requests, from a client Worker in AWS us-east-1, with 1,000 writers on one repository each committing one new file and landing it. S4 to S6 come from one deploy and differ only in landing mode. B1 to B6 are the batched redesign on one deploy of `fef94e7`; the Landed column is from sections 5.3 and 5.4.

| Run | Landing mode | Landed of 1,000 | Commit p95 (ms) | Landing p95 (ms) |
|---|---|---|---|---|
| S4 | polling | 4 | 2,221 | 104,034 |
| S5 | combiner | 385 | 2,704 | 64,756 |
| S6 | changeset | 1,000 | 1,698 | 18,728 |
| B1 to B3 | batch, one token per writer | 1,000 | 714 to 1,673 | 1,212 to 1,865 |
| B4 to B6 | batch, one shared login | 1,000 | 1,140 to 1,614 | 2,167 to 3,027 |

On S4 the authority refused 994 landings as overloaded. On S5, 615 timed out. Batch mode submits every waiting landing on a branch to the authority in one call of up to 256 landings. In all six B runs no commit, landing or read was refused, and all 1,000 reads returned the correct content. Over each burst, the runs landed 404 to 491 changes per second with separate tokens and 235 to 284 with one login.

In the early revisions commit p95 was between 2.8 s and 3.7 s across four 100-writer runs, against a 1 s target. Per-phase timings (Table 3) showed why: an unloaded commit spent about 55 percent of its time waiting for R2 and about a third in ten authority round trips of roughly 50 ms each. Later revisions took the R2 write and the Artifacts push off the acknowledged path, and commit p95 was under 1 s in 28 of 39 runs, with a weaker meaning of "accepted": durable in a Durable Object, not yet in R2 or Artifacts.

## A model that called the failure

The paper builds a closed queueing model over each primitive's service time (authority per-call cost estimated at 1.51 ms). It reproduced each early 100-writer commit p95 within its pre-set 25 percent gate, with errors between −17.8 and −0.4 percent. It projected that landings which poll the authority fail first. They did, though as refusals rather than an unbounded queue, because a Durable Object bounds its queue. For batched landing, the measured batch call (308 ms median, 372 ms p95) bounds one branch at about 690 to 830 landings per second, and the measured burst rates sit below that bound.

## Limits the paper states

- **No sustained run exists.** The landing rates are averages over bursts of a few seconds (2.7 s and 4.3 s end to end where recorded).
- Main's Git commit arrived 3.2 to 5.4 s after landing at p95 at 1,000 writers.
- Reads succeeded because they came from a cached published head. On an earlier revision with reads served by the authority, 540 of 1,000 were correct and 460 were refused as overloaded.
- With one shared login, commit p95 missed 1 s in all three runs.
- Each writer writes its own file and declares no reads, so the within-batch write-skew check was never exercised.
- The evidence comes from one account, two clients and few runs per revision. Artifacts is in beta, and the R2 key behind 7 failed commits in one 100-writer run is unidentified.
- The authority's SQLite database is limited to 10 GB and the log has no compaction yet.
- The paper makes no claim that its runs are comparable with Scion's operation.

## Read the paper

The full paper, with every table, is on the [paper page](https://yonedarepo-research.vercel.app/papers/serverless-git-on-cloudflare/) and as a [PDF](https://yonedarepo-research.vercel.app/papers/serverless-git-on-cloudflare.pdf).

The rest of the series: [Overview](/blog/source-code-as-a-transactional-abstraction), [Part I](/blog/a-transaction-log-for-source-control), [Part II](/blog/partitioned-derived-data) and [Part IV](/blog/machine-checked-batch-landing).
