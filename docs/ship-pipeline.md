# Ship pipeline

**Live tests stay on the owner's Mac, where we debug and fix them. GitHub does CI and the prod deploy.** The owner says "ship"; only then is the PR opened. `deploy-prod.yml` deploys only a merged PR from `dev` to `main`.

1. **Deploy dev and run the full kit** at the tip of `dev`, from the Mac: `cargo xtask deploy --env dev`, then `node tools/staging-realworld.mjs`.
2. **Push `dev`, then mark the commit:** `cargo xtask live-tests`. It refuses unless the checkout is clean at the tip of `dev` and the newest evidence is a full pass at HEAD: all 22 items, none skipped, recording HEAD's tree. It sets a commit status named `live-tests` that says `pass tree <tree>` and nothing else. `--dry-run` prints the call.
3. **Open the PR** from `dev` to `main`. `ship.yml` runs: the merge must equal the head's tree, then Check and Full suite. It holds no secret and deploys nothing.
4. **Merge it** once `live-tests` and Ship are green. Use a merge commit.
5. **`deploy-prod.yml` runs** on the push to `main`: deploy, CLI publish if that version isn't on prod (macOS runner), the runner's smoke, the 30-minute monitor.
6. **Run the rest of the smoke from the Mac:** `node tools/staging-realworld.mjs --prod --only 0,browser,26,12,13,14,15,16,17`.

Other pushes to `main` deploy nothing. `workflow_dispatch` on `deploy-prod.yml` re-runs the steps for main's tip (`dry_run` defaults on, `allow_active` off).

## What a prod deploy checks

| Check | From the Mac | On the runner (`--ship-head <PR head>`) |
| --- | --- | --- |
| Clean tree, HEAD is the tip of `main`, `--confirm`, no busy container | Yes | Yes |
| Dev Workers at HEAD's tree | Yes | No |
| Evidence file passes at HEAD's tree | Yes | No |
| PR head has HEAD's tree | No | Yes |
| Newest `live-tests` at the PR head is a success, set by `MagnetonIO`, for that tree | No | Yes |
| A successful Ship run of this repository's `dev` at the PR head (Check, Full suite) | No | Yes |

`--ship-head` needs `GITHUB_REPOSITORY` and `GH_TOKEN` and reads GitHub itself (`xtask/src/deploy_ship.rs`), so it is a different check, not a bypass.

| Stops the ship | What to do |
| --- | --- |
| `main has changes dev lacks` | Merge `main` into `dev`, push, run the kit again: the head moved |
| A new push to `dev` | The new head has no `live-tests`. Run the kit there, mark it |
| `live-tests is failure` | A later status at that commit wins over an older pass. Fix, rerun the kit, mark the new commit |
| Busy containers (`Stopping before ...`) | No container rolled out, but D1 migrations and Superfan may already be applied. Re-run `deploy-prod.yml` by hand when idle |

## Prod smoke

| Runs | Where | What |
| --- | --- | --- |
| `cargo xtask infra smoke --env prod` | Runner | Frontend serves HTML, every `/health` at the shipped revision, the owner's `GET /api/v1/repos` through the front |
| Monitor | Runner | Below |
| Browser item | Mac | Not tried on a runner; needs Chrome and the kit account |
| CLI items 12–17 | Mac | Not tried on a runner; needs a CLI build and the kit account |
| SSH item 26 | Mac | Not tried on a runner; needs `cloudflared` and the second kit account |
| `--prod --model-check` | Mac, by hand | A ship that changes the model check |

## Public repository rules

The repository is public, so logs, summaries, comments, statuses and artifacts are readable by anyone.

- **Fork PRs never reach secrets.** No `pull_request_target`. Ship holds no secrets; jobs with secrets need an Environment, and those run only on `main`.
- **Forged results don't count.** A fork's `pull_request` run lives in this repository, so xtask accepts only a Ship run of this repository's `dev`. A workflow token could set a status, so xtask accepts only the owner's.
- **Output is allow-listed.** `tools/ship/quiet.mjs` drops deploy output except guard refusals and timing rows, and smoke output except each check's name and result (wrangler can print the account's email; smoke details quote API replies). It closes the job summary too. The cost: a failure says what failed, not why. Rerun that command on the Mac for the why.
- **The kit leaves no evidence on GitHub.** Only the `live-tests` status does.
- **Monitor details stay private.** Public output is a count. Superfan mails the details.

`tests/runtime/ship-workflows.test.mjs` pins these rules.

## Setup (GitHub side, not done yet)

One secret, `YONEDA_ENV_FILE`, in the `production` Environment: `KEY=VALUE` lines holding `CLOUDFLARE_API_TOKEN` and the Worker secrets, including `SUPERFAN_READ_TOKEN`. The `env-file` action writes it 0600 to `~/.config/yonedarepo/` and masks each value.

The Mac has no `deploy-prod.env`: prod deploys there use wrangler's login. Mint a prod token with the scopes in the [runbook](runbook.md), write it to that file (0600) as `CLOUDFLARE_API_TOKEN=<token>`, then:

```sh
cat ~/.config/yonedarepo/{deploy-prod,prod}.env | gh secret set YONEDA_ENV_FILE --env production
```

`deploy-dev.yml` stays off; if it's ever enabled it wants the same secret in `dev`, from `deploy-dev.env` and `staging.env`. Remove any old `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `OWNER_TOKEN` and `VAULT_KEY` secrets from those Environments; no workflow reads them now.

Then:

1. `production` Environment: deployment branch rule `main`.
2. `gh workflow enable deploy-prod.yml`.
3. Branch protection on `main`: require `live-tests` and the Ship jobs, so a merge can't beat them. Only `MagnetonIO` can push or merge; the gate in `deploy-prod.yml` refuses any other actor.
4. Fork PR workflows: require approval for outside contributors.
5. After the first ship, `GET /status` on prod Superfan must say `"notices": "email"`.

## Monitor

The `monitor` job polls every 5 minutes for 30 minutes (`tools/ship/monitor.mjs`): each `/health` at the shipped revision, then Superfan `POST /run` and `GET /findings`.

- **New finding:** an open finding that wasn't open when the job started, or first seen since the deploy began. The job fails at once with a line like `1 new finding`.
- **Two bad polls in a row** (health not at the revision, or Superfan unreadable) fail the job. So does a watch with no telemetry on any poll.
- **Details:** `POST /run` and the hourly cron both mail open findings not yet mailed to `ADMIN_NOTIFY_EMAIL` (`cloudflare/superfan/notify.ts`). One digest per pass, at most 8 digests per UTC day; the rest wait for the next pass. A reopened finding mails again only if its last mail is over 6 hours old. Dev's address is empty: its bursts fire rules on purpose. Model spend keeps its own daily cap, and a finding without a narrative is mailed with its summary.

## Rollback

**Nothing rolls back on its own.** A repository that ran a migration refuses older binaries with `SCHEMA_TOO_NEW` (`backend/crates/yoneda-platform/src/repo_store/migration.rs`), so an automatic rollback could take those repositories down.

1. Read the mail, or `GET /findings` on Superfan with `SUPERFAN_READ_TOKEN`.
2. Check the ship for migrations and Durable Object class changes: the diff from the last prod revision for `MIGRATIONS` in `backend/crates/yoneda-platform/src` (repository, account and commit-store schemas), `cloudflare/migrations`, and `migrations` in `infra/envs/prod.json`.
3. **None:** from the owner's checkout, `cargo xtask rollback --env prod --confirm`. It rolls every Worker back one deployment and refuses while containers are busy. Check `/health`.
4. **A repository schema migration:** fix forward with a new ship, or roll back only to the wave-1 binary that accepts the new version (`docs/global-scale-plan.md`, rule 3). Cloudflare blocks rollback across a Durable Object class change.
5. **Bundled pushes:** see Object bundles in the [runbook](runbook.md#recovery).
6. After a rollback `main` is ahead of prod. The fix ships as the next PR.

## Unproven

None of this has run on GitHub. `actionlint` and local tests pass; no workflow, runner, status or secret was exercised.

- The prod deploy builds the runtime image on the runner (`Source::Dockerfile`) inside a 60-minute job.
- `downloads stage` on `macos-latest` (Xcode's x86_64 target, zig 0.17.0, cargo-zigbuild 0.24.0) has only run on the owner's Mac.
- GitHub's reply shapes for statuses and workflow runs are from its docs; the tests use fakes. `live-tests` has never been set for real.
- Resend from Superfan has only run against a fake.
