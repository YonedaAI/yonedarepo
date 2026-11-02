# Handoff

Written 2026-11-01 at 22:50, at dev `8b3a6028` plus the GitHub import fix.

Rules for this work are in `AGENTS.md`. Plans are linked under each task.

## Bad news first

1. **Regions are not on.** Every repository still lives in the US, so the site's "global" claim is false.
2. **Your region rule isn't built.** Nobody gets a region at login, and nobody can change one.
3. **Dev isn't known to be green.** The last kit run failed 7 items, on older UI, and no full run has passed since.
4. **No complete UI walk has run on today's UI.** 30 frontend commits landed after the last one.
5. **Don't start subagents.** Claude's weekly limit reads 97%, which is the agent-usage STOP level. Check it first.

## What's running

| Agent or job | State |
|---|---|
| `cli-walk` | Stopped |
| `ui-walk` | Stopped; its worktree is gone |
| `demo-repos` | Stopped; its worktree remains |
| `global` | Idle |
| `clone-import` | Finished. Listed as running, but its last step was its handover |
| Dev deploy of `8b3a6028` | Finished, exit 0 |

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

**Done in code:** merged `claude/org-installs` (`df7525e5`): organizations can connect, and the dialog has Add another repository.

**Done in code:** the fix for your screenshots. A repository you already added says `Added`, and pressing it opens it. A typed address for one you have says "You already have rad-belden", with a link, and Add repository stays off. 176 shell tests pass, tsc and biome are clean.

Left to do:

1. Look at it in the served app, wide and 375 px, light and dark.
2. Connect a real organization. It needs D1 migration 13 applied by the deploy.
3. `Added` matches by owner and name, because a repository stores no import source. A different repository with the same name also reads `Added`. Store the source to make it exact.
4. `magnetonio/whisper` needs a re-import: 169 commits are unreadable. That's the owner's call.

## 2. Global

Plan: `docs/global-scale-plan.md`. Branch: `claude/global` (`cd997993`), 13 commits ahead, dev already merged in, nothing tested since that merge. Worktree: `.worktrees/global`.

| Stage | State |
|---|---|
| Europe's database, storage and queues | Created on dev |
| Europe Worker, edge Worker | Deployed, `edge.dev.yonedarepo.com` answers 200 |
| Edge kit | Failed twice: a local DNS failure, now clear, and a browser item. The fix is on `claude/global` |
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

Last full result, `.local/staging/realworld-1793577972479.json`, on the owner account: 27 pass, 7 fail.

| Item | Failure |
|---|---|
| browser | The Clone menu's HTTPS line |
| 31 | An old repository address moves to its readable one |
| 34 | Timed out waiting for a Landing to land |
| 35 | "Landed directly" isn't on the row |
| 38 | The clone commands aren't shown |
| 39 | A non-operator read revenue: 200. May only be the owner account |
| 42 | "Nothing has landed yet" at /changes |
| 41 | Not run: `AUDIT_LOG` is off |

Causes are unproven. The UI has changed since, and some text checks may simply be out of date. Never loosen a test to pass it. `Switch repository` matching 2 buttons is fixed on `claude/global` only.

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
2. Dev is ahead of `origin/dev` by at least 5 commits. Scan with `gitleaks git --redact`, run `pnpm check`, then push.
3. Prod: leave it until the owner says ship.
