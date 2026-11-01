---
title: A thousand writers on one branch
date: 2026-10-31
summary: 1,000 writers landed on one branch at once, all on the first try. How the server does it, what we measured on dev and what we haven't.
author: Yoneda Labs
category: Engineering
order: 5
---

Point 1,000 clients at one branch of a plain Git server and have each push one commit at the same moment. We tried it with stock Git 2.54, and exactly one push was accepted in every run. Git takes the push that arrives first and rejects the rest, so 999 writers have to fetch, rebase and push again.

On YonedaRepo, all 1,000 land on the first try.

## How it works

Git decides at the ref, after the client has already built its commit and packed its objects. A writer that loses the race has wasted that work.

We moved the decision to the server. Each repository has one ordered log, and every branch move is an entry in it. A writer commits on the server, then lands by naming the head it expects. If the branch has moved and the changes don't collide, the server merges them with Git's own three-way merge. A real conflict comes back as a refusal the writer can resolve.

Sending each landing to the log alone would leave a thousand writers queueing, so landings on a busy branch go in batches. Everything waiting on a branch goes to the log in one call, up to 256 landings, and lands as one merge commit. Git objects follow afterwards.

We needed that design. In the same 1,000-writer burst, an early mode that polled the log landed 4 of 1,000. One that combined landings but still built Git trees on the way landed 385. [The research post](/blog/serverless-git-on-cloud-primitives) has those runs.

## What we measured

From our dev environment on October 30, with one client through a bench Worker in the same US region as the platform:

| Test | Landings per second | Slowest 5% of landings took over |
|---|---|---|
| 100 writers, 1 repository | 116 | 485 ms |
| 1,000 writers, 1 repository | 168 to 424 | 0.9 to 4.5 s |
| 20 repositories, 10 writers each | 117 | 1.3 s |

Every writer landed: 100 of 100, 1,000 of 1,000 and 200 of 200. In the 1,000-writer test, the slowest 5% of commits took over 0.8 to 1.2 s. Each writer adds its own new file, which is the friendly case for merging.

In a separate run on October 27, one repository held 193.7 landings per second for 60 seconds with 0 refused. That's one run. With 200 writers declaring what they read, we also checked 6,441 to 8,001 log entries per run for write skew, where two landings pass alone and go wrong together. We found 0 violations in 3 of 3 runs.

## What we haven't measured

Nothing failed at 1,000 writers, so we don't know where the ceiling is. We haven't run more writers than that, or more than 20 busy repositories, and the 30-minute sustained test hasn't run. These clients also sat close to the platform, and nobody has run this burst from another continent. [Our same-region test](/blog/keeping-your-data-close) has single-request numbers from Europe and Asia.

Git clones lag the log. On October 27 a clone saw a landing 4.9 s later at 1,000 writers (p95, one run), and right after three bursts in a row a clone waited 59 s. The log itself is current the moment a landing returns.

One log per repository also means two branches of one repository queue behind each other. Two repositories never interact.
