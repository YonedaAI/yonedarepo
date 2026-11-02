# UI walk: findings and next run

Written 2026-11-01 at dev `73dba4ce`. Plan only: the next run has not started.

## Bad news first

1. **Every finding below is older than today's UI.** Both runs ended before 30 frontend commits landed (20:47 to 22:23). Nothing here has been measured again.
2. **The walk can't catch what the owner complained about most.** It has no check for type size, whitespace or colour contrast: 0 lines in the tools mention them.
3. **The checks aren't on dev.** They sit on `claude/ui-walk` (`b89dffc4`), not merged.
4. **Pressing controls happens at 1440 light only.** At 375 and in dark mode the walk only measures the page. The phone menu isn't opened.

## The two runs

| Run | Started | Account | Pages | Controls | Screenshots | Defects |
|---|---|---|---|---|---|---|
| `ui-walk-1793585697650` | 20:14 | kit | 49 | 266 | not counted | 37 |
| `ui-walk-1793587623655` | 20:47 | owner | 119 | 385 | 553 | 42 |

The owner run took 33 minutes. Repositories: `flight-click`, `flight-cobra`, `flight-commander`. `testing` wasn't there: the owner deleted it at about 19:06.

## What the walk measures

| Group | Rule | Fails when |
|---|---|---|
| Works | `dead-control` | Pressing a control changes nothing, or a link points at its own page |
| Works | `failed-request` | The page asks the server for something and gets a 4xx or 5xx |
| Works | `page-error`, `console-error` | The browser reports an error |
| Works | `false-zero` | A page claims nothing is there on a repository with files |
| Way around | `way-back` | The top bar has no way to Repositories |
| Way around | `way-out` | A mode you entered shows no way out without scrolling |
| Way around | destination map | A link lands on the wrong kind of page, or has no expected destination |
| Way around | `sidebar-current` | The sidebar doesn't mark where you are |
| Layout | `edge-left`, `edge-right` | A block doesn't reach the page's edges |
| Layout | `row-height`, `row-align` | Controls in a row differ in height or don't line up |
| Layout | `overflow`, `off-screen`, `sideways-scroll` | Text passes its box, or the page scrolls sideways |
| Layout | `text-into-control` | Text runs into a control |
| Layout | `heavy-border`, `row-border` | Borders are too heavy or differ along a row |
| Words | `line-length` | A line is over 76 characters |
| Words | `internal-word` | Internal names appear on screen |
| Empty states | `empty-table` | Headers over no rows, or a table of zeros |
| Notices | `notice-card`, unstyled class check | A notice isn't a floating card, or a class has no style |
| Keyboard | `select-ring` | A focus ring stays after a mouse press |

## Findings

Status is read from the code and commit dates, not from a new run.

| Status | Meaning |
|---|---|
| Open | The code is unchanged, so expect it again |
| Check | Later commits touched it, or the cause is unproven |
| Walk's error | The app is right and the check needs changing |

### Fix in the app

| # | Status | Where | Defect | Measured | Pages |
|---|---|---|---|---|---|
| 1 | Check | Top bar, 375 | The page name runs into the repository switcher | Overlap on every repository page | 71 owner |
| 2 | Open | Top bar | Account control is taller than its neighbours | 44 against 32 px at 1440, 40 against 32 at 375 | 116, 85 |
| 3 | Open | Top bar, 375 | Open navigation against the switcher | 32 against 30 px | 62 |
| 4 | Open | Top bar, 375 | Account control against the switcher | 40 against 30 px | 31 |
| 5 | Open | Agent tools and 4 other pages | `GET /api/managed/.../agents` answers 404. The section hides, so a reader sees nothing. Cause unproven | 404 | 5 owner, 3 kit |
| 6 | Open | Repository pages | `GET /api/v1/avatars/<account>` answers 404 for a kit account with no picture | 404 | 5 kit |
| 7 | Open | Repository settings | The `Landing needs` chip links to the page it's on | Self-link | 1 |
| 8 | Open | Branches | The `main @ v7` chip links to the page it's on | Self-link | 1 |
| 9 | Check | Overview | The repository name links to itself | Self-link | 3 |
| 10 | Check | Landing page | The Landing's own title links to itself | Self-link | 1 |
| 11 | Open | `/repositories` | Rail item Landings links to itself | Self-link | 1 |
| 12 | Open | `/settings` | Crumb Account links to itself | Self-link | 1 |
| 13 | Check | `/signin` | Top Sign in links to itself | Self-link | 1 |
| 14 | Check | `/agents/:id/configure` | Search box against Unselect all | 33 against 30 px | 1 |
| 15 | Check | `/admin/users` | Search against its box | 38 against 36 px | 2 |
| 16 | Check | `/admin/users/:account` | Suspend against its number box | 34 against 32 px | 1 |
| 17 | Check | Members | The row's items sit 5.4 px apart | 5.4 px | 1 |

### Line length: limit 76

| # | Status | Where | Longest line |
|---|---|---|---|
| 18 | Check | Session pages | 160 characters, 9 pages |
| 19 | Check | Landing description and summaries | 169, 3 pages; 152, 2 pages |
| 20 | Check | Memories | 161, 3 pages |
| 21 | Check | Agent run findings | 161, 2 pages |
| 22 | Check | Repository delete page | 121, 3 pages |
| 23 | Check | `/admin` | 89, 5 pages |
| 24 | Check | Tower | 89, 3 pages; 84 in the kit run |
| 25 | Check | Connect settings | 88, kit run |
| 26 | Check | Agent pages | 82 and 81 |
| 27 | Check | Home sessions empty state | 82, kit run |

Rows 18 to 21 are text people and agents wrote, in app pages. They need a reading width, not new words. Commit `8835c678` made pages full width after these runs, so these lines may now be longer.

### Probably fixed since

| # | Where | Defect | Fixed by, unproven |
|---|---|---|---|
| 28 | README at 375, 3 repositories | Raw `<div>` and badge text past its box by 14 to 286 px | `202f5534`, Markdown as GitHub does |
| 29 | `/signin` | Page starts at 32 px and 16 px | `fb3c3e33`, one card |

### Walk's errors

| # | Where | Finding | Why it's wrong | Change |
|---|---|---|---|---|
| 30 | `/admin/users`, `/admin/repos` | Search does nothing | The box was empty | Type a word first |
| 31 | `/admin` | Show does nothing | Dates were the defaults | Change a date first |
| 32 | `/admin/users`, `/admin/repos` | Search form ends at 820 px | A search box needn't span the page | Leave forms out of `edge-right` |
| 33 | `/admin/audit` | Load more ends at 428 px | A lone button needn't span the page | Leave lone buttons out |
| 34 | 22 pages | Top bar has no way to Repositories | The sidebar counts | Accept the sidebar |
| 35 | `/admin/repos`, `/orgs/:org` | 404s after row links | Other runs deleted those repositories and orgs while the walk ran | Ignore a target that a second read says is gone |
| 36 | `/signin` | Features and Company do nothing | Kit run only, and the walk may not have let the menu open. Unproven | Check by hand once |

### Needs a decision in code

`GET /api/v1/repos/:id/hold` answers 403 on `/source/explore` and `/admin/repos` (`LegalHold.tsx:21`). If a reader who isn't an owner asks for it on every view, the page should skip the call. This is unproven.

## Next run

Goal: one complete run on the UI as it is now, with the owner's top complaints covered.

### Before it runs

1. Merge `claude/ui-walk` into dev, resolving against the 30 commits.
2. Run its targeted test: `tests/runtime/ui-walk.test.mjs`.
3. Apply the six check changes from rows 30 to 35.
4. Add these checks:

| New check | Fails when |
|---|---|
| Type size | Body text under 14 px, labels under 12, page titles off the measured scale in `theme.css` |
| Whitespace | Gutter other than 24 px; a gap over a set limit between sections |
| Contrast | Text under 4.5:1, in light and dark |
| Text overlap | Two text boxes cross: the case `clone-import` found by eye |
| Phone menu | At 375, the menu won't open, or any item in it fails |
| Press at 375 and dark | Run the control sweep at all 4 views, for the shell and one repository |
| Stay on branch | Pick a branch, move between Overview, Files and Commits, and it stays |

5. Keep a baseline. Save each page's text sizes from this run, so the next run fails if the site shrinks.

### The run

| Setting | Value |
|---|---|
| Target | dev only, on one deployed revision |
| Account | Owner's dev account |
| Repositories | `flight-click`, `flight-cobra`, `flight-commander` |
| Budget | 45 minutes; stop and report at the limit |
| Models | None: item 47 uses no model |
| Writes | None: the guard holds every write in the browser |
| Sessions | One long-lived browser session, because over 10 evicts the owner's browser |
| Alone | No deploy, kit, burst or builder test during it, or findings go stale and targets vanish |

```
set -a; . ~/.config/yonedarepo/dev-owner.env; set +a
KIT_USERNAME=$DEV_OWNER_USERNAME KIT_PASSWORD=$DEV_OWNER_PASSWORD \
  node tools/staging-realworld.mjs --ui-walk --ui-repos flight-click,flight-cobra,flight-commander
```

### After it

1. Read `failures.txt` and the `destinations.txt` map.
2. Look at the 375 and dark screenshots at full size.
3. Compare each row above: gone, still open or new.
4. Fix rows 1 to 4 first: they sit on nearly every page.
5. Run the walk again until it reports 0 defects.

### Done means

| Check | Target |
|---|---|
| Run finished inside its budget | Yes |
| Pages and controls | At least 119 and 385 |
| Defects | 0, or each one named with a reason |
| Rows above | All marked gone or open |

Still needs eyes: a passing walk proves rules, not taste. Comparing against Entire stays a look at screenshots.
