---
title: Search v4: a chunked index read in place
date: 2026-10-28
summary: Search stopped skipping whole directories, and its index got 2.2–2.7× smaller. Then we shipped a bug that broke every search, and fixed it the same day.
author: Yoneda Labs
category: Engineering
image: /blog/search-v4/hero.svg
imageAlt: Diagram of one search segment: a list of files, a sorted trigram table with offsets, and delta-encoded postings, with one trigram's postings highlighted.
caption: A Search v4 segment: a sorted trigram table points into compact postings, so a query decodes only what it needs.
---

Code search on YonedaRepo runs on the server, next to the repository. Each directory of a repository gets its own trigram index (a "segment"), rebuilt only when files under it change. On October 28 we changed how those segments are built and stored. This post covers what was wrong, what we changed, and the regression we caused along the way.

## Problem 1: a big file hid a whole directory

Each directory's index had an 8 MiB budget. On our dev environment, an imported open-source repository showed **"Not searched (too large): /"**: an 11 MB GIF at its root pushed the root directory over budget, so its README, changelog and every other top-level file could not be searched.

The fix indexes a directory in **chunks** of at most 8 MiB or 500 files. A chunk that turns out larger than the budget is halved; a single file over the budget is listed, unread. The per-file cap went from 1 MiB to 4 MiB, because a real 1.1 MB changelog deserved to be searchable. A search answer now names the files it did not search (up to 50) and why: "larger than 4 MiB" or "binary".

## Problem 2: the index was as big as the code

A segment was stored as JSON: for each trigram, an array of decimal file numbers. That made it roughly the size of the content it indexed. Worse, every search fetched each segment, parsed all of it in the Worker, serialized it again to hand to Rust, and Rust parsed it once more, all to look up the query's few trigrams. On a live repository that was **11 segment reads and 2.7 s of a 2–3 s warm search**.

Search v4 stores each segment as:

- the list of files it covers,
- a sorted trigram table with an offset into the postings for each trigram,
- delta-encoded varint postings.

Rust binary-searches the table and decodes only the postings the query needs. Segments are **2.2–2.7× smaller** for source trees. Every length and index is bounds-checked, so a damaged segment is an error, never a wrong answer. Each repository rebuilt its indexes once, on its next landing or first search.

## The regression

Since v4, the Worker sends a stored segment to Rust as base64. Rust read that field with the helper meant for short text fields, which refuses anything over 16 KiB, and any real segment is larger. **Every live search answered 400 "Missing or invalid segment_b64".**

We reproduced it first: a Rust test of the exact operation the Worker calls, and a Workers runtime test searching 300 distinct files. Both failed with the live error. Base64 payload fields now go through their own reader, and a symbol-edit field with the same cap was fixed with it. Both tests pass.

## What we have not measured yet

The 2.7 s figure is from before v4. We have not yet recorded warm search latency after it, so we make no speed claim here. When we measure it, we will publish the numbers with their run count.
