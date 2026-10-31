# Ship pipeline

Prod ships from a pull request. The owner says "ship"; only then is the PR opened. Nothing here runs without that word, and `deploy-prod.yml` deploys only a merged PR from `dev` to `main`.

1. **Open the PR** from `dev` to `main` (push `dev` first). `ship.yml` runs on it: the merge must equal the head's tree, then Check, Full suite, a dev deploy at the PR head, the full kit, and minimal evidence named `realworld-<tree>`, kept 7 days.
2. **Merge it** once Ship is green. Use a merge commit. The merge has a new sha but the same tree, and the prod guard compares trees (`xtask/src/deploy_evidence.rs`).
3. **`deploy-prod.yml` runs** on the push to `main`: it finds the Ship run for that PR, deploys prod with its evidence, publishes the CLI if that version isn't on prod (macOS runner), runs the prod smoke, and watches prod for 30 minutes.

Other pushes to `main` deploy nothing. `workflow_dispatch` on `deploy-prod.yml` re-runs the steps for main's tip (`dry_run` defaults on, `allow_active` off).

| Stops the ship | What to do |
| --- | --- |
| `main has changes dev lacks` | Merge `main` into `dev`, push; Ship runs again |
| A new push to `dev` | That run waits, then runs at the new head. Merge only when the head's run is green |
| Busy containers (`Stopping before ...`) | No container rolled out, but D1 migrations and Superfan may already be applied. Re-run `deploy-prod.yml` by hand when idle |
| No evidence (over 7 days old) | Re-run Ship, then re-run `deploy-prod.yml` |

Don't deploy dev or run a kit while Ship runs. GitHub's concurrency group holds only workflows; a deploy from a checkout moves dev under the kit (Ship then fails with `dev moved`), and a second kit login evicts the session. Only one Ship runs at a time.

## Public repository rules

The repository is public, so logs, summaries, comments and artifacts are readable by anyone.

- **Fork PRs never reach secrets.** No `pull_request_target`. Jobs with secrets need an Environment, and in `ship.yml` a same-repository head from `dev`. GitHub gives a fork's `pull_request` run no secrets whatever its copy of the workflow says.
- **Forged evidence doesn't count.** A fork's run can upload an artifact of any name, so `tools/ship/find-ship.mjs` accepts only a successful `ship.yml` run of this repository's `dev` at the merged PR's head.
- **Output is allow-listed.** `tools/ship/quiet.mjs` drops everything from deploy and kit runs except guard refusals, timing rows and `PASS 12 900ms` lines (wrangler can print the account's email; kit reasons name accounts and repositories), and closes the job summary. The cost: a failure says what failed, not why. Rerun that command locally for the why.
- **Evidence is a pass table.** `tools/ship/evidence.mjs` copies allowed fields only, gitleaks scans it, then it uploads.
- **Monitor details stay private.** Public output is a count. Superfan mails the details.

`tests/runtime/ship-workflows.test.mjs` pins these rules.

## Setup (GitHub side, not done yet)

One secret, `YONEDA_ENV_FILE`, in each of two Environments. Each holds `KEY=VALUE` lines; the `env-file` action writes them 0600 to `~/.config/yonedarepo/` under the names xtask and the kit read, and masks each value.

| Environment | Keys | Build it from |
| --- | --- | --- |
| `dev` | `CLOUDFLARE_API_TOKEN`, the Worker secrets, `KIT_USERNAME`, `KIT_PASSWORD`, `BENCH_KEY` | `cat ~/.config/yonedarepo/{deploy-dev,staging,staging-kit,staging-bench}.env \| gh secret set YONEDA_ENV_FILE --env dev` |
| `production` | `CLOUDFLARE_API_TOKEN`, the Worker secrets (including `SUPERFAN_READ_TOKEN`), `KIT_USERNAME`, `KIT_PASSWORD` | `cat ~/.config/yonedarepo/{deploy-prod,prod,staging-kit}.env \| gh secret set YONEDA_ENV_FILE --env production` |

The Mac has no `deploy-prod.env`: prod deploys there use wrangler's login. Mint a prod token with the scopes in the [runbook](runbook.md) and write it to that file (0600) as `CLOUDFLARE_API_TOKEN=<token>` first.

Remove any old `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `OWNER_TOKEN` and `VAULT_KEY` secrets from those Environments; no workflow reads them now.

Then:

1. `dev` Environment: **no deployment branch rule.** A PR run's ref is `refs/pull/<n>/merge`, so a `dev` branch rule would refuse the ship.
2. `production` Environment: deployment branch rule `main`.
3. `gh workflow enable deploy-prod.yml`.
4. Branch protection on `main`: require `Deploy dev + kit`, so a merge can't beat the kit. Only `MagnetonIO` can push or merge; the gate in `deploy-prod.yml` refuses any other actor.
5. Fork PR workflows: require approval for outside contributors.
6. After the first ship, `GET /status` on prod Superfan must say `"notices": "email"`.

## Monitor

The `monitor` job polls every 5 minutes for 30 minutes (`tools/ship/monitor.mjs`): each `/health` at the shipped revision, then Superfan `POST /run` and `GET /findings`.

- **New finding:** an open finding that wasn't open when the job started, or first seen since the deploy began. The job fails at once with a line like `1 new finding`.
- **Two bad polls in a row** (health not at the revision, or Superfan unreadable) fail the job. So does a watch with no telemetry on any poll.
- **Details:** `POST /run` and the hourly cron both mail open findings not yet mailed to `ADMIN_NOTIFY_EMAIL` (`cloudflare/superfan/notify.ts`). One digest per pass, at most 8 digests per UTC day; the rest wait for the next pass. A reopened finding mails again only if its last mail is over 6 hours old. Dev's address is empty: its bursts fire rules on purpose. Model spend keeps its own daily cap, and a finding without a narrative is mailed with its summary.

## Rollback

**Nothing rolls back on its own.** A repository that ran a migration refuses older binaries with `SCHEMA_TOO_NEW` (`backend/crates/yoneda-platform/src/repo_store/migration.rs`), so an automatic rollback could take those repositories down.

1. Read the mail, or `GET /findings` on Superfan with `SUPERFAN_READ_TOKEN`.
2. Check the ship for migrations and Durable Object class changes: the diff from the last prod revision for `backend/crates/yoneda-platform` migrations, `cloudflare/migrations`, and `migrations` in `infra/envs/prod.json`.
3. **None:** from the owner's checkout, `cargo xtask rollback --env prod --confirm`. It rolls every Worker back one deployment and refuses while containers are busy. Check `/health`.
4. **A repository schema migration:** fix forward with a new ship, or roll back only to the wave-1 binary that accepts the new version (`docs/global-scale-plan.md`, rule 3). Cloudflare blocks rollback across a Durable Object class change.
5. **Bundled pushes:** see Object bundles in the [runbook](runbook.md#recovery).
6. After a rollback `main` is ahead of prod. The fix ships as the next PR.

## Unproven

None of this has run on GitHub. `actionlint` and local tests pass; no workflow, runner or secret was exercised.

| Kit need on `ubuntu-latest` | State |
| --- | --- |
| CLI release build | Built in the job |
| Chrome for the browser item (`channel: 'chrome'`) | Expected on the image; not tried |
| `git-lfs` for items 25, 27 | Expected on the image; not tried |
| `cloudflared` for item 26 | Installed, pinned, in the prod smoke only; the full kit leaves 26 out |
| Docker sandbox | Not needed: only item 29 uses it, and the kit leaves it out |
| `BENCH_KEY` | From the env file. Without it items 8–10 skip, and a skip fails the ship |

No item is known to be impossible on a runner. Still open:

- Whether sign-in, rate limits or bot rules treat a runner's IP like the Mac, and whether the 13-minute kit fits its 120-minute job. Bursts run from the bench Worker; items 19, 20 and 25 run from the runner.
- The prod deploy builds the runtime image on the runner (`Source::Dockerfile`) inside a 60-minute job. The dev deploy builds it only when its inputs changed.
- `downloads stage` on `macos-latest` (Xcode's x86_64 target, zig 0.17.0, cargo-zigbuild 0.24.0) has only run on the owner's Mac.
- Item 26 on a runner: the tunnel `ProxyCommand` through `cloudflared`.
- Resend from Superfan has only run against a fake.
- The prod smoke runs beside the monitor. If its deliberate refusals fire a Superfan rule, the monitor fails on a false alarm.
- `--prod --model-check` is not in the smoke; run it by hand after a ship that changes the model check.
