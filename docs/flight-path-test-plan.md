# Flight Path test plan

One Landing through every step, on dev, with the real API, CLI, Git and browser. Each piece has its own kit item (33 to 42); this is the only test that flies them together.

| Run | Command | Cost |
|---|---|---|
| Scripted flight and failures | `node tools/staging-realworld.mjs --flight-path` (items 43, 44) | Free |
| Real agent | `node tools/staging-realworld.mjs --only 0,12,45,17 --yes` (item 45) | A model's quota |
| What the kit can't force | `pnpm exec vitest run --config tests/workers/vitest.config.ts tests/workers/repo-flight-failures.test.ts` | Free |
| Real agents from the web app | `node tools/staging/web-agents-flow.mjs` (dev owner, one saved login in `.local/agents-live/`) | Real model credit, capped by `--cap-usd`, default $5 |
| F1 timed | `F1_RUNS=10 node tools/staging-realworld.mjs --only 0,12,f1,17` | Free |

**Result, 2026-10-31 on dev `56338b40`: all 12 legs pass, scripted and with a real agent, and all 10 failure cases pass, 8 live and 2 in `tests/workers`.** The live run found no new product bug; 5 were found by reading the code first and fixed before it. Evidence: `.local/staging/feature-gate-1793502289532.json` (43), `feature-gate-1793503271690.json` (44), `feature-gate-1793502983913.json` and `flight-agent-1793502872961/` (45).

Needs `LAND_WHEN_CLEARED=on` and `LANDING_INSTRUMENTS=on` on the platform Worker, `0045` applied, and the harness image rolled for Intent drift. A second live run evicts this one's session, so run it alone. Each test repository sets its own `auto_landings` switches and is deleted by item 17.

## The twelve legs

| # | Leg | What proves it | Needs | Scripted (43) | Real agent (45) |
|---|---|---|---|---|---|
| 1 | Flight plan filed | `yoneda flight-plan` answers filed, for a branch not pushed yet | `0045` | Pass, 228 ms | Pass, Agent filed it |
| 2 | Takeoff with context and memory | The real start hook's context holds the memory; the start delivery records it | Memories | Pass, 841 ms | Pass, In its context |
| 3 | Agent works and pushes | Read hook warns of the other Landing; the push declares the read; the Stop hook records the session on the commit | Hooks | Pass, 3.0 s | Pass, 21.2 s, with 1 to 3 |
| 4 | A Landing opens from the push | One row, `origin: auto`, at the pushed head, with the plan filed before it existed | `auto_landings.create`, `0044`, `0045` | Pass, 306 ms | Pass, 162 ms |
| 5 | Route | Commit, session and deliveries by REST; `yoneda change route` | None | Pass, 330 ms | Pass, 139 ms |
| 6 | Instruments | Risk with 4 reasons, same score twice; Slop and Intent drift from check evidence; 3 cards on the page | `LANDING_INSTRUMENTS` | Pass, 3.1 s | Pass, 162 ms (Risk only) |
| 7 | CTC warns, holds, orders | Radar overlap; warning on record; a ticket ahead gives `SEPARATION` and place 2, on API and page; the ticket lands first and sends this one around | `LAND_WHEN_CLEARED` | Pass, 22.3 s | Pass, 22.1 s |
| 8 | A blocking finding | A review token's finding on an approved, passed head: `go_around` with `FINDINGS`, an owner's land refused, chip says Go-around | `findings_block` | Pass, 7.4 s | Pass, 7.7 s |
| 9 | Go-around | The next session hears it at its start; `yoneda change show` has it; the pilot merges main and pushes; the approval drops; the finding is on the older commit | None | Pass, 7.1 s | Pass, 35.1 s |
| 10 | Cleared on that exact head | The agent looks again and resolves nothing; CTC holds for the approval alone; then `cleared` on this head | `LAND_WHEN_CLEARED` | Pass, 8.3 s | Pass, 5.1 s |
| 11 | Lands by itself, once | Nobody calls land; 4 jobs race; one decision holds a version, once on main's first-parent line, version unchanged after 8 s, after the other Landing | Same | Pass, 10.7 s (7.4 s from approval) | Pass, 10.9 s (3.7 s from approval) |
| 12 | Black box | Both sessions, the transcript with its context, every decision with reasons, MCP, pages | None | Pass, 3.5 s | Pass, 483 ms |

## Failure cases

| # | Case | What proves it | Where | Live |
|---|---|---|---|---|
| F1 | Stale head | Approved and passed on the old head: stays open. The new head lands, not the old one | Live. The race between ask and land: Rust, `HEAD_MOVED` | Pass, 17 s |
| F2 | Failed check | Required: `go_around`, a passing rerun lands it. Not required: `go_around` on green gates, page agrees | Live | Pass, 27 s |
| F3 | Path-limited token sees nothing | 7 reads answer 403 with no path or title; filing a plan refused; work beyond its grant holds on `OUTSIDE_GRANT` | Live | Pass, 14 s |
| F4 | Fork needs an approval of its head | A passing check holds on `FORK_NEEDS_APPROVAL`; approved heads land | Live | Pass, 36 s |
| F5 | Two Landings racing | Different files: both land. Same line: one lands, one goes around | Live | Pass, 48 s |
| F6 | Automation pause | Approved head holds on `AUTOMATION_PAUSED`; the resume alone lands it | Live | Pass, 20 s |
| F7 | Nothing required | A push holds on `NOTHING_REQUIRED` and does not land | Live | Pass, 22 s |
| F8 | `REPO_FULL` | Held with the reason, nothing moves, lands with room | `tests/workers`: nothing fills the database live | Passing |
| F9 | A job retried twice lands once | 4 deliveries, on the head and through the queue: one landing on record | `tests/workers`, since a live queue redelivers when it chooses. Leg 11 races duplicates live | Passing |
| F10 | A rollback mid-queue | A break-glass revert with a ticket in line: the ticket lands on the revert, the bad line stays out | Live | Pass, 44 s |

**F10 reads "rollback" as reverting a landed commit.** A deploy rollback past the job's handler drops queued jobs: the entrypoint acks a kind it doesn't know. Nothing tests that loss live; the Landing waits for its next trigger.

## The real agent

`zai-coding-plan/glm-5.3` through opencode in the Docker sandbox, 2 runs, 55.4 s in all: 6,752 input, 1,016 output and 65,792 cached tokens. opencode reported $0: this model bills the coding plan's quota. It filed its plan, kept to the memory's 3 tries unasked, heard the finding from its context, merged main and added the 100 ms delay. The other Landing, the check, the approval and the finding were scripted. Host unchanged. Egress refused only the sandbox's own probes and opencode's `models.opencode.ai`.

## Real agents from the web app

Nothing is scripted past the clicks: `web-agents-flow.mjs` creates a repository in the dialog, sets 0 approvals and 2 required checks, turns on the 3 switches and adds Slop and Intent drift with **Block landing at** left alone. Each commit is made on the Files page, and the open Landing has to show the values without a reload.

| Case | Change | Expected |
|---|---|---|
| Clean | A small helper that matches its plan | Slop low, on course, lands by itself |
| No plan | A small helper, no flight plan | `no_plan`, no container, lands: a missing plan never blocks |
| Sloppy | Dead code, debug lines, 3 copies of a function | Slop high, check fails, goes around; a tidy Edit on the branch lands it |
| Drift | Plan says fix a typo, diff adds payments | Off course, check fails, goes around |
| Never | The same drift, with Never chosen on both agents | Off course, check passes, lands: an explicit setting wins |

**A run with no reading:** a run that fails or times out fails a required check, with a comment saying to push again. Nothing else would answer that check, so the Landing used to wait for good. A check nobody requires stays silent. Out of credit is no failure: the run waits and resumes with the credit.

**A pause fails nothing.** Pushes during it start no run, and a run it stops posts nothing. `resume_automation` sends `repo.resumed`, and each agent a landing requires then looks at the open Landings, up to 200: `claim` restarts a run the pause stopped, and a head with its answer is left alone. An agent nobody requires waits for the next push. A lost hook waits for the next event, as any trigger does.

**Bad verdicts block by default** (owner, 2026-10-31): `block_at` is `high` for Slop and Intent drift. `partial` and a medium Slop reading pass. With Land when cleared any failed check goes around, required or not.

**Settings saved earlier:** a saved level or a saved Never wins; unset gets `high`. Never wasn't stored while it was the default, so a workspace that picked it then can't be told from one that never chose, and blocks at `high` now.

**Result, 2026-11-01 on dev:** all 6 cases as expected, with `mimo/mimo-v2.6-flash` through opencode, no fallback: Clean and Never on `700b1d47`, the others on `e8649297`. Evidence: `.local/agents-live/1793541518384/`, `.local/agents-live/1793508847041/`. $0.20 of real credit, $0 to $0.021 a run. Values reached the open page 75 to 211 s after the commit, with no reload.

| Case | Slop | Intent drift | Outcome |
|---|---|---|---|
| Clean | low | on course | Landed |
| No plan | low | `no_plan` | Landed |
| Sloppy | high, 9 findings | partly on course | Go-around; an Edit on the branch landed it, low and on course |
| Drift | medium | off course | Go-around |
| Never | medium | off course | Landed |

This test led to 7 fixes a script had hidden: the web app couldn't commit; the page showed no result until reloaded; it said Go-around on a landed Landing; comments showed raw Markdown and a run id; a go-around chip read as healthy; one low nit held a passing Landing for nobody; a failed run left a required check waiting for good.

## Timing

**F1 repeated, on `700b1d47`, a fresh repository each:** 10 of 10 in 18.4 to 20.5 s, median 19.4 s (`F1_RUNS=10`). 8.2 s of that is the test's own wait. Approval to cleared, by the platform's stamps: 3.2 to 4.6 s.

**The one 65 s F1 was a queue stall.** Workers logs for 2026-11-01 03:08 to 03:10 UTC show the last approval at 08:59.8 and no consumer invocation from 08:43 to 09:42: a 70.7 s gap, against 14.6 s at most across F1 ×10, then one full batch of 10. Every outcome was `ok`, with no warning, error or platform deploy near it, and logs are not sampled. So our consumer wasn't called. Why delivery paused can't be seen from here. Seen once; anything on that queue waits when it happens, and nothing was lost.

**The 100-writer burst (item 8) did not slow down.** 3 runs on `700b1d47`: burst 0.7 / 1.0 / 1.5 s min, median, max, 100 of 100 landed and read back. The 6.7 s and 11.1 s were step times, about 9 s of setup around a burst that took 1.4 s and 1.2 s. Read `elapsed_s`, not the step's time.

## Unverified

| Gap | Why it matters |
|---|---|
| Slop and Intent drift are scripted in 43, 44 and 45 | They prove the read and the card, not the agents. `tools/staging/web-agents-flow.mjs` is the real run of those; its results are above |
| Legal hold or `REPO_FULL` lifted | Nothing asks again; the Landing waits for its next event. Read from the code, not tested |
| The switch turned on over a Landing that already cleared | The same: nothing asks. Read from the code, not tested |
| Risk bands | Not calibrated (landings plan, stage 4). High holds a Landing on an uncalibrated score |
| Rate at volume | One Landing at a time, plus one race of two |
