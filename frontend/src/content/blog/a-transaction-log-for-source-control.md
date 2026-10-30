---
title: What a repository looks like when you run it like a database
date: 2026-10-20
author: Matthew Long
category: Research
order: 1
summary: Part I treats a repository as a database with a transaction log. Commits are built on the server, landing is validated against the log, and lost races stop costing a rebase.
image: /blog/a-transaction-log-for-source-control/cover.webp
imageAlt: Cover card of the paper A Transaction Log for Source Control, Part I of the series Source Code as a Transactional Abstraction, by Matthew Long.
caption: Part I of Source Code as a Transactional Abstraction, by Matthew Long (YonedaAI).
paper: https://yonedarepo-research.vercel.app/papers/transaction-log-source-control/
---

Git coordinates at one place: the ref. A push says "move `main` from commit A to commit B", and the server checks that `main` still points at A. Everything before that check happens on the client: building the commit, working out which objects the server lacks, packing them. If someone else landed first, all of that work is stale. The client fetches, rebases, reruns its checks and tries again.

For a person that loop is a small tax. For a hundred agents writing a few files each against the same branch, **the loop becomes the system**. The chance of losing grows with the rate at which others land, and the cost is paid in full even when the competing change touched unrelated files. Part I of the series gives the transaction model that removes that loop.

## The idea: a repository is a database

Data lakes hit the same wall first and moved from files to tables with a transaction log, snapshots and optimistic concurrency. The paper treats a repository the way Delta Lake treats a table. Git objects are the immutable data files. An append-only, hash-chained log records every ref change, with checkpoints so any version can be rebuilt cheaply. Readers pin a version; writers validate against what landed since they read.

The analogy breaks in two useful places. A repository's snapshot is a map of refs, not a set of files. And two writers that edit the same file can often both succeed through a three-way merge, which tables have no answer for.

The log, the refs and validation live in a **serialized authority per repository** that runs each command atomically, next to a content-addressed object store, a durable queue and stateless compute.

## Creating a commit is not landing it

![Diagram of the write path, where a writer sends changes to a stateless adapter, which pushes objects to a content-addressed object store, calls stateless compute for merges, and makes separate prepare, record and land calls to a serialized authority, one per repository.](/blog/a-transaction-log-for-source-control/figure-1.webp "Figure 1 of the paper. Creating a commit and landing it are separate calls, and only the land call touches refs.")

The key separation is in the figure above. A writer sends file changes, a parent, a base log version and an optional declared read set. The server builds the commit, rewriting only the directories on changed paths, pushes the objects, reads them back and records it. None of those steps moves a ref.

Landing is a separate call. Inside one atomic command, the authority compares the change with every log entry written to that branch since its base, then either refuses or appends one log entry and moves the ref. Validation has four outcomes:

1. **Conflict**: something the change declared it read was written after its base.
2. **FastForward**: nothing landed since the base.
3. **Rebase**: things landed, but none of them wrote paths this change wrote.
4. **Merge**: writes overlap, so the platform runs a three-way merge on the shared files.

No network I/O happens inside that command. That is what makes the append and the ref move one step.

## How YonedaRepo uses it

YonedaRepo is the reference implementation. The authority is a Durable Object, which runs one request at a time with all-or-nothing SQLite transactions. Every commit has a real Git id that stock Git can verify.

You see the model directly in the product. Reads take a log version, as in `yoneda log src/retry.ts --at 180`. A session can declare what it read with `yoneda reads add src/retry.ts`, and landing refuses the push if any of those files changed on `main` meanwhile. Refs never move backward: undoing a landed change is a new revert commit.

When many writers hit one branch, a **land combiner** takes up to 64 queued landings under a lease with a 30-second expiry and lands them as one merge entry. The paper proves correctness rests on checks inside the appending command, not on the lease, so a request that dies holding it can do no harm.

## What the paper proves

Under the single assumption that the authority's commands behave as if run one at a time, each all-or-nothing:

- **Replay is deterministic.** Replaying the log from a valid checkpoint (one is written every 64 versions) always yields the same refs.
- **Snapshots are immutable.** A read pinned at a version is a pure function of that version and takes no lock.
- **Refs only advance** along first-parent chains, so no landed commit is ever lost or overwritten.
- **Landings are serializable relative to declared reads**, for histories whose landings needed no line-level merge. Merged landings get a weaker, described guarantee.

One result connects to the companion paper on scheduling. Its independence condition (neither change writes what the other reads or writes) is **exactly** the condition under which two changes land without merging in either order. So it is the right rule for deciding what to run in parallel, and the wrong rule for deciding what to accept.

## What was measured

The paper calls these correctness evidence first, all from the Cloudflare reference implementation (Table 4):

| Quantity | Result | Setting |
| --- | --- | --- |
| Concurrent landings without loss | 100 of 100 writers committed and landed on one branch of a 100-file repository | Local, reported in a commit message |
| Three-way merge against Git | Agreement with `git merge-file` on 300 of 300 random merges of 20-line files | Unit test |
| Commit cost and repository size | One-file commit p50 about 13 ms at 100 files and about 14 ms at 10,000 files | Local, 30 edits each |
| Commit cost and repository size | One-file commit p50 1,725 ms at 100 files and 1,627 ms at 3,000 files | Hosted run 1, 20 edits each |

On the changeset landing path, **1,000 of 1,000 concurrent writers landed in each of six hosted bursts**. A sustained landing rate is not measured in this paper.

The earlier tree-building landing missed its design target: commit p95 was between 2.8 s and 3.7 s against a 1 s target across four hosted runs with 100 writers, and at 1,000 writers the authority refused 980 of 1,000 landings as overloaded with polling. Changeset landing is the response to those numbers, and Part III measures it.

## Limits the paper states

- **Serializability is only as good as the declared reads.** An agent that reads more than it declares can produce write skew, and the paper gives the example.
- **Batches had a gap.** A combiner that validates each member only against the log lets two members of one batch skew against each other. The paper proves this by counterexample and gives the pairwise check that removes it. The check is now in the code, but no workload that could exhibit write skew has tested it.
- **Checkpoints are trusted on their digest alone**, so an altered ref map with a correct digest is not caught. That gap is open.
- The model was tied to the code by reading it at one commit, not by mechanized verification.
- One authority per repository bounds throughput per repository.
- The performance evidence is thin: one client machine, with large run-to-run variation.

## Read the paper

The full paper, with all proofs, is on the [paper page](https://yonedarepo-research.vercel.app/papers/transaction-log-source-control/) and as a [PDF](https://yonedarepo-research.vercel.app/papers/transaction-log-source-control.pdf).

The rest of the series: [Overview](/blog/source-code-as-a-transactional-abstraction), [Part II](/blog/partitioned-derived-data) on derived data as views of the log, [Part III](/blog/serverless-git-on-cloud-primitives) on serverless Git on cloud primitives, and [Part IV](/blog/machine-checked-batch-landing) on machine-checked batch landing.
