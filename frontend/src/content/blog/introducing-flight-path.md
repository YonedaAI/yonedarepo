---
title: Introducing Flight Path
date: 2026-10-31
summary: Every change on YonedaRepo gets a route, from the plan an agent files to the record it leaves after landing. What happens at each stop, what we tested and what runs on production today.
author: Yoneda Labs
category: Engineering
order: 1
---

YonedaRepo is a Git platform built for coding agents and the people who review their work. You keep using stock Git, and agents reach the same repositories through Git, our CLI, the API or MCP.

Agents produce more changes than a team can read, and a diff alone won't tell you what an agent set out to do or what it knew when it started. Flight Path keeps that on the change. A pilot files a plan, takes off, flies a route and lands, and the aircraft keeps a record of the trip. A change on YonedaRepo makes the same trip, so its reviewer can start from what happened along the way and then read the lines that need reading.

We call the change a Landing. It replaces the pull request, and [that post](/blog/landings-replace-the-pull-request) explains why.

## The route

| Stop | What happens |
|---|---|
| Flight plan | The agent writes down its goal and how far the work reaches. It does this on purpose: we never pull plans out of prompts. |
| Takeoff | The session starts with context: what earlier sessions did, the open Landings, the repository's rules and any memories about its files. |
| Route | The Landing records its commits, the sessions behind them and the memories those sessions received. |
| Instruments | Each push gets readings. Risk is a score worked out by rules. Slop is a review agent's level for leftovers like dead code. Intent drift compares the diff with the plan. |
| Go-around | A finding sends the work back. Nothing wakes the agent: it hears the finding from its context, fixes the work and pushes again. |
| Cleared to land | Every required check and approval has passed on this exact commit. [Tower](/blog/meet-tower), which is rules and no model, makes that call. |
| Landed | The commit is on the base branch, in order. |
| Black box | The transcript and the context the agent was given stay readable afterwards. |

## One change through every stop

On October 31 we flew Landings down the whole path on our dev environment, with the real API, CLI, Git and browser. The test has 12 legs. All 12 passed in a scripted run, and all 12 passed again with a real agent: opencode running GLM-5.3 in a Docker sandbox.

We also ran 10 failure cases, such as a commit going stale after approval, a failed check and two Landings racing for one line. All 10 pass. 8 ran live on dev. The other 2 run in the Workers runtime, because we can't fill a repository to its limit or make a live queue redeliver on demand. The live runs found no new product bug. Reading the code beforehand found 5, and we fixed those first.

The agent's work was real, and our test script played everything around it: the other Landing, the check, the approval and the review finding. Slop and Intent drift were scripted in these runs too, so they prove the cards on the page and leave the review agents untested here.

## What runs on production today

Landings, the route, flight plans, required checks and approvals, session records, transcripts and memories are live on yonedarepo.com. So is the Tower page, which shows what Tower would decide, and automatic landing, a per-repository switch that's off by default. The Instruments cards are live too, and Intent drift runs as a review agent you add to a repository and pay for from your credit. Risk stays a beta until we can score it against real outcomes.
