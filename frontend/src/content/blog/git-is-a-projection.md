---
title: Why Git is a projection of our transaction log
date: 2026-10-28
summary: Each repository is an append-only log with compare-and-swap refs. Git objects and branch refs are derived from it, so many writers can land without a merge lock.
author: Yoneda Labs
category: Engineering
image: /blog/git-is-a-projection/hero.svg
imageAlt: Diagram of a transaction log of ref moves on the left, each entry moving main from one commit to the next by compare-and-swap, projected into Git refs and objects on the right.
caption: The log decides; Git refs and objects are projected from it, so they can lag but never disagree.
---

Git is excellent at what it was built for: people who each keep a full copy and sync now and then. Agents are different. They are always online, there can be hundreds at once, and they all want to land on `main`. YonedaRepo keeps Git fully compatible, but Git is not where decisions are made. The decision record is a **transaction log**.

## The log is the authority

Every repository has one authority with an append-only, hash-chained log. Every ref move is an entry: which branch moved, from which commit to which, the paths it touched and the reads it declared. Refs move by **compare-and-swap**: a landing names the head it expects, and the log either accepts it or reports what moved.

Because the log is ordered and versioned, any read can ask for a version: `log`, `grep`, `blame` and `diff` all take `--at`. Checkpoints keep the log compact.

## Git is derived

Commits are real Git objects with real ids. When you push, the platform verifies every object, records each commit under its own id, and only then moves the ref. Branch refs in the Git object store are **projected** after the log entry, with an expected-old lease and drift detection, so the projection can lag but never disagree.

That lag is real and we measure it. On October 27 on our dev environment, Git projection p95 was **0.58 s at 100 concurrent writers and 4.9 s at 1,000** (one run each). Right after three back-to-back bursts, a clone waited 59 s for the projection backlog. The log itself is current the moment a landing returns.

## What the log buys

- **No merge lock.** Edits to different parts of one file merge on the server. Landings on a busy branch are batched into one merge commit.
- **Stale reads are caught.** A change can declare what it read, as paths or symbols. If one of them changed meanwhile, the landing is refused instead of merged blind. With 200 concurrent writers we checked 6,441–8,001 log entries per run for write skew and found **0 serializability violations** in 3 of 3 runs.
- **History is never rewritten.** `main` cannot be force-pushed. A failed post-landing check proposes a repair commit.

## Numbers

From the same October 27 runs on dev: 1,000 of 1,000 concurrent writers landed in each of 4 runs, the latest at 406 lands/s; one repository sustained 193.7 landings/s for 60 s with 0 refused; with 20 repositories × 10 writers, commit p95 was 338–646 ms over 6 runs.

## Limits

This is not a Git replacement, and we do not claim monorepo-scale results we have not measured. Clones see a landing after the projection catches up. The log is per repository: there is no cross-repository transaction.
