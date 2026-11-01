# Landings plan

Status: plan, not built. Written 2026-10-31 at dev `89340925`.

Landings is our replacement for the pull request. A pilot files a plan, takes off, flies a route and lands. Work here does the same, and the reviewer reads the evidence, not every line.

Hard rule from the owner: **nothing we have now may break.** The safety rules in [global-scale-plan.md](global-scale-plan.md) apply to every step.

## What the code showed

| Finding | Why it matters | Plan |
|---|---|---|
| **Agents are told to push straight to `main`** (`SKILL.md:8`) | No branch means no Landing, so the main flow would be missed | Direct landings appear as Landings too |
| **Auto-creating a change starts paid agent runs on every branch** (`dispatch.ts:127`) | Silent spend | Separate switches; off by default |
| **Only workspace owners can read managed runs** (`api.ts:59`) | Cards would vanish for collaborators and public readers | Build cards from check evidence |
| **Explicit create fails after an auto row exists** (`changes.rs:152`) | Installed CLIs would break | Ship adoption first |
| **Some gates look wired but aren't** | Can't promise "Cleared to land" yet | Fix them first (stage 1) |
| **The old comparison harness is gone** (deleted in `34a63b3a`) | Nothing can compare arms today | Restore it on the Docker sandbox |

## Names

UI names only. These stay exactly as they are: `/changes`, `git_change_*`, `yoneda change`, `change.*` webhooks, payload fields, status values, gate kinds and check names.

| Pilot term | Meaning | Built on | Status |
|---|---|---|---|
| Flight plan | Goal and scope | New table | New |
| Takeoff | Session starts with context | `git_context`, session hooks | Built |
| Route | Commits, sessions, memories used | New read over existing rows | Data built, read new |
| Instruments | Risk, Slop, Intent drift | Check evidence | Slop built, 2 new |
| Cleared to land | All gates pass | `change_gates` | Built, fixes needed |
| Go-around | Findings sent back, agent pushes again | Comments, re-review on push | Partly built |
| Landed | On the base branch | `git_land` | Built |
| Black box | Transcript and context shown | `SessionTranscript`, `SessionDeliveries` | Built |

**Naming clash:** "Landing rules" (repo settings) and the `land` webhook stay. The "Landing gates" label becomes "Clearance".

Landing states are labels worked out from existing data, never new status values: Planned, In flight, Cleared to land, Go-around, Landed, Closed.

## Order of work

| # | Stage | Ships alone? |
|---|---|---|
| 1 | Fix the gates | Yes |
| 2 | Memory and context test | No prod change |
| 3 | Route read and timeline | Yes |
| 4 | Instruments: Slop and Risk | Yes |
| 5 | Adoption of auto rows | Yes, before stage 6 |
| 6 | Landings for every push; rename the UI | Yes, switch per repo |
| 7 | Flight plan and Intent drift | Yes, two waves plus a container rollout |
| 8 | Go-around | Yes |

## 1. Fix the gates

| Fix | Problem | Evidence |
|---|---|---|
| ~~Check every commit's class, not just the head's~~ | **Done, on prod at `e10b643d`.** The bypass was real in all 3 landing paths: a logic commit under a docs-only head landed with no approval when `auto_approve` was set | `land_gates.rs` |
| Classify Git pushes | Only server-side commits are classified, so pushes never auto-approve | `repo-commit.ts:102` |
| Let managed agents post required checks | Requiring `code-review` looks set to make every run fail, because nothing sets `check_posters` | `policy.rs:95-110`, `run.ts:192` |
| Make `block_at` work, or remove it from the docs | It is null everywhere and overrides are refused, so Slop always passes | `managed-settings.ts:29`, `report.ts:55` |
| Reach `high` | Level agents are capped at medium | `report.ts:72` |
| Close changes whose branch was deleted | They stay open, blocked forever | `branches.rs:77` |

New policy fields must be left out when empty. Otherwise the policy digest changes and voids every recorded check (`policy.rs:30`).

## 2. Memory and context test

**Question: does an agent do better with our memory and context than with a plain clone?** Nothing has shown that yet. The one earlier run used more tokens with our read tools: 121.6k vs 52.7k, on a small fixture, with no memory arm.

**Setup:**

1. New flow on the Docker sandbox. Restore `armSummary`, `compareArms` and `fisherExact` from `34a63b3a^`.
2. Real history only: `oss-cobra`, `oss-commander`, `oss-click`, or a size-ladder import.
3. **One fork per arm.** Memories can't be deleted, and forks copy none, so a trap on a shared repo would contaminate every later run.
4. Plant a trap that code, docs and Git history don't reveal, and that a memory explains. Write an automatic pass or fail check for it.
5. Two arms: plain clone, and `yoneda` with context and memory.
6. At least 5 runs per arm. 3 per arm can't reach significance on Fisher's test.
7. Confirm in each run that the trap memory was delivered in one arm and absent in the other.

**Score:** trap avoided first, then tokens from `step_finish`, time and landing success. Fix the read counter, which matched `Read` when opencode's tool is `read`.

**Also check live, without a model:** a session record, transcript and context delivery all appear on the change page. Kit item 28 already replays the hooks.

**Use:** opencode with `zai-coding-plan/glm-5.3`, the model today's runs use. The sandbox image has only opencode, so no Claude Code arm yet. Warn the owner first if a run costs money.

If memory doesn't help, fix that before building Instruments around it.

### Results

Built, not run yet: `tools/staging/memory-flow.mjs`. The run fills this section. Run it with `set -a; . ~/.config/yonedarepo/dev-owner.env; set +a`, then `node tools/staging-realworld.mjs --memory-test`, which prints the estimate; add `--yes` to start.

<!-- memory-test-results:start -->
Run 2026-10-31T19:59:45.613Z on `e65eb761`, `zai-coding-plan/glm-5.3`. Evidence: `.local/staging/memory-test-1793474668732.json`.

**Answer: memory helped.** Trap avoided: memory 6/6, plain 0/6, Fisher p = 0.0022.

| Trap | Memory avoided | Plain avoided |
|---|---|---|
| frozen-file | 2/2 | 0/2 |
| env-prefix | 2/2 | 0/2 |
| exit-code | 2/2 | 0/2 |

| Measure | Memory, mean (range) | Plain, mean (range) | Memory / plain | Claim |
|---|---|---|---|---|
| Tokens | 227,073 (69,924-500,798) | 111,429 (52,600-254,744) | 2.04 | ranges overlap: no difference shown |
| Time, ms | 96,379 (40,587-143,125) | 46,289 (28,147-77,799) | 2.08 | ranges overlap: no difference shown |
| Whole-file reads | 1 (0-2) | 1 (0-2) | 1.00 | ranges overlap: no difference shown |

Landing success: memory 6/6, plain 6/6, Fisher p = 1.0000.
Trap memory delivered in 6/6 memory runs. Invalid runs: 0 memory, 0 plain.
<!-- memory-test-results:end -->

**How it is built:**

| Part | Choice |
|---|---|
| Traps | 3 made-up rules, one per repository, each a different kind: `frozen-file` on `oss-cobra` (where code goes), `env-prefix` on `oss-commander` (what a name must be), `exit-code` on `oss-click` (what a value must be) |
| Hidden | Before an agent starts, the fork's tree, commit messages and history are scanned for each rule; a hit stops the test |
| Oracle | Reads the pushed branch's diff through the API; the agent's code is never run |
| Forks | One per run, per arm. Only the memory arm's fork gets memories, so nothing can leak to the plain arm |
| Token | The owner's, limited to the fork and its parent, `repo:read` and `repo:write`, revoked after the run. **A token of the fork alone can't push to it** ("Objects this fork inherits need read on its parent"), so an agent could write to its parent. Nothing tells it to, it has no land scope, and every ref of each parent is compared at the end |
| Delivery | 13 memories per fork, the trap oldest. The start packet is the 8 newest, so the trap reaches an agent only through its file or the prompt's words, behind 2 newer memories on the same file |
| Invalid run | Memory arm: the trap memory didn't read back as delivered. Plain arm: any delivery, any memory, or a `yoneda` read call. Either arm: the agent didn't finish. Reported per arm and never counted |
| Answer | "Memory helped" needs Fisher p < 0.05, at least 5 valid runs per arm and more than one trap improved |

Dropping undelivered runs means the test measures agents that got the memory. How often it was delivered is reported apart, as a product number.

**Dry run:** `node tests/agents/e2e.mjs --only none --memory-stub 6` runs the whole flow locally in the sandbox with a scripted agent that keeps a rule only if it reached its context. It proves the plumbing, not the answer. `--only 32` is the change evidence check without a browser.

## 3. Route read and timeline

1. New read op: for one change, its commits, sessions, memories delivered and checks. All of it lives in the repo's database. Today the page makes several calls and commits aren't returned at all.
2. Bound it: session range already caps at 2,000 commits; add a cap for commits.
3. Timeline on `ChangeView.tsx`, extending `conversation()` and `PushItem`.
4. **Tokens per coding session aren't recorded.** Show bytes read for now.

## 4. Instruments: Slop and Risk

1. New block above the gates at `ChangeView.tsx:146`. Reuse `HistoryStrip` and `ResultTile` (`agentParts.tsx:45`).
2. **Read from check evidence on each head**, which collaborators and public readers can already see. Don't use the managed runs API.
3. **Slop:** the existing `slop-review` value, last 5 heads.
4. **Risk:** worked out by the platform, in Rust, with no model call and no cost: review classes, files and lines touched, sensitive paths, open findings. The same input always gives the same score, and the page shows why. Calibrate against real landings before showing a percentage.

Built, behind `LANDING_INSTRUMENTS` (off): `GET /changes/:n/instruments`, `repo_change_instruments`, `platform_risk.rs`, `Instruments.tsx`. No schema migration, no policy field. A person's landing never reads Risk; only Land when cleared does, below.

| Risk input | Points |
|---|---|
| Review classes, worst commit | docs, formatting, comments 0; logic 15; instructions or unknown 25; **no class, or a commit that couldn't be read, 30** |
| Size | files 0-20, lines 0-20 (lockfile lines not counted), any file not measured +10 |
| Sensitive paths, each kind once | policy, workflows, auth 20; migrations 15; lockfiles 10 |
| Open findings | 5 each, up to 25: unresolved line comments and findings withheld from a line |

Low below 25, High from 55, score capped at 100. The page shows the level and every reason, not a percentage.

**Not calibrated.** Dry run over 3,262 first-parent landings of cobra, commander.js and click, with classes assumed (docs-only or logic) and no findings: Low 73.9%, Medium 25.2%, High 0.9%. Only 6 of them were reverted: 4 Low, 2 Medium. That sets the bands' spread and says nothing about whether Risk predicts trouble. It stays "Risk (beta)" until real platform landings can be scored against outcomes.

## 5. Adoption of auto rows

Ships **before** stage 6.

1. Additive `origin` column on `changes`: `explicit` or `auto`.
2. `git_change_create` on a branch with an unclaimed auto row adopts it: title, body, base, author, and answers as a create. Explicit rows still answer `ALREADY_EXISTS`.
3. Next repo schema migration, in two waves.

**Built:** migration `0044`, in `repo_store/change_adopt.rs`. `migration.rs` holds the ceiling: `MIGRATIONS` may run past `APPLY_THROUGH`, and a known migration is accepted and left unapplied. Wave 1 also carries adoption and the managed filter on `origin`, both reading it from `SELECT *`, so a rollback from wave 2 keeps them.

## 6. Landings for every push

1. **Two switches per repo, both off by default:** create Landings automatically, and run agents on automatic Landings. Turning on the first must cost nothing.
2. **Hook points, both inside the transaction:** `branches::set` and, guarded, `land::append`. Server-side commits only record, so they aren't a hook.
3. **Skip:** `main`, `release*`, `forks/*`, a head already on base, a repo with no `main`. Never fail a push because of this; a commit subject that fails title rules falls back to the branch name.
4. **Direct landings:** the Landings list also shows rows from `landings` with no change, as "Landed directly". No new rows.
5. **Webhooks:** `change.opened` fires per branch and can trip the 1,000-pending shut-off. Fire it only for subscribers who opt in, or batch it.
6. **Open list:** managed sees only the newest 200 open changes (`platform.ts:83`). Raise this or filter first.
7. **Rename in the UI:** sidebar, rail, change page, docs and marketing. Add `/landings` as an alias; `/changes` keeps working. Pinned tests are listed in the kit and `changes.test.ts`.
8. "Open change" stays for forks.

**Owner's default:** a person-closed Landing stays closed until reopened, and a pushed-again landed branch gets a new row. A deleted branch's closed row doesn't hold back a new branch of that name.

**Built, in `repo_store/auto_landing.rs`:**

| Part | Choice |
|---|---|
| Switches | `repo_settings.auto_landings` and `auto_landing_agents`; `PUT /auto-landings`; `landings` in `GET /repos/:id`; Settings → Landing rules. Not in `policy`, so no digest moves |
| Agents | `reviewable` in `cloudflare/managed/dispatch.ts`; a missing `landings` means off |
| Webhooks | `change.opened` for an auto row reaches only hooks listing `change.auto`, which no default includes. Adoption tells every `change` hook |
| Open list | Managed asks for the event's branch, and for `origin=explicit` with agents off |
| Direct landings | `repo_changes {direct}`, from main's first-parent chain, newest 1,000 entries; imports left out |
| On-base check | Head, chain and landing rows, then a walk of at most 256 generations. Past that an old branch may get a row with an empty diff |

## 6a. CTC: land when cleared

`git_land` needs a caller, so with this off a Landing is a better PR. With it on, CTC (Code Traffic Control) lands an open Landing when its gates go green. It evaluates rules and moves a ref; it starts no agent. Traffic, separation, sequencing and the radar are in 6b.

**Built:** `platform_ctc.rs`, `repo_store/land_when_cleared.rs`, `cloudflare/worker/repo-land-cleared.ts`, `repo-land-check.ts`. Behind `LAND_WHEN_CLEARED` (off everywhere) and a per-repo switch (off).

**One decision.** `platform_ctc::clearance(&LandingState) -> Cleared | Hold { reasons } | GoAround { reasons }` is pure: it reads nothing and calls nothing. The page, the job, the land call and a ticket's claim and batch all ask it, so "what is this waiting for" and "may this land" can't disagree. No model is asked anything: an agent's verdict reaches it only as a check result or a comment already recorded.

| Part | Choice |
|---|---|
| Switches | `repo_settings.land_when_cleared`, `findings_block`, in `0044`; `PUT /auto-landings`. Not in `policy` |
| Trigger | An op that can clear a Landing names it in `land_checks` (`triggers.rs`): check passed, approval, comment resolved, new head, review class, Landing opened or reopened. The adapter strips the field and queues `platform_land_check`. A lost message costs that trigger, not the next |
| Job kind known first | `LAND_WHEN_CLEARED` stays off through the deploy that ships the handler, and goes on in a later one. A rollback past the handler drops messages, which waits for the next trigger |
| Exact head | The job asks `repo_land_clearance`; with only Risk missing it reads the diff and asks again with the score; then `repo_land` with `expected_head`. That call decides again in its own transaction. A landing that needs a merge queues as `slow`, and claim and batch decide again, so a newer push or a rejection stops a ticket too |
| Identity | `_system: land-when-cleared`, actor `platform:land-when-cleared`. The role lands only a Landing it names |
| Record | `changes.clearance`, in `0044`: the job's decisions as JSON, newest first, each with its reasons, the head it judged, the state it judged and the version if it landed. `clearances` in `GET /changes/:n`. A recorded state replays to the same decision. Newest 32 per Landing, identical ones skipped; a landing is the last thing recorded. Never a status |
| Audit | None: the org audit log takes events from account authorities only (`audit_log.rs`). The record and the log's actor stand in |

| Decision | Reasons |
|---|---|
| Go-around: the work has to answer | Failed required check or rejection, failed check on the head (required or not: this is how `block_at` reached reads), blocking findings, stale read, a merge that conflicted |
| Hold: it can come without new work | Check or approval still to come, draft title, unresolved line comment, automation pause, legal hold, `REPO_FULL`, a path-limited token that worked on it not covering the landing, Risk High or not scored |

**Two holds the owner didn't list:**

| Hold | Why |
|---|---|
| Fork needs an approval of its head | A reader can fork, so green rules with no approvals would land a stranger's commit |
| Nothing required | With no approval or check asked for, every push lands, and `write` becomes `land` |

**Findings:** `findings_block` is enforced in `land_gates::gates`, so it refuses every landing on a protected base, explicit ones too. It counts open findings from tokens (`go_around`). Findings withheld from a line aren't counted, since nothing can resolve them; they reach the check's value instead.

**Rollback:** `0044` carries these columns on dev, and wave 1 has to ship that text: the digest is computed from it, so a binary with earlier text fails `MIGRATION_DRIFT` on a store that applied it.

## 6b. CTC: traffic

Rules only: CTC warns, holds and orders. It writes no code, assigns no work and starts no agent. No schema migration.

**Built:** `repo_store/traffic.rs` (footprints), `traffic/warnings.rs`, `traffic/queue.rs`, `traffic/radar.rs`, `traffic/overlaps.rs`, `land_when_cleared/separation.rs`, `backend/crates/yoneda-cli/src/traffic.rs`, `RepoCtc.tsx`.

| Part | Choice |
|---|---|
| Footprint | A Landing writes what its own commits changed: first parents from its head down to its base, at most 32. It read what its head declared, the set landing checks. Symbols are `commit_symbols`, so a file the deriver hasn't reached is a whole-file overlap. A merge counts as what it changed against its first parent, so a branch that merged its base in also shows what that brought |
| Warnings | `traffic` beside the answer of `git_context` and `git_context_relevant`, never a ranked item: an installed CLI renders an item it can't name as an open change. One warning is one Landing on one path; 8 at most, 3 per Landing, `more` counts the rest. Same symbol, same file, then a Landing that read it |
| Session's own work | `branch` leaves out its Landing, and what it changed against main counts as named. At a start, as asked about too |
| Once per session | Delivered as `{type: traffic, id, path}`, so the next file of the same Landing still warns. Only a platform that answered traffic gets one |
| Grants and quarantine | Both context reads already refuse a path-limited token, and the read filters by grant as well. A file with a withheld blob on either side is left out, with its symbols. Declared reads are paths only, so a read stays |
| Bound | Newest 50 open Landings. 3 statements for all of them, plus 2 for quarantine: `Counted` holds a warning at 5 statements over a repository with nothing open, the same at 1 and 21 Landings, and rows follow the Landings, not 40 commits of history on the file |
| Separation | `clearance` holds with `SEPARATION` while a Landing ahead wrote what this one read, or read what it writes. With no declared reads a Landing's writes count, as in the batch rule. Holding only orders them: landing's own rules judge whatever lands second. Explicit landings never come here |
| Ahead | A pending ticket, or a newest decision clearing the current head. **Not** a Landing that is only waiting: it might never clear, and one left open would stop the repository. A clearance older than 10 minutes stops holding, for a job that died and lost its last word too |
| Asking again | Whatever takes a Landing out of line asks for those held: landed, closed, a new head, a failed attempt, a ticket settled by the changeset path or refused at the claim. A lapsed clearance asks for nothing: its held Landing waits for its next trigger |
| Sequence | `Queue` reads `land_queue` and the record; nothing new schedules. Tickets, then cleared by oldest decision, then on the radar those waiting, oldest first |
| Radar | `GET /ctc`, `git_ctc_radar`, the CTC page polling every 15 s while on screen. The job's decision, read and never recorded, with the switch off too. 25 Landings by default, 50 at most, and always those in line. `Counted`: 24 statements a Landing, the same after 5 and 35 later landings |
| Conflict check | `reads_untouched` proves no stale read from `txlog_paths` in one indexed read before `occ` reads every log entry since the head's base. `refinements` is one statement, not one per entry. A Landing whose reads were touched still reads those entries, on every radar poll |

## 7. Flight plan and Intent drift

1. **New table** with session, nullable branch, nullable change number, goal, scope, principal and time. Not a change row: a branch-less row breaks branch rules and every open list.
2. **Written on purpose** through a new CLI command and MCP tool. `git_plan` is taken. **Not captured from prompts:** we promise prompts aren't kept (`deliveries.rs:7`).
3. Skill instructions ask agents to file one first. Hooks can't block a stock CLI, so "goal first" is encouraged, never enforced. No plan means the drift card says "No flight plan".
4. Linking: the client sends the branch name. A push option beside `yoneda.reads` comes later, since installed CLIs won't send it.
5. **Intent drift agent:** new managed agent comparing goal with diff. Needs change-level verdicts, because every finding must sit on a line today (`managed-instructions.ts:14`), and the body or plan passed to the harness. That means a **container rollout**: warn the owner first.

**Rollout, in this order:**

1. Wave 1: a binary that knows repo schema version 45 without applying it (the mechanism stage 5's `0044` brings). Every read answers as if no plan was filed, and filing answers `NOT_SUPPORTED`.
2. Wave 2: the binary that applies `0045`. Rollback goes to wave 1, never earlier.
3. Warn the owner, then roll the harness image with the managed Worker. Intent drift is off until a workspace enables it, and a change with no plan starts no container.

**Applied in one deploy on dev** (`claude/flight-e2e`): the owner chose one-deploy ships while prod has no users. `APPLY_THROUGH` is 45, so rollback goes only to a binary that knows entry 45.

## 8. Go-around

We don't build orchestration, so this is **pull, not push**: the platform never wakes an agent.

1. Open findings for a branch appear in `git_context` and `yoneda change show`.
2. The agent, or the person, reads them, fixes, and pushes.
3. Re-review on push already works and supersedes older runs.
4. A finding left unresolved blocks through the required-check route from stage 1.
5. **Watch two side effects:** each push drops human approvals, and each run adds up to 21 comments against a 2,000 cap, past which the post is refused.

## 9. CTC, Code Traffic Control

**CTC clears code for landing.** Rules only: it never writes code, assigns work or starts agents. Flight Path is the overall idea, Landings replace the pull request, and CTC decides.

| Job | What it does | State |
|---|---|---|
| Clearance | `platform_ctc::clearance` returns Cleared, Hold or GoAround with reasons, for one exact head | Built on `claude/tower-clearance` |
| Land when cleared | Per-repo switch: a cleared Landing lands with no one calling `git_land` | Built on `claude/tower-clearance`, off |
| Record | Each decision, with its reasons, head and inputs, in `changes.clearance`; newest 32 per Landing | Built on `claude/tower-clearance` |
| Traffic warnings | A session is told when an open Landing touches its files or symbols | Building, `claude/ctc-traffic` |
| Separation and hold | A Landing waits when one ahead touches the same files, and says why | Building |
| Sequencing | The order of Landings, from the queue | Building |
| Radar | One board of every open Landing | Building |

Conservative rules: a fork needs an approval of its head, a repo with no rules never auto-lands, drafts and any failed check hold, and High risk holds.

## 10. Order to reach prod

**2026-10-31:** with no users on prod, the owner chose to ship wave 1 and CTC together, which applies `0044` in one deploy. The two-wave rollback didn't apply to that ship; `0045` still ships later on its own.

Two schema changes, `0044` and `0045`, ship in two waves, so a rollback stays safe.

1. **Wave 1, on dev:** binaries accept both versions without applying them.
2. **Wave 2, after wave 1 is on prod:** merge `claude/tower-clearance`, which holds auto Landings, the rename, land when cleared and CTC; then `claude/landing-flight` from `5642f0b0`; then `claude/ctc-traffic`. Apply both migrations.
3. **Harness commit `2efe2984`** with wave 2: a container rollout for Intent drift.

Switches stay off on prod until each is watched on dev: `LAND_WHEN_CLEARED`, then per-repo settings.

## Verification

| Stage | Proof |
|---|---|
| 1 | A required managed check passes end to end |
| 2 | Evidence file per run; 5 per arm; delivery check passes in every run; verdict stated either way |
| 3 | Rust read tests, including a path-restricted token; browser check |
| 4 | Collaborator and public reader see the cards; Risk gives the same score twice |
| 5 | Installed CLI 0.2.0: push then `change create` still answers success |
| 6 | Switches off: behaviour identical, kit 22 of 22. On: push creates one Landing, costs no agent run, fork proposals still work |
| 7 | Rollback across both waves; old CLI unaffected |
| 8 | A finding reaches a new session through `git_context` |

The whole path, one Landing end to end: [flight-path-test-plan.md](flight-path-test-plan.md).
