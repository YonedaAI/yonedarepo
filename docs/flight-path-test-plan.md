# Flight Path test plan

One Landing through every step, on dev, with the real API, CLI, Git and browser. Each piece has its own kit item (33 to 42); this is the only test that flies them together.

| Run | Command | Cost |
|---|---|---|
| Scripted flight and failures | `node tools/staging-realworld.mjs --flight-path` (items 43, 44) | Free |
| Real agent | `node tools/staging-realworld.mjs --only 0,12,45,17 --yes` (item 45) | A model's quota |
| What the kit can't force | `pnpm exec vitest run --config tests/workers/vitest.config.ts tests/workers/repo-flight-failures.test.ts` | Free |

Needs `LAND_WHEN_CLEARED=on` and `LANDING_INSTRUMENTS=on` on the platform Worker, `0045` applied, and the harness image rolled for Intent drift. A second live run evicts this one's session, so run it alone. Each test repository sets its own `auto_landings` switches and is deleted by item 17.

## The twelve legs

| # | Leg | What proves it | Needs | Live |
|---|---|---|---|---|
| 1 | Flight plan filed | `yoneda flight-plan` answers filed, for a branch not pushed yet | `0045` | Not run |
| 2 | Takeoff with context and memory | The real start hook's context holds the memory; the start delivery records it | Memories | Not run |
| 3 | Agent works and pushes | Read hook warns of the other Landing; the push declares the read; the Stop hook records the session on the commit | Hooks | Not run |
| 4 | A Landing opens from the push | One row, `origin: auto`, at the pushed head, with the plan filed before it existed | `auto_landings.create`, `0044`, `0045` | Not run |
| 5 | Route | Commit, session and deliveries by REST; `yoneda change route` | None | Not run |
| 6 | Instruments | Risk with 4 reasons, same score twice; Slop and Intent drift from check evidence; 3 cards on the page | `LANDING_INSTRUMENTS` | Not run |
| 7 | CTC warns, holds, orders | Radar overlap; warning on record; a ticket ahead gives `SEPARATION` and place 2, on API and page; the ticket lands first and sends this one around | `LAND_WHEN_CLEARED` | Not run |
| 8 | A blocking finding | A review token's finding on an approved, passed head: `go_around` with `FINDINGS`, an owner's land refused, chip says Go-around | `findings_block` | Not run |
| 9 | Go-around | The next session hears it at its start; `yoneda change show` has it; the pilot merges main and pushes; the approval drops; the finding is on the older commit | None | Not run |
| 10 | Cleared on that exact head | The agent looks again and resolves nothing; CTC holds for the approval alone; then `cleared` on this head | `LAND_WHEN_CLEARED` | Not run |
| 11 | Lands by itself, once | Nobody calls land; 4 jobs race; one decision holds a version, once on main's first-parent line, version unchanged after 8 s, after the other Landing | Same | Not run |
| 12 | Black box | Both sessions, the transcript with its context, every decision with reasons, MCP, pages | None | Not run |

## Failure cases

| # | Case | What proves it | Where | Live |
|---|---|---|---|---|
| F1 | Stale head | Approved and passed on the old head: stays open. The new head lands, not the old one | Live. The race between ask and land: Rust, `HEAD_MOVED` | Not run |
| F2 | Failed check | Required: `go_around`, a passing rerun lands it. Not required: `go_around` on green gates, page agrees | Live | Not run |
| F3 | Path-limited token sees nothing | 7 reads answer 403 with no path or title; filing a plan refused; work beyond its grant holds on `OUTSIDE_GRANT` | Live | Not run |
| F4 | Fork needs an approval of its head | A passing check holds on `FORK_NEEDS_APPROVAL`; approved heads land | Live | Not run |
| F5 | Two Landings racing | Different files: both land. Same line: one lands, one goes around | Live | Not run |
| F6 | Automation pause | Approved head holds on `AUTOMATION_PAUSED`; the resume alone lands it | Live | Not run |
| F7 | Nothing required | A push holds on `NOTHING_REQUIRED` and does not land | Live | Not run |
| F8 | `REPO_FULL` | Held with the reason, nothing moves, lands with room | `tests/workers`: nothing fills 9 GB live | Passing |
| F9 | A job retried twice lands once | 4 deliveries, on the head and through the queue: one landing on record | `tests/workers`, since a live queue redelivers when it chooses. Leg 11 races duplicates live | Passing |
| F10 | A rollback mid-queue | A break-glass revert with a ticket in line: the ticket lands on the revert, the bad line stays out | Live | Not run |

**F10 reads "rollback" as reverting a landed commit.** A deploy rollback past the job's handler drops queued jobs: the entrypoint acks a kind it doesn't know. Nothing tests that loss live; the Landing waits for its next trigger.

## Unverified

| Gap | Why it matters |
|---|---|
| Slop and Intent drift are scripted in 43, 44 and 45 | They prove the read and the card, not the agents. `tools/staging/managed-live.mjs` is the real run of those |
| Legal hold or `REPO_FULL` lifted | Nothing asks again; the Landing waits for its next event |
| Risk bands | Not calibrated (landings plan, stage 4). High holds a Landing on an uncalibrated score |
| Rate at volume | One Landing at a time, plus one race of two |
