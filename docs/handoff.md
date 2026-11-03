# Handoff

Updated 2026-11-03. This section supersedes the historical handoff below.

## Current work

Dev deployment `5bb293ee` completed, including its deployment smoke and the
regional monitoring fix. The routing/loading measurements below were taken at
`c8d6d9ae`; application routing code is unchanged by that monitoring/docs wave.
Production still serves `de317bbda605`;
source merges and resource preparation are not a production promotion. The
latest production workflow did not complete its watch.

| Task | Current evidence and next step |
|---|---|
| Repository loading | Overview, immutable content reuse, early Markdown, edge-first bytes, Search reuse and recent Versions are deployed. New Versions paging and selected-revision UI passed. Current repeat Overview is 494–762 ms (562 median), fresh-context Overview 1,049–2,226 ms and Agents 1,123–1,319 ms. Speed remains open. Transport/startup also changed; the dated measurements do not isolate a code regression. See the new validation report. |
| SSH | The production clone/push/revocation smoke passed. Lifecycle failures remain under investigation; they are not evidence that the same percentage of Git operations failed. Alert wording is repaired on dev. |
| Flight Path demos | Commander's repair and second-account approval phases landed with exact-head reviews. Independent native acceptance passed 8/8 groups, 21 CLI observations and 39/39 authored tests on the approved snapshot. Six Click coding heads and final functional acceptance remain. Temporary policy/settings were restored and run credentials/containers cleaned up. Retained history is preserved. See the [agentic coding proof](flight-path-agentic-proof-20261103.md). |
| Release | A fresh CLI walk and full kit at the final dev tip remain required. The older 34/35 kit result cannot accept current source. Then push dev, record live-tests, open the ship PR, pass its checks, merge, watch production and run the Mac smoke. |
| Global locality | Global entries now select six API destinations from original caller geography. Dev observed IAD/FRA/SIN/SYD/GRU/CPT in three samples each; EU forwarding and retained authority/ref/history state stayed correct. Two new fixtures followed the observed US caller. The shared sign-in counter passed across all six aliases and the entry. Three independent 1,000-writer runs passed every commit, landing and exact readback; temporary tokens were revoked. These are not worldwide speed or universal storage-residency proof. |
| Regional monitoring | The fix is deployed on dev after 131 runtime and 68 infrastructure cases. Actual EU resource resolution and telemetry reads passed. Customer HTTP denominators stay unchanged. Shared customer death-point attribution is still limited; live telemetry access is separate from end-to-end alert-delivery proof. |
| Analytics | Site/platform traffic analytics is enabled in dev and prod. Per-repository usage analytics remains off. Contribution drill-down is implemented on dev; it is separate from usage analytics. |
| Basin change history | Dev's primary pipeline and SQL are working: 14 existing versions and five landings match the authority, with zero drift. EU is unbound; production and the seven-day soak are not validated. See the [dated validation](basin-dev-validation-20261103.md). |
| Organization members | Handle and exact-email lookup, add/remove behavior and access boundaries have dev evidence. The tidied organization view is on dev. |

The current global rule follows the requesting human or agent's location, not an
account region picker. New unrestricted repository objects use nearby placement;
an existing object's home does not move merely because Workers are unpinned.
US/Europe copy validation does not prove EU-only residency or GDPR compliance.
A real Asian-client placement check is explicitly deferred by the owner.

New proposed work: [shared repository indexes and global discovery](global-search-index-plan.md)
and [a controlled regional performance baseline](regional-performance-baseline-plan.md).
These plans reuse the real indexes already implemented. They do not implement a
new indexer or authorize a rollout. The earlier placement figure changed compute
while data stayed in US East; it did not compare two complete local-data stacks.

Current evidence: [global routing and loading validation](global-routing-validation-20261103.md),
[dated performance figure](performance/2026-11-03-global/global-routing-validation.png)
and [regional monitoring coverage](regional-monitoring.md). Read p95 under the
three bursts was 1,703 / 2,807 / 1,569 ms; correctness passed, subsecond loaded
reads did not. The earlier 424 ms Overview observation remains in its dated
snapshot rather than being presented as the current result.

The broad automated-QA expansion is paused. Continue feature acceptance and the
required release checks. Preserve activity/contributors above the Overview README;
optional activity must not block the repository header, files or README text.

The [admitted Overview snapshot](overview-admitted-snapshot-budget.md) is locally
verified but off in both environment declarations. It removes a redundant
published-head selection lookup after fresh admission, with existing tree reads
unchanged. A controlled dev comparison is still required before enabling it.

For retained demos, reserve maintained review maxima before each new head, run
stock coding agents only in the Docker sandbox, and request reviews at the exact
captured head after coding exits. Preserve the original $2.90 managed-review cap.
Do not start paid coding while any source worktree or remote is changing. Restore
temporary repository policies, revoke temporary tokens and verify host/remote
state afterwards. An owner-requested review is not automatic-trigger evidence.

Private run receipts and the changing work ledger are under
`.local/implementation-20261103/`; do not publish their account or monitor data.

Future proposal: [local Rust repository service](local-repository-future.md).
This records a possible Git-compatible local mode; no implementation is authorized.

## Historical handoff

The following records the earlier state and superseded plan. It is retained for
context, not as the current task list or deployment evidence.

Written 2026-11-01, corrected 2026-11-02, at dev `a86ce1f0`, deployed to dev.

Rules for this work are in `AGENTS.md`. Plans are linked under each task.

## Earlier gaps

1. **Regions are not on.** Every repository still lives in the US, so the site's "global" claim is false.
2. **Your region rule isn't built.** Nobody gets a region at login, and nobody can change one.
3. **Dev isn't proven green.** The last full kit on dev, at 18:32, was 33 pass and 1 fail, before tonight's UI work. Nothing since has re-run it.
4. **No complete UI walk has run on today's UI.** 30 frontend commits landed after the last one.

## What's running

| Agent or job | State |
|---|---|
| `cli-walk` | Stopped |
| `ui-walk` | Stopped; its worktree is gone |
| `demo-repos` | Stopped; its worktree remains |
| `global` | Idle |
| `clone-import` | Finished. Listed as running, but its last step was its handover |
| Dev deploy | Finished, exit 0: `45b765b3` is live |

## Order of work

1. Check GitHub org installs live.
2. Global: run the edge kit, then turn regions on.
3. Build the region rule.
4. Merge the UI walk and run it.
5. Run the full kit and fix what's red.
6. Finish the demo repositories.
7. CLI: final walk.
8. QA agent.
9. Features: Insights, then the Entire list.

## 1. GitHub import

**Review of 2026-11-02, open defects in the import dialog:**

| # | Defect | Source |
|---|---|---|
| 1 | Typing a repository's full name starts its import with no Enter. Typing `MagnetonIO/agent` on the way to `agent-vault` would import the wrong one if both exist | Code: the effect on `pickedId`. Not run, as it would start a real import |
| 2 | A public GitHub repository picked from the list is imported private, without saying so | Code: `visibility` defaults to private |
| 3 | Typing `owner/part` shows the name, visibility and Add repository for a repository that may not exist | Code: `showsDetails` |
| 4 | Search text left before the list loads shows the red address error | Code: `badAddress(source, connected)` |
| 5 | `Added` needs `role: 'owner'`. Whether an org's repositories answer that is unchecked | Code |

**Merged and deployed, not tried:** `claude/org-installs` (`df7525e5`): organizations can connect, and the dialog has Add another repository.

**Done and live:** adding from GitHub shows only the repository field and the list. Name, visibility, branch and the buttons appear only for a typed address, or always on Add public repository.

**Done and live:** the fix for the "already has a repository" error. A repository you already added says `Added`, and pressing it opens it. A typed address for one you have says "You already have rad-belden", with a link, and Add repository stays off. 177 tests pass, tsc and biome are clean. Seen on dev at 1440 dark: list, opening, and the typed address. Seen at 375 light: the list only, with no sideways scroll.

Left to do:

1. Connect a real organization. It needs D1 migration 13, which the deploy applies.
   Also unproven on real GitHub: Add another repository's page, the real browser's return to the tab (the test sent its own `focus` event), the org fallback address (from memory, not GitHub's docs) and the "requested" message, which nobody has viewed.
2. **Org connect no longer needs an owner or an approval.** The App asks GitHub whether the linked user is on a repository of the install, using only the permissions it already has. Tested on a personal install: 204 for the owner, 404 for a stranger. **Not yet proven on a real organization.** See `docs/clone-import.md`.
3. `Added` matches by owner and name, because a repository stores no import source. A different repository with the same name also reads `Added`. Store the source to make it exact.
4. `magnetonio/whisper` needs a re-import: 169 commits are unreadable. That's the owner's call.

## 2. Global

Plan: `docs/global-scale-plan.md`. Branch: `claude/global` (`cd997993`), 13 commits ahead, dev already merged in, nothing tested since that merge. Worktree: `.worktrees/global`.

| Stage | State |
|---|---|
| Europe's database, storage and queues | Created on dev |
| Europe Worker, edge Worker | Deployed, `edge.dev.yonedarepo.com` answers 200 |
| Edge kit | Last run 21:55: 7 pass, 10 fail, 15 skipped. 8 fails are local DNS, now clear. `browser` has its fix on `claude/global`. Item 40 timed out and is unexplained |
| Regions on (`bound: true` in `infra/envs/dev.json`) | On `claude/global`, not merged |
| Region choice on New repository, region under General | On `claude/global`, not run live |
| Kit item 49, cell bench | On `claude/global`, not run |
| Latin America client | Deployed, answers 403, so unproven |

Steps:

1. In `.worktrees/global`, run the targeted tests: `tests/workers/cells-flow.test.ts`, `tests/runtime/region-tools.test.mjs`, the `xtask` infra tests.
2. From that worktree:
   ```
   set -a; . ~/.config/yonedarepo/deploy-dev.env; . ~/.config/yonedarepo/staging.env; set +a
   node tools/staging-realworld.mjs --api https://edge.dev.yonedarepo.com
   ```
   Log to a file and gate on the exit code.
3. If it passes, merge `claude/global` into dev and deploy with `--allow-active`.
4. Run item 49 and `tools/platform-cell-bench.mjs`.
5. Create a repository in Europe. Confirm its id has the `eea001` tag and that it clones and lands.
6. Fix the Latin America client's 403, then measure from there.
7. Change the site's words only after step 5 passes.

`claude/global-sim-off` (`e84a1b5d`, 1 commit ahead) turns `REGION_HINT_TEST` off on dev. Merge it, or check that `claude/global` has it, before deleting it.

### Your region rule

Owner's words: users and agents get a region from their location at login, or can change it.

| Part | Today |
|---|---|
| Region from location at sign-up | Built: `signupRegion`, `cloudflare/worker/accounts.ts:225`. Continent only, and needs `REGION_SIGNALS` on |
| Region from location at login | **Not built** |
| Existing accounts | All `enam` |
| Changing an account's region | **Not built.** The plan says it's fixed at sign-up |
| Repository's region | Chosen at create, then fixed: it's in the id |
| Agents | Run under a person's account, so they follow that account |
| Only one extra region | `weur`. `apac`, `sam`, `oc` and `afr` have no cell, so they fall back |

Build, after regions are on:

1. Store the account's region as a preference, set from the request's continent at first login if it was never chosen.
2. Add Region to account settings; a change applies to new repositories.
3. Use it as the default in New repository and in `yoneda` and agent creates.
4. Existing repositories stay put. Moving one needs a copy to a new id, which is separate work.
5. **Decide:** whether the account's own home cell moves too. It holds sessions and tokens, and `docs/global-scale-plan.md` treats it as fixed. Keep it fixed unless a change proves too slow.

## 3. UI walk

Findings and the next run's plan: `docs/ui-walk-findings.md`, with 36 numbered rows.

Branch `claude/ui-walk` (`b89dffc4`), 12 commits behind dev. Worktree removed. Follow "Before it runs" in that file: merge, apply 6 check changes, add 7 checks. The biggest gap: it measures no type size, whitespace or contrast.

Start with rows 1 to 4: they're on nearly every page.

## 4. Kit

Last full result on dev, `.local/staging/realworld-1793579550489.json`, 18:32: 33 pass, 1 fail, 41 not run.

| Item | State |
|---|---|
| 39 | A non-operator read revenue: 200. Failed in the 18:06 run too. May only be the owner account, unproven |
| 41 | Not run: `AUDIT_LOG` is off |

The UI has changed a lot since. Run the full kit at the tip before trusting this. Never loosen a test to pass it. `Switch repository` matching 2 buttons is fixed on `claude/global` only.

The kit has no browser test of the import dialog: nothing in `tools/` opens Add GitHub repository or Add public repository. Add one.

## 5. Demo repositories

Branch `claude/demo-repos` (`fe922fe6`), 16 commits ahead, 81 behind. Worktree `.worktrees/demo-repos` remains.

| Repository | State |
|---|---|
| `flight-cobra` | Done |
| `flight-click` | 6 Landings |
| `flight-commander` | Partial |

1. Finish with Claude, Codex or GLM, no MiMo. Real agents run only in the Docker sandbox.
2. Merge the kit changes, or drop them if they aren't needed.
3. Remove the worktree and branch.
4. Revoke the gateway token, and remove `model-proxy` and its `.local` env file.

**The MiMo proxy Worker is gone.** `yonedarepo-dev-model-proxy` answers 404, and 0 of the account's 19 Workers have proxy, model or gateway in the name. The earlier delete had worked, or the Worker went another way: my "failed" report was wrong.

## 6. CLI

CLI 0.3.2 is released. The last `cli-walk` count was 196 of 198, before its fixes. Rerun:

```
node tools/staging-realworld.mjs --cli-walk
```

Then record the result. Isolate `HOME` and never print `yoneda auth token`.

## 7. QA agent

You asked for this so you stop catching defects by hand. The walk is half of it.

1. The walk, with the new checks (section 3).
2. A model reviews screenshots against the UI rules. Use the cheapest model that passes.
3. It runs by itself after each dev deploy and reports defects.

No platform code: it's a tool beside the kit.

## 8. Features not started

| Feature | Where |
|---|---|
| Insights: Flight Path first, Agents section | `docs/insights-plan.md` |
| Platform analytics | `docs/analytics-plan.md` |
| Gates preview | Entire list |
| Reset approvals on push | Entire list |
| Delete branch after merge | Entire list |
| Dispatches | Entire list |
| Public session sharing | Entire list |
| UI as clean as Entire | Ongoing: bigger text, less whitespace |

## Clean-up

1. Delete merged branches: `claude/display-name`, `claude/gfm`, `claude/org-installs`, `claude/ui-pass`.
2. Dev is 25 commits ahead of `origin/dev`. Scan with `gitleaks git --redact`, run `pnpm check`, then push.
3. Prod: leave it until the owner says ship.
