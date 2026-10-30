---
title: Research at YonedaRepo: five papers behind the platform
date: 2026-10-30
author: Yoneda Labs
category: Research
summary: YonedaRepo rests on a research series, Source Code as a Transactional Abstraction. Here is what each of its five papers covers, and the post that explains each one.
image: /blog/research-at-yonedarepo/cover.webp
imageAlt: Cover card of the research series Source Code as a Transactional Abstraction, by Matthew Long.
caption: The series Source Code as a Transactional Abstraction, by Matthew Long (YonedaAI).
---

YonedaRepo makes a bet: when many agents write to one repository, source control has to behave like a database. A change is a transaction with a read set and a write set, landing is a commit under optimistic concurrency, and Git is a view of a transaction log. We wrote that bet down as a research series, **Source Code as a Transactional Abstraction**, by Matthew Long. Every paper is public, with its proofs, its measurements and the limits it found.

The papers are long and formal. The posts below explain each one in plain terms: the problem, the idea, how the platform uses it, and what was measured or proved.

## The series

1. **[Repositories are becoming databases](/blog/source-code-as-a-transactional-abstraction)**, the overview. Data lakes moved from directories of files to transactional tables; the overview argues source control is making the same move, and shows how the parts compose.
2. **[What a repository looks like when you run it like a database](/blog/a-transaction-log-for-source-control)**, Part I. The transaction model: an append-only log, compare-and-swap refs, server-side commits, and validation of declared reads.
3. **[When is a cached index still correct?](/blog/partitioned-derived-data)**, Part II. Search indexes, symbols, blame and Git itself as views of the log, rebuilt only for the partitions a change touched.
4. **[What serverless Git costs, measured on Cloudflare](/blog/serverless-git-on-cloud-primitives)**, Part III. The architecture on cloud primitives, with Cloudflare as the reference realization, and where its serialized authority saturates.
5. **[Proving that a batch of landings is serial, in Lean](/blog/machine-checked-batch-landing)**, Part IV. A machine-checked Lean 4 development of 180 theorems: an accepted batch, merges included, gives the same result as landing its changes one at a time.

## How to read it

Start with the overview for the argument, then Part I for the model the rest builds on. Parts II and III can be read in either order. Part IV is the formal check of Part I's core; its theorems are about the model, not about our code, and the post says where that line falls.

The measurements in Parts I to III come from named revisions of the platform, with run counts and the caveats the papers state. Where a paper reports a defect it found in our code, the post reports it too.

## Where it lives

The papers, PDFs and Lean source are on the [research site](https://yonedarepo-research.vercel.app/) and in the [yonedarepo-research repository](https://github.com/YonedaAI/yonedarepo-research).
