---
title: Does memory help an agent?
date: 2026-10-31
summary: We planted rules an agent could learn only from a memory, then ran it with memory and with a plain clone. With memory it kept the rule 6 times of 6. With a plain clone, 0 of 6.
author: Yoneda Labs
category: Engineering
order: 4
---

We tell people a session should start knowing what earlier sessions learned. Until this test, nothing we had measured showed that it helps. The one number we did have pointed the other way: on a small repository, [agents using our read tools spent more tokens](/blog/real-agents-in-a-sandbox) than agents with a plain clone, 121.6k against 52.7k, and memory wasn't in that test.

So we built a test that could come out badly for us.

## The test

We took three open-source repositories, cobra, commander.js and click, and made up one rule for each: where code must go, what a name must be, what a value must be. Before each agent started, we scanned the fork's files, commit messages and history for the rule. A hit would have stopped the test, so a memory was the only place an agent could learn it.

There were two arms, a plain clone and the `yoneda` CLI with context and memory. Each run got its own fork, and only the memory arm's forks held memories. Each of those held 13, with the rule the oldest. A session starts with the 8 newest, so the rule could reach an agent only through the file it touched or the words of its prompt, behind 2 newer memories on the same file.

The agent was opencode running GLM-5.3 in a Docker sandbox, on our dev environment on October 31. We ran 6 runs per arm, 2 on each rule. The pass check read the pushed diff through the API, and we never ran the agent's code.

## The result

| Rule | With memory | Plain clone |
|---|---|---|
| Where code goes | 2 of 2 | 0 of 2 |
| What a name must be | 2 of 2 | 0 of 2 |
| What a value must be | 2 of 2 | 0 of 2 |
| All runs | 6 of 6 | 0 of 6 |

Fisher's exact test gives p = 0.0022. The bar was set before the run: p under 0.05, at least 5 valid runs per arm and more than one rule improved. No run was invalid, and the memory reached the agent in all 6 memory runs.

Every run in both arms landed its work. The plain agents did the task and broke a rule nobody had told them about.

## What it cost

| Measure | With memory, mean (range) | Plain clone, mean (range) |
|---|---|---|
| Tokens | 227,073 (69,924 to 500,798) | 111,429 (52,600 to 254,744) |
| Time | 96.4 s (40.6 to 143.1) | 46.3 s (28.1 to 77.8) |

The memory runs averaged about twice the tokens and twice the time. The ranges overlap, so 6 runs per arm show no difference. They don't rule one out either, and a doubling of the mean is worth watching.

## What this doesn't show

We wrote the rules and built the test so that memory was the only way to learn them. It shows that this agent follows a memory it receives, on this model. It can't say how often real repositories hold rules like these. The sandbox image has only opencode, so no other agent has been tried.
