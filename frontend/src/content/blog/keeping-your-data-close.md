---
title: Keeping your data close
date: 2026-10-31
summary: A same-region test on dev. Reads from Asia fell from 275 ms to 15 ms, search got slower, and Asia can only be best effort. What we measured and what still left the region.
author: Yoneda Labs
category: Engineering
order: 6
---

Your data on YonedaRepo is processed in the United States today, so a request from Europe or Asia crosses an ocean before it's answered. The rule we've set for fixing that is simple to say: data stays on its continent, and a request from Europe is served in Europe.

Regions aren't built. This post reports a test on our dev environment, run to find out what that rule would buy before we build it.

## The test

We ran the platform's real routes in a chosen region, with new repositories and accounts started there, and compared that with today's path. Code, repository data and accounts ran in Amsterdam for Europe and Singapore for Asia, in all 3 runs. File storage, the shared database and the queues stayed in the US on purpose, so we could count what still left. Test clients sat in Frankfurt and Singapore, and there were 0 failures.

These are medians in milliseconds at the client, and a real person adds their own last mile. Each cell shows today's path, then in region.

| Operation | Europe | Asia |
|---|---|---|
| Read, repository token | 162 → 22 | 275 → 15 |
| List | 144 → 11 | 256 → 4 |
| Commit | 224 → 51 | 342 → 41 |
| Land | 205 → 53 | 382 → 33 |
| Sign-in | 244 → 123 | 398 → 76 |
| Read, personal token | 178 → 123 | 295 → 257 |
| Push | 444 → 251 | 763 → 426 |
| Search | 496 → 566 | 670 → 1,142 |
| Create a repository | 2,439 → 2,959 | 2,361 → 3,814 |

For scale, North America today reads in 41, lists in 10, commits in 90 and lands in 113.

## What got worse, and why

Search and repository creation got slower because they lean on what stayed behind, and the code now sits further from it. A read with a personal token gained little for the same reason: the shared database took 96 of those 123 ms in Europe and 238 of the 257 ms in Asia. Repository tokens skip that lookup.

Clone isn't in the table because the result isn't a regional one. It got slower even in North America, where nothing moved, and we haven't traced why.

File storage is the largest piece left. One read from the US bucket took 140 ms from Europe and 277 ms from Asia, against 33 and 102 ms from a bucket made in that region. Read replicas of the shared database answered in 18 and 48 ms, but only 13 of 20 reads reached one. The other 7 went to the US. Background work crossed the ocean in both paths.

## Asia is best effort

Europe could have a guarantee, because our hosting platform supports an EU jurisdiction. Nothing like that exists for Asia. There we can only ask for a location with a hint. The hints landed in Singapore in all 3 runs, but a hint isn't a promise. Queues and our Git object store have no Asian placement at all, so background work there needs another way to run, and that path hasn't been tried on dev.

## What's next

The order is to move code, repository data and accounts together, then file storage, then the shared database. Existing repositories stay in the US until a copy tool exists, because this storage can't move after it's created. Until then, [our docs](/docs/guides/global) describe what's true: your data is processed in the United States.
