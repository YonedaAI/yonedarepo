# Incidents

What each alert means, the first check, and the way out. Alerts come by email from Superfan (`cloudflare/superfan/`) and the dead-man (`cloudflare/superfan/deadman.ts`). A mail says what's wrong in plain words; each row below starts with those words, then the signal name `GET /findings` shows. Mail wording lives in `cloudflare/superfan/mail-copy.ts`.

`WATCH_WIDE=on` and the dead-man are set for both environments; prod gets them at its next ship.

## Roll back

```sh
cargo xtask rollback --env prod --confirm
```

[ship-pipeline.md](ship-pipeline.md#rollback) has the steps and what a rollback does not undo. Nothing rolls back on its own. Dev: fix forward, or `--env dev`.

## Reading an alert

| Need | Where |
|---|---|
| All open findings | `GET /findings` on Superfan, bearer `SUPERFAN_READ_TOKEN`. Each names `revision`, the release it began on, and `last_revision` |
| What changed | `GET /deploys`, same bearer: commit, times, environment, who, outcome |
| What the synthetic checks saw | `GET /probes`, same bearer: each result, with the request id of a failure |
| Is Superfan itself healthy | `GET /status` on Superfan, same bearer; `GET /heartbeat`, no bearer |
| The log lines behind a count | Workers & Pages → the Worker → Observability, filter on `event` |
| Live | `pnpm exec wrangler tail yonedarepo-<env>-platform --format json` |

## Levels

| Level | When it mails | Limit |
|---|---|---|
| **Urgent** | At once. A quick pass checks every 5 minutes; dead letters show up a few minutes late, as analytics do | Own limit per signal: 1 per 30 minutes, 6 per UTC day. The digest cap never holds one. One mail per outage while it stays down |
| **Digest** | After the hourly pass (minute 7) | 8 digests per UTC day. The rest wait |

Counted log events stay open for 20 hours after the last one, because some are logged only once. A quiet finding closes itself. `/health` needs 2 failures 2 seconds apart.

## Urgent alerts

| Alert | Means | First check | Way out |
|---|---|---|---|
| API health check failing (`api_worker health`) | Platform `/health` isn't answering 200 as `yonedarepo-platform`: API, Git and MCP may be down | `curl -i https://api.<env>.yonedarepo.com/health`, then its Observability errors | New since the last deploy: roll back |
| Website health check failing (`front_worker health`) | The site isn't answering 200 as `yonedarepo` | `curl -i` the site's `/health`; check the route and the front Worker's errors | New since the last deploy: roll back |
| Billing mismatch with Stripe (`billing reconcile_mismatches`) | Stripe, a ledger and the rollup disagree | Managed Worker logs, `event = billing.reconcile.mismatch`: account and `problem`. Nothing has changed money: the reconcile only reads | Don't refund or rerun until explained. Stop charges if money is moving wrongly |
| Repository history reached its limit (`storage storage_full`) | A repository's database reached 9.4 GB: new commits and Landings are refused, reads and deletes go on | Platform logs, `event = repo.full` or `repo.storage`, for the repository; admin Repositories page | `docs/runbook.md`, "Repository database size". Vacuum or split; accepted work is still finishing |
| An audit event cannot be read (`derived_jobs audit_event_corrupt`) | A repository's event row can't reach its org's log. Nothing is lost: it and later events stay in the repository, and its erase waits. The finding names the repository and event | The mail, or `GET /findings`: `<repo> event <seq>`. Platform logs, `event = audit.event_corrupt` | [Audit events](#audit-events) |
| A repository erase is held up (`derived_jobs audit_erase_blocked`) | The audit log hasn't taken a deleted repository's events for over an hour. Nothing is lost, and its objects are already gone. The finding names the repository and oldest event | Platform logs, `event = audit.repo_copy_failed`: why the copy failed | [Audit events](#audit-events) |
| Repository past 9 GB (`storage storage_9gb`) | A repository's database is past 9 GB. New work stops at 9.4 GB | Platform logs, `event = repo.storage`, for the repository; admin Repositories page | `docs/runbook.md`, "Alerts" and compaction. Vacuum or split before it fills |
| Background jobs failed (`derived_jobs dead_lettered`, `dead_letter_backlog`) | A platform job gave up after its retries. The queue is shared with checks | Platform logs, `event = job.failed`. Dead letters have no consumer and expire with the queue's retention | Fix the cause, then requeue by hand before they expire |
| Jobs queue had no consumer (`derived_jobs delivery_gap`) | No consumer ran or started for over 60 s while jobs waited, and they waited over 15 s. Normal gaps are under 15 s. Landings and webhooks ran late. The mail names the queue, the gap and what waited. Seen 5 to 10 minutes after it ends. Off the wide watch it's a digest | `GET /findings` for the gap, then the queue in Workers & Pages → Queues. Was a deploy under way? | It has recovered by the time you read this. A repeat with no deploy is Cloudflare's delivery: keep the finding as evidence |
| Check runs failed (`check_runs dead_lettered`) | A check run gave up | Platform logs, `event = job.failed` | As above |
| Managed agent runs failed (`managed_worker dead_lettered`, `dead_letter_backlog`) | A managed agent run or reconcile job gave up | Managed logs, `event = managed.queue` | As above |
| Website, home page, API reads or public clone failing from outside (`synthetic probe_health`, `probe_page`, `probe_api`, `probe_clone`) | With `PROBES=on`: a synthetic check failed two passes in a row, each tried twice. A check runs as a stranger would | `GET /probes` for the status and request id, then that id in Workers Logs | New since the last deploy: roll back |
| Test landing failing on dev (`synthetic probe_land`) | Dev only, `PROBE_LANDING=on`: a commit or landing on the probe repository failed. A 409 is the repository's policy: it must need no approval | `GET /probes`; the repository's policy and token | Fix the setup, or treat as a landing failure |
| Mail from the dead-man: `Superfan has stopped` | Superfan has gone quiet for about 25 minutes, can't be reached, or can't mail. **Nothing is watching this env** | `GET /heartbeat`. Then Superfan's Observability, and its Cron Triggers in the dashboard | Redeploy Superfan, or fix its recipient, sender or Resend key. The mail repeats every 6 hours until it recovers |

## Digest alerts

| Alert | Means | First check | Way out |
|---|---|---|---|
| Calls failing, or errors (`<component> error_rate`, `exceptions`, `error_logs`) | More than 2% of 20+ invocations failed, or errors are piling up | The finding's narrative, then that Worker's Observability | New since the last deploy: roll back |
| Calls slowed (`<component> p95_wall_ms`) | p95 doubled from its baseline, by 100 ms or more | Observability, the slowest operations | A burst on dev explains most of these |
| Calls fail more, or are slower, since the deploy (`<component> release_error_rate`, `release_p95_ms`) | With `RELEASE_COMPARE=on`: this release is worse than the one before, in equal windows either side of the deploy. API, website, repository, landing and commit calls only | `GET /deploys` for the two releases, then the finding's `revision`. A burst on dev explains most slowdowns | The release: roll back, or fix forward if it migrated |
| Calls killed for CPU or memory (`<component> resource_kills`) | Killed for CPU or memory | Observability, `exceededCpu` or `exceededMemory` | Find the repository or job; a large one needs a bound |
| Repository past 8 GB (`storage storage_8gb`) | A repository's database is past 8 GB | As `storage_9gb` | Plan compaction or a split now |
| Repository log compaction stalled (`derived_jobs compaction_stalls`) | A hold has stalled a repository's log | `GET /repos/:id/compaction`: `held` says why | `docs/runbook.md`, "A stalled log raises an alarm" |
| Scheduled task failures (`cron failed_crons`) | The minute cron threw, or logged a failed step | Platform logs: `undo.sweep_failed`, `compaction.sweep_failed`, `ssh.keepalive_failed`, `billing.reconcile`, `billing.reconcile_failed` | Each step runs alone, so one failing leaves the others running |
| Scheduled tasks have stopped (`cron cron_missing`) | No cron ran for an hour, with other traffic arriving. Purges, compaction, SSH keep-alive and the nightly reconcile have stopped | Cron Triggers on the platform Worker. A new cron can take 15 minutes to fire | Redeploy the platform Worker |
| Landing batches failed (`land_queue land_failures`) | Over 5 land batches failed in 20 hours | Platform logs, `land.batch_failed`, `land.submitted_batch_failed`, `land.step_failed`: `repo` and `error` | Lost compare-and-swaps aren't counted, so these are real |
| Landings waited over 20 seconds (`land_queue land_timeouts`) | Over 10 landers waited 20 seconds with no answer in 20 hours | Platform logs, `event = land.timed_out`. Expected in a 1,000-writer burst on dev | Landers retry until 2 minutes; a repository with many needs a look |
| Jobs or runs waiting (`derived_jobs`, `check_runs`, `managed_worker` `backlog`, `backlog_growth`) | Over 50 messages waiting, or more than doubled | Is the consumer running? Observability on that Worker | Usually a stuck or slow job |
| Jobs waited to start, or keep retrying (`derived_jobs lag_ms`, `retries_per_message`) | Jobs waited over 2 minutes, or retry more than once on average | `event = job.failed` | As above |
| Git pushes refused and retried (`object_push_queue push_retries`) | Artifacts refused over 5 pushes | Platform logs, `object store push attempt` or `event = object.push_retry` | Usually busy and clears itself |
| Check containers at high disk (`check_runs container_disk_percent`) | A check container passed 85% disk | Check container metrics | Check image and workspace size |
| Dead-man check has stopped (`deadman deadman_stale`) | The dead-man hasn't checked in 20 minutes, or can't be read. If Superfan stops now, nobody is told | `GET /health` on the dead-man; its Cron Triggers | Redeploy the dead-man |
| Monitoring has stopped receiving events (`telemetry tail_silent`) | No tail events this hour. Every tail signal is blind | `GET /status`; is `tail_consumers` still on the Worker? | Redeploy the platform, then Superfan |
| Monitoring can't read analytics, or is misconfigured (`telemetry fetch_failed`, `config`, `token_missing`, `disabled`) | Analytics can't be read: queues and dead letters are blind | The finding's summary names the cause | Fix `CF_ANALYTICS_TOKEN` or the config |

## Audit events

Both alerts are `AUDIT_LOG` on. The rule behind them: the erase stays blocked, whatever it takes, because erasing would lose the events. The mail changes who knows, not what happens.

- **Held up.** Fix what `audit.repo_copy_failed` says, usually the `audit:<org>` instance. The job looks again every 5 minutes, carries on by itself, and the finding closes 20 hours after the last line.
- **Can't be read.** Waiting won't help. Set the row aside:

  1. `cargo xtask admin audit-set-aside --env <env> --repo <id> --seq <n> --dry-run`, with the repository and event from the mail. It changes nothing, and prints the row's kind and size and the exact command for step 2.
  2. Run that command: `--confirm --bytes <n>`, the size from step 1. It needs `OWNER_TOKEN` in the env's secrets file.
  3. Check `/orgs/<org>/audit` shows `Unreadable audit event set aside` in the row's place, with the events that were stuck behind it. A blocked erase carries on at its next look, within 5 minutes.

  The row's bytes are gone for good, and nothing prints them, so what it recorded can't be recovered from here. Its kind and size stay in the org's log, and the operators' audit (`repo.audit_row_set_aside`) keeps every attempt, a refused one included. A person's repository has no org log, so that audit is its only record.

  A healthy event is refused (409), so a wrong `--seq` does no harm. A repeat is safe, and says `already`, `absent` or `erased`. A second bad row names itself in the next alert and needs its own run. A legal hold refuses this (423): those bytes may be evidence, so release the hold first or leave it waiting. With `AUDIT_LOG` off it's refused too, as nothing would show the repair.

  Don't turn `AUDIT_LOG` off to get past a bad row: with the switch off, the erase takes every waiting event with it.

A finding spells out 3 rows and counts the rest. `GET /findings` shows the same; the rest are in the logs, one line per row per look. Only a repository id and an event number can reach a finding: nothing else on the line does.


## Blind spots that remain

| Gap | Why |
|---|---|
| Land queue depth | Tickets are SQL inside each repository, with no counter outside. Failures and waiting landers are watched instead |
| Mail itself | Superfan and the dead-man both send through Resend. If Resend or the key fails, neither can tell anyone. `Your call later` in [observability-plan.md](observability-plan.md) |
| All of Cloudflare's crons | The dead-man and Superfan run on the same platform. If crons stop across the account, both go quiet |

## Why the dead-man is a cron Worker

Checked 2026-10-31. [Standalone Health Checks](https://developers.cloudflare.com/health-checks/) and their [status notification](https://developers.cloudflare.com/notifications/notification-available/) need a Pro zone or higher, and `yonedarepo.com` is on Free. Notifications has no type for Workers, cron or Queues. So a small Worker on its own cron does it, and Superfan watches it back. Upgrading the zone to Pro would remove the last row above: Health Checks don't depend on our crons.
