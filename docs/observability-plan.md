# Observability plan

Status: plan, not built. Written 2026-10-31 at dev `688d46df`. Companion to `docs/analytics-plan.md`.

Analytics asks whether people are using this. Observability asks whether it's working, and if not, why.

## What this answers

1. **Is it up?** Before a user tells us.
2. **Who's told?** A person, within minutes.
3. **Why did it fail?** One id follows a request from browser to container.
4. **What changed?** Every problem can be tied to a release.
5. **Is the code getting worse?** Tracked over time, not checked once.

**Bad news first:**

| Gap | Evidence |
|---|---|
| The prod monitor has never run | `deploy-prod.yml` has 0 runs on GitHub, and `ship.yml` isn't registered |
| Unexpected API 500s log no text | `repo-api.ts:523`; the tail counts them and keeps nothing |
| Nothing reliably reaches a person | One digest email, tested only against a fake, off on dev, with no check that it's alive |
| No request or correlation id | None generated; a failure can't be followed across Worker, Durable Object, queue and container |
| Large blind spots | Superfan misses crons, 5 Durable Object classes, the front and managed Workers, `land_queue` and the checks backlog |
| Billing mismatches go unseen | The nightly reconcile only logs, in a Worker nothing tails |
| No release marker | No deploy record, so a metric can't be tied to a commit |
| No frontend or panic capture | `AppErrorBoundary` reports nothing; Rust panics have no hook |
| Almost nothing is tracked over time | 53 files break the 300-line rule unenforced; no coverage, flake, bundle or Wasm tracking; `gitleaks` isn't in CI |

## Built on what we already run

Staying on Cloudflare. No Sentry, Datadog or other third party.

| Need | Use |
|---|---|
| Logs | Workers Logs, already on |
| Live signals, findings, digest | Superfan, extended |
| Counts and latency | Analytics Engine, shared with `docs/analytics-plan.md` |
| Outside view | Cloudflare Health Checks and Notifications, or a small cron probe: spike first |
| Dashboards | The Infrastructure tab from the analytics plan |

Rules:
- Logging can't fail or slow a request.
- No secrets, tokens, repository contents or email addresses in logs. Fields are allow-listed.
- No network I/O in a transaction.
- New paths sit behind a switch where they touch the request path.
- Prices and limits for Workers Logs and Notifications aren't in our docs: check before relying on them.

## O1 request budget

Written before the code. What a healthy request may spend on O1, with `REQUEST_IDS` and `CLIENT_ERRORS` on. With them off (the default) it spends one object per request, in the `AsyncLocalStorage` store the request already has for `waitUntil`.

| Item | Budget |
|---|---|
| Added subrequests, Durable Object round trips, queue sends, D1 or R2 reads | **0** |
| Added log lines on a healthy request | **0** |
| Added CPU per request | under **50 µs** at the entry Worker, measured in workerd |
| Added bytes per hop | one `x-request-id` header, at most 64 bytes of value |
| Added bytes per queue message | one `request_id` field, at most 64 bytes |
| Added Wasm calls per Durable Object request | one header read |

Measured in local workerd over 5 rounds of 20,000: a request costs about 1 µs bare, 3 µs with `REQUEST_IDS` off, 5 µs on with three hops, and forwarding a `Request` over a binding about 3 µs more. Not yet measured on dev.

Failure paths are not on that budget: a line is written only when something already went wrong, at most 4,000 characters, and never awaited. `POST /api/client-error` is rate limited per address and takes at most 2 KB.

## Phase O1: See failures

1. Log every unexpected 500: operation, error code, repository id, revision.
2. One shared logger with one JSON shape: level, event, request id, repository, job, revision. Move all 92 `console.*` calls onto it; a test refuses new bare ones in `cloudflare/`.
3. A request id starting at the edge (`cf-ray` if it survives every hop), carried through bindings, Durable Objects, queue `Envelope`s and containers, and returned on every response. Error screens show it, so a user can quote it.
4. Review the 176 catch sites with empty or discard forms: each logs, or carries a comment saying why not.
5. Capture frontend errors: `AppErrorBoundary` and `window.onerror` send to our own origin. Message and route only, never page content.
6. A panic hook for the Rust Wasm, so a panic logs before `rustCall` resets.
7. Confirm container output reaches Workers Logs. `logging.md:21` claims it, unverified.

## Phase O2: Tell a person

1. Turn Superfan on for dev and force a real alert end to end.
2. A dead-man check: if Superfan stops, something outside it says so.
3. Close the blind spots: crons, the 5 Durable Object classes, front and managed Workers, `land_queue`, checks backlog.
4. Add signals: reconcile mismatches, compaction stalls (built in `archive-stage-a`), storage at 8 and 9 GB, dead letters on every queue, failed crons.
5. Two levels: **urgent** sends at once (site down, money mismatch, data at risk); **digest** waits.
6. `docs/incidents.md`: what each alert means, the first check, how to roll back.

**Your call later:** email only, or a second channel for urgent alerts.

## Phase O3: Ship with a net

1. Register `ship.yml` and run the whole ship pipeline once against dev, so its first real run isn't on prod.
2. A deploy ledger: commit, time, environment, who. `--tag` and `--message` on each deploy, so Cloudflare's versions name their commit.
3. Findings carry the revision. After a deploy, compare error rate and latency with the release before.
4. Synthetic checks every few minutes, on dev and prod: `/health`, a page, a public clone, an API read. A landing on a probe repository on dev only at first. Probe traffic is marked as our own.
5. Rollback drill on dev: time it, and write down the result.

## Phase O4: Find what's slow

1. Sample `Server-Timing` spans into logs and Analytics Engine, per operation.
2. Spike Cloudflare's Workers tracing: does it follow bindings and Durable Objects? Use it if so.
3. Service targets for API reads, landings, Git clone and push, and repository create. **Measure for 30 days first**, then set them: no invented numbers.
4. Show targets, current values and error budget on the Infrastructure tab.

## Phase O5: Code health over time

Enforce, then track.

| Item | Change |
|---|---|
| 300-line rule | `cargo xtask` check: today's 53 files become a list that can only shrink, and no new offenders |
| Secret scan | `gitleaks` in CI |
| Migration drift | A CI step, so it's caught before runtime |
| Deep differential | The 100×200 run nightly, not ignored |
| Test timing and flakes | Keep results; flag tests that fail then pass, and tests that slow down |
| Wasm and bundle size | Budgets in CI; a jump fails the check |
| Dependencies | Report how far behind we are |
| Coverage | Measure once, then decide |
| Live results | Compare each run with the last; flag a slower or newly failing item |
| Evidence | Trim `.local/staging` (395 MB) to the runs that matter |

Tracked values go in `.local/health/` on the Mac, with a summary table in `docs/`. CI logs are public, so no account names or repository ids there. Every push runs about 9 jobs, so anything nightly must be small.

## Order

| # | Phase | Why here |
|---|---|---|
| 1 | O1 | Everything else needs readable failures and an id |
| 2 | O2 | Then someone is told |
| 3 | O3 | Before the first prod ship leans on it |
| 4 | O5 | Independent, and can run alongside |
| 5 | O4 | Needs analytics Phase 1's durations |

O1 and O5 can start now. The analytics plan's Phase 7 reads from O1 to O4.

**Risk to know:** until O2 and O3 steps 1 and 2 are done, a prod deploy has no working alarm.

## Verification

| Phase | Proof |
|---|---|
| O1 | A forced 500 appears with its id in Workers Logs, and that id finds the Durable Object, queue job and container lines |
| O1 | A forced frontend error and a forced panic each appear; no secret appears in any log, checked by test |
| O2 | A forced failure reaches a person within 5 minutes; stopping Superfan also alerts |
| O3 | The ship pipeline runs end to end on dev; a broken deploy on dev is caught and rolled back, with the time recorded |
| O4 | A slow operation is found from its id alone |
| O5 | A new 301-line file, a planted fake secret and a Wasm jump each fail the check |

## Critical files

| Area | Files |
|---|---|
| Errors and logs | `cloudflare/worker/repo-api.ts`, `background.ts`, `platform-entrypoint.ts`, `repo-compute.ts`, `frontend/src/components/AppErrorBoundary.tsx` |
| Superfan | `cloudflare/superfan/tail.ts`, `signals.ts`, `watch.ts`, `notify.ts` |
| Deploys | `xtask/src/deploy_exec.rs`, `deploy_live.rs`, `.github/workflows/`, `docs/ship-pipeline.md` |
| Code health | `xtask/src/`, `.github/workflows/ci.yml`, `full.yml` |
| Evidence | `tools/fanout-bench/results.mjs`, `tools/staging-realworld.mjs` |
