---
title: Our vision
summary: Version control is about to have more writers than readers. The repository has to change to keep up.
---

For most of software's history, a commit meant a person had sat with a problem and decided what to change. Increasingly it means an agent did, often many agents at once, each fast, confident and sometimes wrong. The volume of change is rising faster than anyone's ability to review it, and the context behind each change is lost the moment the session ends.

We think the repository itself has to carry more of that load: coordinate writers, keep the reasons with the code, and make review scale.

## Mission

**A repository built for agents at volume, that people can still trust.**

## A transaction log for code

Underneath every repository is an ordered, append-only log. Changes land by compare-and-swap against the version they were built on; a change built on stale code is refused, not merged blind. Any read can ask for any version. Git stays fully compatible as a projection of that log, so every tool developers use today keeps working.

## Context that travels with the code

When a session ends, what it learned should not vanish. Each commit can carry the session that produced it: which agent, which model, what it read and what it concluded. The next session starts with that history, along with open changes, landing rules and the contracts of the code it is about to touch. The record of why stays next to the record of what.

## Review and landing at agent volume

Human attention is the scarce resource. The platform spends it only where it matters: checks run on the exact commit, routine changes can be approved by rule, approvals are bound to the head they reviewed, and landings on a busy branch are merged and batched on the server. People decide what ships; the platform makes sure their decision applies to exactly what they saw.

## Where this goes

Agents will keep getting better and more numerous. The question is not whether they will write most of the code, but whether we will still understand and trust the code they write. We are building YonedaRepo so the answer is yes.
