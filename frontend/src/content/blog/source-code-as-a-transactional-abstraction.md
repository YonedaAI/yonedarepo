---
title: Repositories are becoming databases
date: 2026-10-20
author: Matthew Long
category: Research
order: 0
summary: Data lakes moved from directories of files to tables with a transaction log. This series argues source control is making the same move, and shows what each part contributes.
image: /blog/source-code-as-a-transactional-abstraction/cover.webp
imageAlt: Cover card of the paper Source Code as a Transactional Abstraction, the overview of the series, by Matthew Long.
caption: The overview paper of the series, by Matthew Long (YonedaAI).
paper: https://yonedarepo-research.vercel.app/papers/synthesis/
---

A data lake used to be a directory of files on an object store. That works until two writers touch one table at once, or a job needs to name the exact state it read: a directory has no atomic unit bigger than one file. The field moved to **tables with a transaction log**. Delta Lake and Iceberg give every table a serial history of versions, replayable snapshots and optimistic commits.

This series argues that source control is making the same move. The overview paper states what its parts prove together.

## Why many agents on one branch hurts

Git has immutable, content-addressed objects but no transaction around a change. A push's atomic step is a compare-and-swap on a ref: the server moves `main` only if it still points where the client expected. Everything before it happens on the client, and when the swap fails all of it is stale: fetch, rebuild, retest, retry, even if the competing change touched unrelated files.

A person pays that cost now and then. Agents pay it constantly: they are always online, write a few files against a head that moves while they work, and many target the same branch. The paper cites Anthropic's report that its merge rate grew from about 2,500 code changes per day in May 2026 to more than 30,000 per day by September, and that source control became its largest development bottleneck. That is one company's report, used as motivation, not a measurement of this work.

## The idea

Treat the repository as a database:

- the repository is a map from refs to immutable objects;
- a change is a transaction with a **read set** (what it depended on) and a **write set** (what it touched);
- landing a change is a commit under optimistic concurrency;
- a version is a snapshot;
- everything computed from the source, from a search index to the Git commits of a branch, is a **view** of the log.

The architecture needs six primitives, including an object store and a serialized authority per repository. The proofs use one platform property: the authority runs commands one at a time, each all-or-nothing, with no network I/O inside.

The analogy breaks in three places. Repository state is a ref map, not a set of files. Two writers of one file can both succeed through a three-way merge, which tables have no counterpart for. And read sets are declared by the writer rather than observed by an engine, so serializability holds **relative to what was declared**.

## What each part contributes

![A layered diagram with primitives at the bottom feeding Part I (the transaction log), which feeds Part II (views and the Git projection) and Part III (capacity), and both feed a composition box at the top.](/blog/source-code-as-a-transactional-abstraction/figure-1.webp "How the parts compose (Figure 1 of the paper). Each arrow names the result one layer supplies to the next.")

- **[Part I](/blog/a-transaction-log-for-source-control): the transaction log.** A hash-chained log of ref changes, snapshots and checkpoints, validation of declared reads and writes, and a serializability theorem. It also found where group landing fell short: two batch members that each read what the other wrote could land together (write skew). A pairwise check removes it.
- **[Part II](/blog/partitioned-derived-data): derived data as views.** Search indexes, symbol tables and check results are partitioned jobs over immutable snapshots. A view is consistent at a snapshot when the key of each stored result determines that result. The Git commit of a branch is one of these views: a deterministic function of the log prefix.
- **[Part III](/blog/serverless-git-on-cloud-primitives): the system on cloud primitives.** It builds the design on Cloudflare, measures it, and models where the serialized authority saturates.

The composed result is one no single part states. Every guarantee in Part I is written over log entries rather than Git objects, and Part II shows Git is a view of the log, so **Git objects can leave the landing path** without weakening any guarantee. The authority's work per landing shrinks to a validation query and an append, and Part III's capacity model says a branch is limited by one serial call per batch, not one per landing.

## How YonedaRepo uses it

YonedaRepo is the reference implementation, first-party work that is still being built. In the measured revision (`fef94e7`), every waiting landing on a branch goes to the authority in one call of up to 256 landings. Path-disjoint landings are appended as changesets, landings on the same files go to the merge path, and a member whose reads or writes meet an earlier member's writes is deferred. Commits are recorded in 64 commit shards, reads of `main` come from a published head, and Git commits are projected from the log afterwards.

## What was measured

All measurements come from one isolated Cloudflare deployment with a synthetic workload: each writer commits one new file on `main` and lands it, with no conflicting writes and no declared reads. Landing p95 is client-side, over successful requests.

| Revision | Landing path | Writers | Landing p95 (s) | Landed |
| --- | --- | --- | --- | --- |
| dd6c9a8 | Polling, Git built | 1,000 | 104.0 | 4 of 1,000 |
| dd6c9a8 | Combiner, Git built | 1,000 | 64.8 | 385 of 1,000 |
| dd6c9a8 | Changesets | 1,000 | 18.7 | 1,000 of 1,000 |
| fef94e7 | Batched changesets, one token per writer | 1,000 | 1.21 to 1.87 | 1,000 of 1,000 in 3 runs |
| fef94e7 | Batched changesets, one shared login | 1,000 | 2.17 to 3.03 | 1,000 of 1,000 in 3 runs |

The `dd6c9a8` rows are a controlled comparison on one deploy and one client. **The two modes that built Git trees during landing landed 4 and 385 of 1,000; appending changesets landed all 1,000.** The comparison varies the whole landing path, so it does not isolate the cost of building Git objects.

On `fef94e7`, all six 1,000-writer runs landed every writer with nothing refused as overloaded, and all 1,000 reads returned correct content. On an earlier revision that served reads from the authority, 540 of 1,000 reads succeeded and 460 were refused. Main's Git commit trailed the log by 3.2 to 5.4 s at p95. Commit p95 was under 1 s in two of the three one-token runs and missed 1 s in all three shared-login runs.

## Limits the paper states

- **No sustained landing rate has been measured.** Burst-span rates of 235 to 491 landings per second are averages over bursts of 2.7 to 4.3 s.
- **The write-skew check has never run on a workload that could trigger it**, because every writer writes its own file and declares no reads.
- Views are consistent at a snapshot, not fresh. No bound on the Git delay is proved.
- The implemented search view breaks key sufficiency, so renamed or duplicated directories can return wrong paths. Part II proves two repairs.
- Serializability holds per ref, with no atomicity across refs or repositories.
- The model was tied to the code by reading it at pinned commits, not by mechanized verification. [Part IV](/blog/machine-checked-batch-landing) later machine-checks the core of Part I's model in Lean 4; its theorems also concern the model, not the code.

## Read the paper

- [Source Code as a Transactional Abstraction](https://yonedarepo-research.vercel.app/papers/synthesis/) ([PDF](https://yonedarepo-research.vercel.app/papers/synthesis.pdf))
- [Part I: a transaction log for source control](/blog/a-transaction-log-for-source-control)
- [Part II: partitioned derived data](/blog/partitioned-derived-data)
- [Part III: serverless Git on cloud primitives](/blog/serverless-git-on-cloud-primitives)
- [Part IV: machine-checked batch landing](/blog/machine-checked-batch-landing)
