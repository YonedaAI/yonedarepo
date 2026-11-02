# Repository Insights plan

Status: plan, not built. Written 2026-11-02 at dev `5ff0196a`. It builds on `docs/analytics-plan.md`, which covers platform-wide analytics; this file covers one repository's page.

## What the page answers

1. Did this repository's work land safely?
2. What did that work cost?
3. Which agent ships the cleanest code for the least money?

Entire's Analytics shows how much agents did. This page shows whether it landed. It stays one page, Insights, and needs no second tab.

## Where we stand

| Number | Today |
|---|---|
| Landed in a range | Stored and served, 90 days, misses direct pushes |
| First-try rate, holds, go-arounds | In `changes.clearance`, only with Land when cleared on, newest 32 decisions, counts state changes |
| Median time to land | Derivable per repository |
| Slop, Intent drift | Stored per commit in `checks.evidence.value` |
| Risk | Not stored, computed on read |
| Memories delivered | Stored per session, with no repository-wide read |
| Memory followed | Not collected, and "trap" exists only in the test kit |
| Managed agent tokens and cost | Stored in `runs` |
| Coding session tokens and cost | Not collected: `sessions` has no such column and the CLI drops them |
| Agent vs human commits | Derivable, but a plain `ypat_` token reads as a person |
| Lines by agent | Not collected |

`REPO_ANALYTICS` and `AGENT_REPORT` are set nowhere, so `/insights` answers NOT_FOUND. Every view already wakes one Durable Object for the access check.

## Decisions

1. **One row per Landing, in the repository's authority.** A new `landing_facts` table holds opened and landed times, first try, go-arounds, holds, Risk, Slop, Intent drift, agent, model, tokens, cost and memories delivered. It is written in the landing's transaction, so no network I/O and no double counting. The page already wakes this Durable Object, so it adds no wake.
2. **Analytics Engine stays for traffic.** Clones and pushes keep coming from there. Basin can't serve this page: it starts at head, with no history.
3. **A number shows only when it is true.** No `0.0k`, no "0 checkpoints in 2 commits". An empty section is one line. A figure we can't know reads as not reported, never as 0.
4. **Cost is labelled.** Managed agents show what was charged. Coding sessions show an estimate from the public price list in `shared/managed-agents.ts`.
5. **We don't claim "followed".** The page shows memories delivered, and Landings that changed a file a delivered memory is anchored to. Traps stay in the test kit until an agent reports use itself.

## Request budget

| Path | Budget |
|---|---|
| `GET /insights` | 1 authority call and 1 Analytics Engine query, under 300 ms server side at 10,000 Landings |
| Landing | 1 extra insert in its transaction, under 2 ms |
| Backfill | 200 Landings a call, safe to repeat |

Bench on the flight repositories and the 1,000-writer burst: 3 runs, server-side timing, min, median and max.

## Page

| Section | Shows |
|---|---|
| Headline | One sentence: "12 of 15 Landings cleared this week. 2 go-arounds." |
| Landings | Landed, first-try rate, median time to land |
| Tower | Holds, go-arounds by reason, conflicts caught before landing |
| Instruments | Risk, Slop and Intent drift over time |
| Agents | Each agent and model: sessions, Landings, first-try rate, go-arounds, Slop, tokens, cost per Landing |
| Cost | Tokens and dollars per Landing, in total and over time |
| Memory | Memories delivered, Landings that touched an anchored file |
| Who | Agent vs human commits, top contributors |
| When | Peak hours and weekday pattern, in the viewer's time zone |

The range picker keeps 24 hours, 7, 30 and 90 days, with back and forward added. Everything follows the UI rules in `AGENTS.md`.

## Phases

| # | Work | Proof |
|---|---|---|
| 1 | Set `REPO_ANALYTICS` and `AGENT_REPORT` on dev | Insights appears on the 3 flight repositories |
| 2 | Migration `0049`: `landing_facts`, written at landing, with `cargo xtask admin landing-facts-backfill` | Counts match `landings` on 3 repositories; replay adds nothing |
| 3 | Headline, Landings, Tower, Instruments | Numbers checked by hand against one flight repository |
| 4 | Session tokens: an optional `usage` on `session record`, read from the Claude Code transcript first, then Codex and opencode where they report it | A real session shows tokens matching its transcript; a session without usage reads as not reported |
| 5 | Agents and Cost | Two agents on one repository read differently; managed cost matches `runs` |
| 6 | Memory, Who, When | Delivered counts match `context_deliveries` |
| 7 | QA walk: every section empty, loading, error and full, and a check that no two figures contradict each other | Wide and 375 px, light and dark |

Phases 2 and 4 are additive. Migration `0049` follows the one-wave rule: once a repository runs it, an older build refuses that repository.

## Open

- Whether Codex and opencode expose token usage to hooks. Claude Code's transcript has it; the CLI ignores it today.
- Lines by agent need counts in `commit_paths`. Left out until someone asks for them.

## Related UI work

From reading Entire's pages on 2026-11-01:

1. Drop the large repository heading from sub-pages: the top bar trail is the title.
2. One denser type scale, and one toolbar row: view name, filter, search, one primary button.
3. A real repository Overview: latest commit, View all files, Activity, Contributors, README.
4. Commits: a day band with a count, a branch filter, files changed.
5. Gates: a live preview of how rules affect a Landing, Reset approvals on push.
6. Delete branch after merge, recorded on the Landing.
7. Dispatches: a shareable summary of agent work, built from `landing_facts`.
