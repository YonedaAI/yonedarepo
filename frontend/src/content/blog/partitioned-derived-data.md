---
title: When is a cached index still correct?
date: 2026-10-20
author: Matthew Long
category: Research
order: 2
summary: Search indexes and blame are views of a commit. Reusing them is correct exactly when the storage key determines the result. Our search key did not, and the proof found the bug.
image: /blog/partitioned-derived-data/figure-1.webp
imageAlt: Diagram of two commits, c0 and its child c1, each split into three partitions (src/, docs/ and root files) with arrows to stored segment keys, showing that c1 reuses two keys from c0 and builds one new key for its changed docs/ directory.
caption: Partition reuse in the test repository. The child commit changes only docs/, so two of its three segments are already stored and one map task runs.
paper: https://yonedarepo-research.vercel.app/papers/partitioned-derived-data/
---

A repository holds the commits, trees and files that people and agents write, and everything computed from them: the trigram index behind code search, the symbols in each file, blame, path history, check results. The paper calls the computed part **derived data**.

With one human committer you can recompute most of it on demand. With many agents landing on one branch you cannot: every landing moves the head, so indexes must be maintained incrementally, reusing earlier results and recomputing only what changed.

A wrong reuse fails quietly. It gives you a search hit at a path that does not exist, or a codemod that skips a file, and nothing in the response reports an error.

## The idea

The paper models each piece of derived data as a **view** of a snapshot, built by a partitioned job in the style of Spark. A job takes a commit and splits its tree into partitions. A map task builds one segment per partition, the segment is stored under a key, and a reduce combines the segments into the answer.

The central result is one condition, which the paper calls **key sufficiency**: if two partitions have the same key, the map function must give them the same segment. In other words, the key has to determine the result.

When the key is sufficient (and the map function is deterministic and the store only returns values written to it), the paper proves that the incrementally maintained view **equals full recomputation, under any interleaving of jobs**. Duplicate or delayed jobs cannot corrupt the store, since they write the same value. The work per commit is then bounded by the changed partitions: one lookup per partition, and a map task only for partitions whose key is new.

The converse holds too: with an insufficient key, two evaluations suffice to return a wrong segment.

Keying by content also reuses strictly more than deriving each commit's value from its parent's. A revert, cherry-pick, rebase or fork produces subtrees already indexed somewhere; parent recursion recomputes them, content addressing does not. This works only for views that depend on the tree alone. For blame and path history, which depend on history, the paper shows the commit id is a sufficient key.

## How YonedaRepo uses it

YonedaRepo partitions a commit's root tree by top-level directory, plus one partition for the files in the root. Each directory's search segment is stored under the directory's Git tree id, a hash of its contents, so an unchanged directory finds its segment already built.

A landing enqueues a derivation message naming the ref, and a query that finds a segment missing builds it on demand. Because messages name the ref rather than the commit, a burst of landings coalesces: later messages find their segments already built. Key sufficiency is what makes that safe.

The test for this, from the figure above, uses a repository with `src/`, `docs/` and root files:

| Query | Segments built |
| --- | --- |
| First search | 3 |
| Search after a landing that changes only `docs/guide.md` | 1 |
| Search pinned at log version 1 | 0 |

The test also checks that the results are correct, which a count alone cannot show.

## The bug the theorem found

A tree id says what is in a directory. It says nothing about where the directory sits. At the commit the paper studies (`cfa4845`), the search segment recorded each file's **full path**, prefix included, while its key was the **bare subtree id**. So the key was not sufficient.

Rename `src/` to `lib/` without changing any file, and queries at the new commit reuse the `src/` segment and report hits under `src/...` paths that do not exist there. Grant filtering used the stored paths, so a caller allowed to read `src/` but not `lib/` could receive matches from files that existed only under `lib/`. Two identical top-level directories, such as two vendored copies of one library, shared one segment, so matches were reported twice under one prefix. A codemod after the rename would fail with `CONFLICT` on every retry.

A test written against the Rust crates at `cfa4845` confirmed the core of it: equal keys, different segments. The effects on search responses and codemods were traced by reading the TypeScript adapter, not run.

The paper proves two repairs correct. One puts the directory name into the key. The better one keeps the subtree id as the key, stores paths **relative to the partition root**, and has the reader prepend the prefix. That keeps reuse across renames, vendored copies and forks. The relative-path repair has since landed in the codebase: segments now hold relative paths under a new key namespace, and a regression test checks the rename and duplicate cases. [Search v4](/blog/search-v4) later changed how large directories are indexed.

## Write jobs need declared reads

A codemod is a write job: map each partition to file edits, reduce them into one atomic commit, and land it through the log. A codemod that declares no read set admits **write skew**: if another landing adds an occurrence of the find string after the codemod's base, the codemod still lands and the new occurrence survives.

The paper proves that a codemod confined to one directory is serializable if it declares that directory as a read, which covers paths added later. At `cfa4845` the codemod declared no read set, so this result describes a proposed extension. A repository-wide codemod cannot be protected this way. It is serializable only if it lands as a fast-forward.

## What was measured

Correctness rests on proofs and tests. Cost evidence is thin, and the paper says so. Indexing throughput, segment sizes, per-partition lookup cost, the fraction of partitions that change on real repositories and codemod duration were **not measured**.

The one measured cost of derived data on the write path is the commit-time derivation phase (review classes and symbol writes). In two hosted runs of an instrumented branch build with one client, its p95 in a 100-writer burst was **335 ms in one run and 367 ms in another**.

## Limits the paper states

These describe the code at `cfa4845`.

- The theorem assumes deterministic map functions, one writer per key namespace and a store that returns only values written to it. These were checked by reading code, not mechanically.
- The tests show the counts behave as predicted on a three-partition repository. They do not show that partition reuse saves time on a repository of realistic size.
- Partition size is fixed by layout: code under one top-level directory is one partition, re-indexed on every commit. The paper's cost model for the best size has unmeasured parameters.
- Every partition of a job runs in one Worker invocation, so the Spark analogy holds for the data model and recovery, not yet for fan-out.
- Blame and path history are recomputed per query, and renames are detected only when content is unchanged.

## Read the paper

The full paper, with proofs and the plan DAG for agent work, is at [Partitioned Derived Data](https://yonedarepo-research.vercel.app/papers/partitioned-derived-data/) ([PDF](https://yonedarepo-research.vercel.app/papers/partitioned-derived-data.pdf)).

Other parts of the series: [Overview](/blog/source-code-as-a-transactional-abstraction), [Part I](/blog/a-transaction-log-for-source-control), [Part III](/blog/serverless-git-on-cloud-primitives), [Part IV](/blog/machine-checked-batch-landing).
