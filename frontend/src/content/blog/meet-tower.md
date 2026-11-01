---
title: Meet Tower
date: 2026-10-31
summary: Tower clears code for landing with rules alone. It warns sessions about traffic, holds Landings that would collide and puts them in order. It writes no code and starts no agents.
author: Yoneda Labs
category: Engineering
order: 3
---

When many agents work in one repository, something has to decide what may land and in what order. We didn't want that something to be another model. Tower is a set of rules on the platform. It reads the state of a Landing and answers, and a recorded state replays to the same answer. It writes no code and starts no agents.

## Clearing a Landing

For one exact commit, Tower gives one of three answers, with reasons:

| Answer | Means | Example |
|---|---|---|
| Cleared | It may land | Every required check and approval passed |
| Hold | Waiting for something that needs no new work | An approval still to come |
| Go-around | The work has to change | A failed check, or a merge that conflicts |

The Landing page and the job that lands a Landing ask the same rules, and the job asks again at the moment it lands, so what the page says a Landing is waiting for can't disagree with what the job does. Tower asks no model. An agent's verdict reaches Tower only as a check result or a comment already on record. The Land button and `yoneda change` work as before and don't go through these rules.

Two holds exist because automation would otherwise land the wrong thing. A Landing from a fork needs an approval of its head, because anyone who can read a repository can fork it, and green checks alone would land a stranger's commit. A repository that asks for no check or approval never lands by itself, or every push would land.

Each decision stays on the Landing with its reasons and the commit it judged. The newest 32 are kept.

## Warning about traffic

A session hears about a collision before it happens. When it starts, or reads a file, the platform names any open Landing on the same work:

```text
- Landing 12 ("Retry budget", branch fix) is changing `retry` in src/net.rs
```

The closest overlap comes first: the same symbol, then the same file, then a Landing that read the file. A warning holds nothing. The session decides what to do with it.

## Holding and ordering

If a Landing ahead in line wrote something this one read, or read something it writes, Tower holds the second until the first is out of the way. The normal rules then judge whatever lands second. A Landing that is only waiting holds nobody up, so one left open can't stop a repository.

The line runs queued landings first, then cleared ones with the oldest first, then the rest. Each repository's Tower page shows it: every open Landing, what it's waiting for, its place in line and where it overlaps another.

## What we tested

On dev on October 31, two Landings racing on different files both landed. Two racing on the same line gave one landing and one go-around. When 4 jobs raced to land one Landing, it landed once.

## Limits

Automatic landing is a per-repository switch, off by default, and it's off across production for now. There the Tower page shows what Tower would say and nothing lands on its own. Risk is a beta reading that doesn't hold a Landing, because it isn't calibrated against real outcomes yet. We've tested one Landing at a time and one race of two, so rate at volume is unmeasured. And when a legal hold lifts or a full repository gets room, nothing tells Tower to look again: from reading the code, the Landing waits for its next event.
