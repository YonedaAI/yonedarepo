---
title: Testing with real agents in a sandbox
date: 2026-10-28
summary: Twelve coding agents, two waves, one repository, every commit landed on main. How we run real agents against the platform without letting them touch anything else.
---

YonedaRepo is built for agents, so we test it with real ones. But a coding agent with shell access is untrusted code with a model attached. This post describes the sandbox we run them in and what the latest run showed.

## Three levels

Our live test kit checks agent behavior at three levels:

1. **Git semantics, no model.** Protocol v2, partial and shallow clones, two `yoneda::` clones pushing, pulling, merging, rebasing, cherry-picking and reverting, a same-line conflict refused and resolved, a change opened and landed with the CLI, and a 1 MiB LFS file round trip.
2. **Agent hooks, no model.** A scripted session runs through the real hooks: it starts with a context naming earlier sessions, records a read, is refused a plain push while reads are pending, pushes with the read declared, and its session record reads back.
3. **Real agents, paid.** N agents each get their own clone and token, and all edit the same file and the same changelog, then push to `main` at once. Then a second wave.

## The sandbox

Every agent runs in its own Docker container:

- the agent's clone is the **only** host path mounted;
- no host environment, configuration, GitHub CLI or SSH agent;
- the model credential arrives on stdin;
- egress reaches the internet and the platform's port, but not the host or the local network;
- the container refuses to start unless the clone's origin is the test repository.

Around the run, the host's checkouts and their remotes are snapshotted. Any change, to HEAD, a branch, status, a worktree or a remote ref, fails the test loudly.

## The October 28 run

Eight opencode agents on the GLM-5.3 model, then four more, all on one repository:

- **12 of 12** agents exited cleanly, each within its 600 s limit (15–124 s each; 214 s for the whole item).
- **12 agent commits** reached `main`, and no clone made a merge commit.
- **12 session records**, one per commit. Each second-wave agent's starting context named the first wave's sessions.
- The host checkout and both remotes were unchanged.

## What did not go as well

The day before, four agents per CLI on one repository: opencode landed 4 of 4, with one conflict resolved by a single resume. Claude Code on the same GLM model landed 2 of 4; two agents reported having no file tools. That is still an open item.

We also compared token use on one small task. Agents using the `yoneda` read tools used **more** input tokens than agents working from a plain clone: 121.6k mean versus 52.7k. On a small repository, reading on the server saved nothing, and our counter of whole-file reads was wrong in both arms. We publish that because it is what we measured.
