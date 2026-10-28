# Runbook

Operating the YonedaRepo source platform: stock Git, model checks, local setup, environments
and deploys, the real-world kit, and recovery.

## Stock Git over HTTPS

Plain `git` clones, fetches and pushes at `https://<platform>/git/<repo-id>.git` (smart HTTP v0; Git 2.26+ asks for v2 and falls back). Credentials are a repository token (`yrp_`) or personal token (`ypat_`) as the password, any user name; Git's credential helper supplies it after the server's `401` with `WWW-Authenticate: Basic`. Fetching needs `read`, pushing `write`, landing a protected branch what `POST /land` needs; path-restricted tokens are refused.

A push lists working branches as usual but never protected ones (`main`, `release`, `release/*`): their recent first-parent heads are sent as `.have` lines instead. Git therefore treats every push to `main` as a creation and never refuses it as non-fast-forward, so a push based on an older `main` reaches the server and lands with its merge (or is refused as a conflict), while sending only the client's own objects. What users see:

- `git push origin main` always prints `* [new branch]      main -> main`, never "Everything up-to-date"; pushing a commit `main` already holds lands nothing and succeeds.
- When the server merged, Git prints `remote: main: landed with server merge, run git pull`; `git pull --ff-only` then fast-forwards.
- An overlap on the same lines prints `remote: conflict in <path>` and `! [remote rejected] main -> main (conflict in <path>: run git pull)`; pull, resolve, commit and push again.
- `git push --force origin main` lands like any other push (merge or conflict): it never rewrites or deletes `main`. Deleting a protected branch is refused.

Working branches move by compare-and-swap on the value Git saw (`--force` works there; a branch that moved meanwhile is `fetch first`); `--atomic` moves all of them in one transaction or none, and cannot include a protected branch. Every object is verified before anything is recorded and refs move only after the commits are recorded under their own ids, so a push that fails or is cut off leaves refs and the log unchanged. A file carrying a credential refuses the whole push with `secret detected in <path>:<line>` (owner exceptions: policy `secret_allow`). Limits per push: 64 MiB of pack, 40,000 objects, 16 MiB per object; larger pushes use `git-remote-yoneda`. Lightweight tags (`git tag v1 && git push origin v1`, or `POST /repos/:id/tags {name, commit}`, MCP `git_tag`) need `write` and `land`, are created once and never move or disappear (a forced push or `--delete` of a tag is refused), are mirrored to the object store like `main`, and are cloned and fetched like branches; annotated tags (`git tag -a`) are refused. Not served yet: annotated tags, push options, protocol v2 features (partial clone, `--filter`), shallow clones, and fetching history imported into Artifacts (use the helper). The platform Worker sets `limits.subrequests=50000` because each Git object sent or received is one R2 read or write.

A push to a working branch with no open change request prints `open a change: yoneda change create <branch>`. Approving a change is a review of its head commit by an account other than the head's author: the platform refuses an author's own review, also through a repository token the author created (a token reviews for the account that made it).

## Model checks

A policy runner `{"kind": "model", "rubric": "...", "model": "glm-5.3-flash", "allow_truncated": false}` (model and truncation optional) makes the platform grade each recorded commit with one model call: the diff against its first parent (as `GET /diff?patch=1`), the commit message as the stated intent, and the rubric. The call has no tools and no loop. The answer must be the JSON `{verdict, score, findings}`, and is recorded as the runner's check result with the findings, tokens and cost as evidence; list the runner in `required_checks` to gate landing. A diff over 60,000 characters, or with a file whose patch is unavailable, fails with "diff too large for model review" unless `allow_truncated` is set. A malformed answer, HTTP error or 45 s timeout is retried once and then errors: the run records no result, so the check stays missing and landing stays blocked (re-request it with `POST /commits/<sha>/check-runs`). Only the platform's own run may post a runner's check.

The call uses the platform Worker's own Secrets Store binding `REVIEW_MODEL_KEY` (store `3d9115d4fe864c54a792bcb790a763e3`, secret `ZAI`: the managed Z.ai key, owner decision 2026-10-27), bound to the platform Worker itself. Without it, model checks error and block. Live gate: `node tools/staging-realworld.mjs --model-check`.

## Local prerequisites

Use Rust from `rust-toolchain.toml`, Node 24, pnpm 11, Docker and `worker-build` 0.8.7. `cargo xtask doctor` checks installed commands and Docker availability. `cargo xtask setup` installs locked JS dependencies and creates an ignored owner token with private file permissions.

`cargo xtask check` is the required local gate: Rust formatting, Clippy with warnings denied, native tests, the actual Wasm build, TypeScript/Biome, workerd integration tests and browser production build. It requires no Cloudflare login and no model calls.

`cargo xtask dev` builds assets and Wasm, applies D1 migrations locally and starts Wrangler. For hot reload, run `pnpm --dir frontend dev` beside it. Cloudflare capabilities that need remote services (Artifacts, the check container, model checks) are proven only by the live kit, never by local tests.

Local private Worker variables live beside the platform config in `cloudflare/.dev.vars`. Setup copies an existing root `.dev.vars` only when the destination is absent and keeps private permissions; it never prints or rotates credentials. Default local state remains `.wrangler/state`. Named environments use `.local/deploy/<name>/.dev.vars` and their existing `state/` directory. Keep these ignored files when updating the checkout.

Root `pnpm dev`, `pnpm build` and `pnpm deploy` delegate to `xtask`. For raw Wrangler commands, always pass the intended config (`--config cloudflare/wrangler.<env>-<role>.jsonc`). See [portable account deployment](../README.md#deploy-to-your-own-cloudflare-account).

## Development account

The wrangler configs in `cloudflare/` carry this project's account, Secrets Store ids and resource names: configuration, not secret values. For another account, authenticate with `pnpm exec wrangler login`, then follow [portable account deployment](../README.md#deploy-to-your-own-cloudflare-account). Do not reuse production resources for tests. D1 discovery migrations live in `cloudflare/migrations/`; the repository Durable Object schema lives with `yoneda-platform`.

The platform Worker's only model key is `REVIEW_MODEL_KEY` (above); superfan has its own. Never fetch Secrets Store values into the shell, browser or a model environment. The Worker secret `OWNER_TOKEN` protects the owner API; `cargo xtask deploy` uploads it from the env's private secrets file.

Cloudflare activates Worker code before a container image rollout completes. After an image change (the check container), inspect the rollout and wait for it to finish before relying on checks:

```sh
pnpm exec wrangler containers list --json --config cloudflare/wrangler.dev-platform.jsonc
pnpm exec wrangler containers info APPLICATION_ID --json --config cloudflare/wrangler.dev-platform.jsonc
```

Wait until the application runs the newly uploaded digest, no rollout is active and its instances are healthy without startup errors; a successful deploy command proves only that the rollout started. A rollout restarts running check containers, so check for busy instances first (`deploy` refuses while any is busy unless `--allow-active`). See [Cloudflare rollout behavior](https://developers.cloudflare.com/containers/configuration/rollouts/). Worker and Durable Object code also propagate separately: a successful upload does not prove that an existing repository Durable Object runs the new code ([code-version mismatch](https://developers.cloudflare.com/durable-objects/platform/known-issues/#code-updates)), so keep protocol changes compatible through the mixed-version window.

## Environments, deploys and infrastructure as code

Each environment is one spec in `infra/envs/` (`dev.json` = dev.yonedarepo.com, `prod.json` = yonedarepo.com, Workers `yonedarepo-<env>-<role>`) plus a lock of resource identities; each Worker's role and purpose are in its `notes`. The wrangler configs in `cloudflare/` are generated from the spec: change the spec, then `cargo xtask infra gen --env dev` (`--check` compares only; the golden tests in `cargo test -p xtask` fail on drift).

- `cargo xtask deploy --env dev|prod [--dry-run] [--confirm] [--allow-active]` builds Wasm and the frontend, applies D1 migrations, deploys each Worker in cutover order with `BUILD_REVISION` = HEAD, uploads only missing secrets from the spec's secrets file and stops on the first `/health` mismatch. dev deploys only the tip of `dev`; prod only the tip of `main`, with `--confirm`, every dev Worker already at that commit, passing real-world kit evidence for it (below) and no busy container instance. `deploy` without `--env` refuses. The kit's `browser` item must pass whenever the evidence lists it (`BROWSER_REQUIRED` in `xtask/src/deploy_guard.rs` makes it mandatory once every kit run records it). A lock entry `pending` is a D1 database the spec declares but `infra up` has not created; configs generate with it and every deploy refuses it.
- `cargo xtask status|rollback --env X` shows live revisions and routes, or rolls every Worker back one deployment.
- `cargo xtask infra plan --env X` compares live Cloudflare state with the spec (create / unchanged / drift / extra / unverified) using a read-only API token (`CLOUDFLARE_API_TOKEN` or `--token-file`). `infra up` creates missing D1/R2/queues, records their ids and regenerates the configs (when that changes tracked files it stops: commit them, then rerun), then deploys; right before each Worker's deploy it detaches that Worker's hosts (Custom Domains and zone routes) from any other Worker holding them, printing each move. `infra down --confirm [--purge]` tears down dev or an `ephemeral-<id>` stack and is refused for prod; `infra smoke` checks the frontend, revisions and owner APIs.
- A spec's `retired` block names what the env used to run (exact names per kind, or one old `prefix`). `infra plan` lists live resources with those names as `orphan` rows; `infra prune --env X --confirm [--allow-active]` (`--dry-run` prints only) deletes exactly those rows: queue consumers, Workers (with their Durable Objects), container apps, workflows, the repositories of retired Artifacts namespaces (a namespace cannot be deleted), queues, D1 and R2 (a bucket must be empty). It refuses while any section is unreadable, while a retired name is bound by the dev or prod spec, and while a retired container app has busy instances. A prod deploy also checks the retired container apps for busy instances before its first Worker.
- CI (`.github/workflows/ci.yml`) runs the `cargo xtask check` parts as parallel jobs (the workerd suite in four `--shard` jobs) and, on pushes to `dev`, deploys dev and runs the smoke. The dev deploy uses `--prebuilt <dir>`: it installs the Wasm, frontend and runtime image those jobs built and tested (each artifact carries a `REVISION` that must equal HEAD, else it refuses before any remote change), pushes the image once to the account registry as `<prefix>-runtime:<image id>` (`wrangler containers push`) and deploys container Workers from a copy of their config whose `image` is that registry reference, so wrangler rebuilds nothing. Without `--prebuilt`, prod and ephemeral deploys build everything. The push also tags the same manifest `<image tag>--inputs-<hash>`: the hash of the runtime's inputs at that commit (`xtask/src/deploy_inputs.rs`: Dockerfile, entrypoint, `.dockerignore`, root `Cargo.toml`, pnpm manifests, the crates `yoneda-runtime` builds from and their share of `Cargo.lock`). The deploy job first runs `cargo xtask live-check --env dev` and skips the rest, with a job-summary line, when every Worker's `/health` already shows the commit.
- Dev fixes deploy from the owner's Mac: `cargo xtask deploy --env dev [--dry-run] [--allow-active]` (no `--prebuilt`). It reads `CLOUDFLARE_API_TOKEN`, or else `~/.config/yonedarepo/deploy-dev.env` (mode 0600; never printed), builds Wasm and the frontend locally, and reuses the image the container apps run when its `--inputs-` record matches HEAD's inputs (no image build, no rollout). Otherwise it builds the image with `docker buildx --platform linux/amd64` (slow on arm64: the Rust build is emulated), pushes and records it, and stops before the rollout while any container instance is busy unless `--allow-active`. Then migrations, deploys, `/health` checks and the smoke, with a timing table. `cargo xtask runtime-image record --env dev --built-from <commit>` records the inputs of an image pushed before records existed (take the commit from the CI run that pushed it). Kit, deploy-prod and the nightly ephemeral stack are dispatch/schedule workflows, which GitHub runs only from the default branch (`main`).

CI deploy tokens live in the GitHub Environments `dev` and `production` (one token each, never shared): account Workers Scripts Write, D1 Write, Workers R2 Storage Write, Queues Write, **Secrets Store Write** (deploying a Worker with `secrets_store_secrets` bindings fails with code 10021 on Read alone), Artifacts Write, Workers Containers Write, Account Settings Read; zone Workers Routes Write, Zone Read, DNS Write. `infra plan` needs only the Read variants plus Workers Containers Read.

Each env's secrets file (`~/.config/yonedarepo/staging.env` for dev, the name kept from before the rename; `prod.env` for prod; mode 0600) holds the Worker secrets its spec lists, such as `OWNER_TOKEN`, `VAULT_KEY` (64 hex), and superfan's `CF_ANALYTICS_TOKEN` (read-only: Account Analytics, Workers Scripts, Queues, Containers; superfan looks up the platform's queue, Durable Object and container ids by name with it) and `SUPERFAN_READ_TOKEN`. `deploy` uploads only the secrets a Worker does not have yet.

## Real-world kit

`node tools/staging-realworld.mjs` exercises a live environment the way a person, an agent client and a script use the platform. It runs against dev unless `--prod` is given, prints a pass/fail table and writes evidence to `.local/staging/`. Nothing in it starts an agent run; only the model-check gate calls a model (the platform's own AI check, under $0.01).

Credentials come only from 0600 files in `~/.config/yonedarepo/`, never arguments or output:

- `staging-kit.env`: `KIT_USERNAME` / `KIT_PASSWORD`, created on first run. A second kit account `<kit username>_m` with the same password is signed up on first use; the members gate shares repositories with it, and it authors or approves where the platform refuses an author's own review (items 18 and `browser`).
- `staging-bench.env`: `BENCH_KEY` of the dev bench Worker (`yonedarepo-dev-bench`), for the bursts and the webhook receiver. Without it those items skip.

The CLI items need `cargo build -p yoneda-cli --release` (`--cli-bin <dir>` names another build).

| Item | What must hold |
|---|---|
| `0` | `/health` revisions of the front and platform Workers (recorded with the evidence) |
| `browser` | Headless system Chrome signs the kit account in through the login form, creates a repository with "New repository", opens Code, History, Changes (the empty list), Settings (Landing rules, Connect) and account Settings; then the second account commits on a branch, the kit account opens a change for it by API, approves and lands it on the Change page, and the page and the API both read it back `landed`. Needs Google Chrome; screenshots in `.local/staging/browser-<ts>/` |
| `6` | `git clone` of protected `main` matches the API tree byte for byte |
| `7` | A check run in a container passes, and no container is left afterwards |
| `8`, `9` | 100- and 1000-writer bursts through the bench Worker: every land succeeds and reads back |
| `10` | Many-repository burst (20 repositories × 10 writers) |
| `12` | `yoneda login` by device flow, `yoneda repo create`, clone, push, exact ids |
| `13` | Concurrent pushes: server merge, and a same-line conflict refused |
| `14` | An atomic push with a stale branch moves nothing; a killed push leaves refs unchanged |
| `15` | The account MCP with a personal token: round trip and repository allowlist |
| `16` | Server-side reads at a version (`log`, `grep`, `blame --at`) |
| `18` | A change request with the CLI: push a branch (the push suggests `yoneda change create`), open it, comment on a diff line, see the author's own approval refused (directly and through a token it made) and the head not ready, approve as the second account, `yoneda change land`, read it back `landed` at the head |
| `17` | Delete the kit repositories with `yoneda`, 404 afterwards, personal token revoked |
| `model` | A `security` model runner fails a seeded SQL-injection commit and refuses its landing, then passes and lands the fix (needs the platform's `REVIEW_MODEL_KEY`) |
| `hooks` | A webhook's signed deliveries to the bench Worker's `/hooks/<box>`: one scripted failure retried, log order, an unsafe target refused, delete |
| `members` | The second account reads, pushes and lands by role with stock Git and REST, and is refused at once when removed |
| `reads` | Stock Git over smart HTTP: a push declaring a read that changed meanwhile is refused as a read conflict, lands after `git pull`, and its session record reads back |

A full run (`node tools/staging-realworld.mjs`) runs every item except `model`, `hooks`, `members` and `reads`, which need a review key, a receiver or the second account and run only when named. Options:

- `--only 0,6,7` runs the listed items; `--skip-bursts` leaves out 8–10.
- `--browser [--headed]`, `--model-check`, `--webhooks --receiver <origin>`, `--members`, `--reads-sessions`: one gate with item 0.
- `--api <origin>` is the platform API host for the CLI items (default `https://api.dev.yonedarepo.com`); `--origin`, `--platform` and `--client` name the front, platform and bench Workers.
- `--cleanup-repos <prefix>` deletes the kit account's leftover repositories with that name prefix and exits.

Evidence is `realworld-<ms>.json`; a single gate writes its own name (`browser-gate-*`, `model-check-*`, `webhook-gate-*`, `members-gate-*`, `reads-gate-*`). A prod deploy reads the newest `realworld*.json` and refuses unless its item 0 recorded both Workers at the commit being deployed and every item passed.

**Prod smoke.** After a prod deploy, run the live revisions, the browser gate and the CLI items against production (they create and then delete their own repositories):

```sh
node tools/staging-realworld.mjs --prod --only 0,browser,12,13,14,15,16,17
```

`--prod` switches the front, API and platform hosts to `yonedarepo.com`, `api.yonedarepo.com` and `yonedarepo-prod-platform`, and writes `prod-smoke-<ms>.json`, never `realworld*` (which the prod guard reads as dev evidence). The kit account and its second account are created on production on first use. Always pass `--only`: the bursts and gates are for dev.

## Recovery

Queues are at least once: redelivery is expected, so consumers must be idempotent (leases, epochs, idempotency keys). The dead-letter queue is diagnostic transport evidence; the repository Durable Object's records remain authoritative. Check the repository's current state before retrying anything by hand.

Each `CheckContainer` runs one check and is destroyed afterwards. `yoneda-runtime check-server` writes the commit's files to a fresh directory and runs the policy's argv as UID 1000 with no capabilities, `NoNewPrivs=1`, a scrubbed environment, no network and a hard timeout that kills the whole process group. The image carries sh, git, Python, Node/npm with the workspace's TypeScript under `/opt/yoneda/node_modules`, and Rust; no agent CLIs.

A landing whose branch moved meanwhile is merged on the server or refused with `CONFLICT` and the paths; nothing rebases or overwrites automatically. Resolve in a new commit and land again.

Migration changes must be additive and appended. Check fresh, repeat and preceding-version upgrades locally, then apply D1 migrations before deploying code that needs them. Do not modify an already-applied SQL file or remove Durable Object class migration history. Roll back code only to versions compatible with the deployed schema.

No live run, deployment or acceptance should be inferred from passing local tests. Record actual commands and outcomes in `docs/progress.md`.
