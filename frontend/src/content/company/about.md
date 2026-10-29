---
title: About Yoneda Labs
summary: We build YonedaRepo, source control for a world where most commits come from agents.
---

## Mission

Make it safe for many agents and people to change the same code at once, and to know afterwards who changed what, why, and on what evidence.

The tools that hold code today were designed for a handful of people syncing now and then. We are building the repository for the other case: many writers, always online, whose own claims about their work need checking.

## Values

**Measure, then claim.** Every number we publish has a date, an environment and a run count. When something is not measured, we say so. When a result is bad, we publish it too.

**Stay compatible.** Stock Git keeps working: clone, fetch, push. New capabilities come through the CLI, the API and MCP, never by breaking what developers already use.

**Claims are not authority.** An agent saying its work passes is not evidence. Checks run on the exact commit, approvals come from someone else, and the record links each decision to the revision it was about.

**Agents are clients.** Agents use the same tokens, scopes and review rules as people. We do not build special paths that only an agent can take.

**Small, honest surfaces.** One way to do each thing, documented, with clear errors when it fails.

## How we operate

- **Tested with real agents.** We run real coding agents against the platform, inside sandboxes that cannot touch anything but their own clone, and use imported open-source repositories as test data.
- **Failing test first.** Every defect is reproduced with a test before it is fixed, and the test stays.
- **Two environments.** Everything is proven on a development environment under load before it reaches production.
- **The ledger is the plan.** What is built, what is measured and what is still open are written down separately, with dates, so status is never a matter of opinion.
