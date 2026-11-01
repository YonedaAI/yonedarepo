---
title: Landings replace the pull request
date: 2026-10-31
summary: When agents write the code, review has to start from evidence. How a Landing works, and what happened when a real agent went through one and nobody pressed Land.
author: Yoneda Labs
category: Engineering
order: 2
---

The pull request assumes a person reads a diff and presses merge. That holds while people write code at a pace other people can read. Agents produce more changes than any team can read, and a merge on a diff nobody read tells you very little.

We replaced it with the Landing. A Landing still has a diff and comments, and you can read every line whenever you want to. What changes is where review starts: with evidence about the exact commit that would land. A reviewer decides from there where to look.

## What the evidence is

A Landing shows a state: Planned, In flight, Cleared to land, Go-around, Landed or Closed. Under that sit the checks and approvals on the current commit, and the route: its commits, the sessions that wrote them and what those sessions were told.

All of it belongs to one commit. When an agent pushes again, approvals on the old commit drop. In our failure tests, a Landing approved and passed on an older commit stayed open once a newer one arrived, and only the newer commit landed.

## You don't have to open one

A repository can open a Landing for every pushed branch. The switch is off by default, and turning it on costs nothing and starts no agent. Work pushed straight to `main` shows in the list as Landed directly, so it stays visible. Your tools keep working too: the API, CLI, MCP and webhooks still call a Landing a change.

## A landing nobody pressed

On October 31 on dev, a real agent went through a Landing: opencode running GLM-5.3 in a Docker sandbox. Its task was to bound a retry function. It filed a plan, took a limit of 3 tries from a memory with nothing in its prompt asking for that, and pushed. That took 21.2 s, and a Landing opened from the push.

A review finding then blocked it, and with that rule on, even the owner's land call was refused. The agent heard the finding from its context, merged `main`, added the 100 ms delay the finding asked for and pushed again in 34.3 s. A second account approved the new commit, and it landed 3.7 s later. 4 jobs raced to land it, and it landed once.

So the agent spent 55.4 s across its two sessions, and nobody pressed Land.

Our test script played the second account, the review finding, the check and a competing Landing, and with those steps the whole run took about 131 s. It shows that nobody has to press Land. It doesn't show that nobody has to approve. A repository that requires no check or approval never lands by itself, because every push would then be a landing.

## Where this stands

Landings are live on production. Automatic landing is on for dev and off for production while we watch it. Flight plans aren't on production yet either. We have tested automatic landing one Landing at a time, plus one race of two, so we have no figures for it at volume.
