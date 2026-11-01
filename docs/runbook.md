# Runbook

Operating the YonedaRepo source platform: stock Git (HTTPS and SSH), model checks, local setup,
environments and deploys, the real-world kit, and recovery.

## Stock Git over HTTPS

Plain `git` clones, fetches and pushes at `https://<platform>/git/<repo-id>.git` (smart HTTP; fetches speak protocol v2 when Git asks, as 2.26+ does, else v0; pushes v0). Credentials are a repository token (`yrp_`) or personal token (`ypat_`) as the password, any user name; Git's credential helper supplies it after the server's `401` with `WWW-Authenticate: Basic`. Fetching needs `read`, pushing `write`, landing a protected branch what `POST /land` needs; path-restricted tokens are refused.

A push lists working branches as usual but never protected ones (`main`, `release`, `release/*`): their recent first-parent heads are sent as `.have` lines instead. Git therefore treats every push to `main` as a creation and never refuses it as non-fast-forward, so a push based on an older `main` reaches the server and lands with its merge (or is refused as a conflict), while sending only the client's own objects. What users see:

- `git push origin main` always prints `* [new branch]      main -> main`, never "Everything up-to-date"; pushing a commit `main` already holds lands nothing and succeeds.
- When the server merged, Git prints `remote: main: landed with server merge, run git pull`; `git pull --ff-only` then fast-forwards.
- An overlap on the same lines prints `remote: conflict in <path>` and `! [remote rejected] main -> main (conflict in <path>: run git pull)`; pull, resolve, commit and push again.
- `git push --force origin main` lands like any other push (merge or conflict): it never rewrites or deletes `main`. Deleting a protected branch is refused.

Working branches move by compare-and-swap on the value Git saw (`--force` works there; a branch that moved meanwhile is `fetch first`); `--atomic` moves all of them in one transaction or none, and cannot include a protected branch. Every object is verified before anything is recorded and refs move only after the commits are recorded under their own ids, so a push that fails or is cut off leaves refs and the log unchanged. A file carrying a credential refuses the whole push with `secret detected in <path>:<line>` (owner exceptions: policy `secret_allow`). Limits per push: 64 MiB of pack held at once, 40,000 objects, 100 MiB per file (GitHub's limit; files over 50 MiB get GitHub's warning to use Git LFS). Files over 8 MiB stream straight into R2 as their own objects and stream back out in clones and `GET /objects/<id>`; they are never held whole, are scanned for credentials as they stream, and must arrive whole: a pack carrying one as a delta of another version (several versions in one push) is refused, naming `git -c core.bigFileThreshold=8m push`, which sends them whole (edits pushed one version at a time always arrive whole: the server advertises `no-thin`). Larger pushes use `git-remote-yoneda`. Lightweight tags (`git tag v1 && git push origin v1`, or `POST /repos/:id/tags {name, commit}`, MCP `git_tag`) need `write` and `land`, are created once and never move or disappear (a forced push or `--delete` of a tag is refused), are mirrored to the object store like `main`, and are cloned and fetched like branches; annotated tags (`git tag -a`) are refused. Over protocol v2, partial clones (`--filter=blob:none`; a checkout then fetches the files it needs by id) and shallow ones (`--depth`, `--deepen`, `--unshallow`) are served; other filters, `--shallow-since` and `--shallow-exclude` are refused with a `remote error`. A fetch may want only commits and files a branch or tag reaches (otherwise `not our ref`), up to 100,000 wants over v2 (a partial clone's checkout asks for every file it lacks at once) and 10,000 over v0; a fetch has no object cap: its pack streams in waves of 256 commits (memory is a wave's, not the history's), and it fails with a `remote:` error naming partial or shallow clones when it would need more than 40,000 object-store reads (pushed history is read in ranges, so this binds only repositories without bundles) or 15 minutes. Not served yet: annotated tags, push options, and fetching history imported into Artifacts (use the helper). The platform Worker sets `limits.subrequests=50000` because each Git object sent or received is one R2 read or write.

The `yoneda::` remote helper (`git-remote-yoneda`, also `yoneda clone`) fetches objects through the API in batched pages and downloads blobs over 2 MiB on their own. A page or download that is cut off, or sends nothing for `YONEDA_IDLE_TIMEOUT_SECS` (default 30), resumes from the last whole object or byte offset (`Range`) instead of starting over; one object fetch gives up after `YONEDA_FETCH_BUDGET_SECS` (default 1800) with an error naming the request it waited on and how many objects arrived.

A push to a working branch with no open change request prints `open a change: yoneda change create <branch>`. A change lands on main unless `--base <branch>` names another existing branch; `yoneda change land` lands its head on that base, gated by approvals and required checks only when the base is protected (main, release). Approving a change is a review of its head commit by an account other than the head's author: the platform refuses an author's own review, also through a repository token the author created (a token reviews for the account that made it).

## Quarantine and purge

The owner (or an admin) withholds content without rewriting any commit id: `POST /repos/:id/quarantine {path, ref?, reason, retain_days?}` (or `{blob, path?}`, or `{session}` for a session record's text). Trees, commits and ids stay; the change is in force in every isolate before it answers (about one second). `GET /repos/:id/quarantine` lists records (target, path, state, reason, actor, times); records are never deleted.

- Reads of a quarantined blob answer HTTP 451 `QUARANTINED` naming the blob and path: file reads at any ref or commit, `POST /objects`, `GET /objects/<id>`, blame, checks (a seed or tree holding it is refused), and forks reading it from their parent. A diff lists the change with `patch_omitted: "quarantined"`. Search lists the file by path only (`skipped: quarantined`); indexes built before are never read again.
- Git over HTTPS (and SSH, which bridges onto it): a fetch whose pack would carry the blob gets `ERR QUARANTINED: Blob <id> (<path>) is quarantined…` before any pack byte, so Git prints `remote error:` and writes nothing; it never receives a pack missing an object. `git clone --filter=blob:none` gets its pack; its checkout's lazy fetch gets every other file, with the refusal as a `remote:` line, and Git reports only the withheld path as not fetched (a sparse checkout that excludes it checks out cleanly); a lazy fetch of withheld blobs alone gets the ERR. `POST /clone` (a direct Artifacts clone) is refused while anything is withheld.
- A session record reads with `summary`, `transcript_ref` and `transcript` null and `quarantined: true`, and its stored transcript answers 451; the pages show a marker. Symbols and facts of a quarantined blob answer 451, and views leave the file out. Stored full-clone packs (`PACK_CACHE=on`) are neither served nor stored while anything is withheld.

`POST /repos/:id/quarantine/<record>/release` serves a quarantined target again. Purge runs once the retention (default 7 days) passes, in the `platform_quarantine` queue job, or at once with `POST /repos/:id/quarantine/<record>/purge {confirm: <target id>}`. It deletes the blob from R2 (store of record, cache key, the R2 object store's copy), zeroes its frame in push bundles, drops this colo's Cache API copy, and deletes the repository's derived caches (search indexes, stored clone packs, symbols, facts, views) and warm-start seeds, all rebuilt on demand; a session record's text is cleared and its stored transcript document deleted. A purged blob stays withheld forever, so that repository no longer uses stored full-clone packs (`PACK_CACHE`; a known cost: full clones build their pack each time). Artifacts deletes no single object, so a blob's purge retires the repository's own Artifacts mirror: the quarantine job copies everything the mirror holds into the store of record (withheld blobs never), switches the repository to `object_store: platform:<id>` (no mirror: clones come from the platform's Git over HTTPS, and nothing is projected any more), then deletes the Artifacts repository. `GET /repos/:id/quarantine` shows it: each record's `mirror` (`retiring`, then `retired`) and the retirement's `mirror.state` (`copying`, `switched`, `retired`) with `detail` when a run stopped (the job tries again). Commits being prepared for a push to the mirror when the purge lands are refused once (`NOT_FOUND`; retry). Not deleted, and never served: other colos' Cache API copies (they age out), and the copy in each fork's own Artifacts store (an Artifacts fork copies its parent's; only a purge in that fork retires it). A later push of the same bytes stores them again but they are still never served. Quarantine is not credential revocation: rotate a leaked secret.

## Stock Git over SSH

`git clone ssh://git@<ssh host>/<repo-id>.git` (user `git`, public-key authentication only) with a key added under Settings → SSH keys, `yoneda ssh-key add ~/.ssh/id_ed25519.pub` or `POST /api/v1/ssh-keys {title, key}` (Ed25519, ECDSA P-256/384/521, RSA ≥ 2048 bits; a key belongs to one account at a time). A key acts as its account with `repo:read` to fetch and `repo:read`, `repo:write` and `repo:land` to push; removing it refuses the open session's next request and every new connection at once. Fetches need protocol version 2 (Git 2.26+ default; v0 is refused with how to switch); pushes are v0 as over HTTPS, delete-only pushes included. `ssh -T git@<ssh host>` greets the account.

How it runs: one `SshGateway` container (`cloudflare/ssh-gateway/Dockerfile`: crate `backend/crates/yoneda-ssh-gateway`, its own workspace, plus cloudflared) verifies the key's signature, asks `POST /internal/ssh/lookup` for its account, takes a ten-minute `ysh_` token for one repository and service from `POST /internal/ssh/session` (both with an HS256 JWT signed with `SSH_GATEWAY_SECRET`), and bridges Git's SSH transport onto `/git/<repo>.git` smart HTTP; it reaches the platform only through the Worker itself. `SSH_FRONT_DOOR` picks how clients reach it; `/health` reports it as `ssh` (`tunnel`, `connect` or null), and `GET /api/v1/ssh-keys` returns `ssh: {front_door, host, clone_url, ssh_config}` for clients.

**Tunnel front door (`tunnel`, dev).** The gateway runs `cloudflared tunnel run` beside itself with `SSH_TUNNEL_TOKEN` (as `TUNNEL_TOKEN` in its environment, HTTP/2 transport) and restarts it if it exits. Setup, once per environment:

1. Create a remotely managed tunnel (Networking → Tunnels), add a published application route: hostname `ssh.dev.yonedarepo.com` (prod `ssh.yonedarepo.com`), service type SSH, URL `localhost:2222` (the gateway's port inside its container).
2. Do **not** add an Access application for that hostname (and keep wildcard Access apps off it). Without one, `cloudflared access ssh` connects straight through: it dials the hostname first and only runs the Access login when the edge answers with an Access redirect (cloudflared `carrier/websocket.go`, `createWebsocketStream`). The gateway's key check is then the only authentication, as with any Git host.
3. Put the tunnel token in the secrets file as `SSH_TUNNEL_TOKEN` and deploy.

The platform Worker's cron (`* * * * *`; a new cron can take up to 15 minutes to start firing after a deploy) and `/health` (at most once a minute per isolate, so the deploy's health check starts it at once) call the gateway's `keepAlive`: it starts the container after a deploy or crash and the container never sleeps while the tunnel is its front door, so exactly one gateway (`ssh-gateway-0`) runs. Cost: basic instance (1/4 vCPU, 1 GiB, 4 GB) always on is 730 GiB-hours of memory and 2,920 GB-hours of disk a month, about $6.35 + $0.69 after the included 25 GiB-hours and 200 GB-hours (if checks have not used them), plus active CPU only (an idle gateway uses little); about $7 a month per environment. `lite` (1/16 vCPU, 256 MiB) would be about $1.75 but leaves little memory for concurrent clones. Tunnels themselves cost nothing.

Troubleshooting with `wrangler tail <prefix>-platform`: `ssh.keepalive` (who woke it, whether it started), `ssh.container_started` / `ssh.container_stopped` / `ssh.container_error`, and the gateway's own reports `ssh.gateway.started`, `ssh.tunnel.started`, `ssh.tunnel.connected` (cloudflared's first edge connection) and `ssh.tunnel.exited` (exit code and cloudflared's last 20 lines). `ssh.gateway.lookup_failed` / `ssh.gateway.session_failed` carry the URL and HTTP status of a failed call to the platform (520: the container's route to `platform.internal` is not registered; 401: `SSH_GATEWAY_SECRET` differs). A tunnel that never reaches `ssh.tunnel.connected` is what makes `cloudflared access ssh` fail with `websocket: bad handshake` (the hostname answers 530).

Users, once per machine: the CLI installer (it brings cloudflared), then `yoneda ssh setup`, which writes this to `~/.ssh/config` with cloudflared's absolute path (shown under Settings → SSH keys for a manual setup):

```
Host ssh.yonedarepo.com
  ProxyCommand cloudflared access ssh --hostname %h
```

then `git clone ssh://git@ssh.yonedarepo.com/<repo-id>.git`.

**Inbound TCP front door (`connect`).** Spectrum to a Worker is a private beta: point a port-22 Spectrum application at the platform Worker and set `SSH_FRONT_DOOR=connect`; the Worker's `connect()` handler pipes the socket to the gateway's port. No client setup beyond the key.

Secrets: `SSH_GATEWAY_SECRET` (32+ random characters), `SSH_HOST_ED25519_KEY` / `SSH_HOST_ECDSA_KEY` (`ssh-keygen -t ed25519 -N '' -f k && base64 < k`, generated once and kept: new host keys break every client's `known_hosts`), `SSH_TUNNEL_TOKEN`. Locally, `node tests/ssh/e2e.mjs [--direct] [--docker]` runs the kit's flow against `wrangler dev` and the gateway (native or its image for this machine): by default through the platform's tunnel `ssh_config` with `nc` standing in for cloudflared; kit item 26 (`--ssh`) uses the real cloudflared against the live tunnel.

## Model checks

A policy runner `{"kind": "model", "rubric": "...", "model": "glm-5.3-flash", "allow_truncated": false}` (model and truncation optional) makes the platform grade each recorded commit with one model call: the diff against its first parent (as `GET /diff?patch=1`), the commit message as the stated intent, and the rubric. The call has no tools and no loop. The answer must be the JSON `{verdict, score, findings}`, and is recorded as the runner's check result with the findings, tokens and cost as evidence; list the runner in `required_checks` to gate landing. A diff over 60,000 characters, or with a file whose patch is unavailable, fails with "diff too large for model review" unless `allow_truncated` is set. A malformed answer, HTTP error or 45 s timeout is retried once and then errors: the run records no result, so the check stays missing and landing stays blocked (re-request it with `POST /commits/<sha>/check-runs`). Only the platform's own run may post a runner's check.

The call uses the platform Worker's own Secrets Store binding `REVIEW_MODEL_KEY` (store `3d9115d4fe864c54a792bcb790a763e3`, secret `ZAI`: the managed Z.ai key, owner decision 2026-10-27), bound to the platform Worker itself. Without it, model checks error and block. Live gate: `node tools/staging-realworld.mjs --model-check`.

## Local prerequisites

Use Rust from `rust-toolchain.toml`, Node 24, pnpm 11, Docker and `worker-build` 0.8.7. `cargo xtask doctor` checks installed commands and Docker availability. `cargo xtask setup` installs locked JS dependencies and creates an ignored owner token with private file permissions.

`cargo xtask check` is the required local gate: the crate layer table (`cargo xtask layers`, `xtask/layers.toml`), Rust formatting, Clippy with warnings denied, native tests, the actual Wasm build, TypeScript/Biome, workerd integration tests and browser production build. It requires no Cloudflare login and no model calls.

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

- `cargo xtask deploy --env dev|prod [--dry-run] [--confirm] [--allow-active] [--ship-head <sha>]` builds Wasm and the frontend, applies D1 migrations, deploys each Worker in cutover order with `BUILD_REVISION` = HEAD, uploads only missing secrets from the spec's secrets file and stops on the first `/health` mismatch. dev deploys only the tip of `dev`; prod only the tip of `main`, with `--confirm`, every dev Worker already at that commit or one of the same tree, passing real-world kit evidence for that tree (below) and no busy container instance. On a runner, `--ship-head` replaces the dev Worker and evidence checks with the merged PR head's statuses ([docs/ship-pipeline.md](ship-pipeline.md)). `deploy` without `--env` refuses. The kit's `browser` item must pass whenever the evidence lists it (`BROWSER_REQUIRED` in `xtask/src/deploy_evidence.rs` makes it mandatory once every kit run records it). A lock entry `pending` is a D1 database the spec declares but `infra up` has not created; configs generate with it and every deploy refuses it. The frontend is built with `VITE_YONEDA_API_ORIGIN` set to the env's platform API origin (its Custom Domain, else its workers.dev URL; `xtask/src/infra/api_origin.rs`), because Git, the CLI and MCP are served there and not by the front Worker; `--prebuilt` refuses a frontend built for another origin.
- `cargo xtask status|rollback --env X` shows live revisions and routes, or rolls every Worker back one deployment.
- `cargo xtask infra plan --env X` compares live Cloudflare state with the spec (create / unchanged / drift / extra / unverified) using a read-only API token (`CLOUDFLARE_API_TOKEN` or `--token-file`). `infra up` creates missing D1/R2/queues, records their ids and regenerates the configs (when that changes tracked files it stops: commit them, then rerun), then deploys; right before each Worker's deploy it detaches that Worker's hosts (Custom Domains and zone routes) from any other Worker holding them, printing each move. `infra down --confirm [--purge]` tears down dev or an `ephemeral-<id>` stack and is refused for prod; `infra smoke` checks the frontend, revisions and owner APIs.
- A spec's `retired` block names what the env used to run (exact names per kind, or one old `prefix`). `infra plan` lists live resources with those names as `orphan` rows; `infra prune --env X --confirm [--allow-active]` (`--dry-run` prints only) deletes exactly those rows: queue consumers, Workers (with their Durable Objects), container apps, workflows, the repositories of retired Artifacts namespaces (a namespace cannot be deleted), queues, D1 and R2 (a bucket must be empty). It refuses while any section is unreadable, while a retired name is bound by the dev or prod spec, and while a retired container app has busy instances. A prod deploy also checks the retired container apps for busy instances before its first Worker.
- GitHub runs two test workflows, and the ship ([docs/ship-pipeline.md](ship-pipeline.md)). **Check** (`.github/workflows/ci.yml`) runs on every pull request and push to `main` (and by hand): one job with warm cargo (`Swatinem/rust-cache`) and pnpm caches, about ten minutes: `cargo xtask layers`, fmt, clippy, the unit tests of core, store, platform, CLI, refmodel and xtask (no ignored or integration tests), the SSH gateway's fmt, clippy and tests, `worker-build --release`, `pnpm check` (Workers tsc and biome), the frontend tsc, `pnpm test:frontend` and `pnpm test:runtime`. **Full suite** (`full.yml`) runs in the ship, or by hand: the workerd suite in four shards plus their total, `pnpm test:platform`, `pnpm test:superfan`, the frontend build, and the runtime image when `cloudflare/containers` or `backend/crates/yoneda-runtime` changed since `main` (or when its `image` input is set). Together they are `cargo xtask check`. Changes only under `docs/`, to Markdown files or to `frontend/src/content/` start no Check run, and a newer push of the same branch or PR cancels the older run. A ship PR runs both through `ship.yml` instead. Workflow-dispatch buttons appear once a workflow is on `main`, the default branch.
- Dev deploys from the owner's checkout (`cargo xtask deploy --env dev`), and the real-world kit runs there. Prod deploys from GitHub: the owner says "ship", the kit passes locally, `cargo xtask live-tests` marks the commit, the PR from `dev` to `main` is opened, `ship.yml` runs on it and merging it runs `deploy-prod.yml` ([docs/ship-pipeline.md](ship-pipeline.md)). `cargo xtask deploy --env prod --confirm` from the owner's checkout still works as before. `deploy-dev.yml` (from source at the tip of `dev`, then the smoke) stays manual and disabled on GitHub for when development slows (`gh workflow enable deploy-dev.yml`). `cargo xtask deploy --prebuilt <dir>` and `cargo xtask live-check` remain, but no workflow uses them.
- Dev fixes deploy from the owner's Mac: `cargo xtask deploy --env dev [--dry-run] [--allow-active]` (no `--prebuilt`). It reads `CLOUDFLARE_API_TOKEN`, or else `~/.config/yonedarepo/deploy-dev.env` (mode 0600; never printed), builds Wasm and the frontend locally, and reuses the image the container apps run when its `--inputs-` record matches HEAD's inputs (no image build, no rollout). Otherwise it builds the image with `docker buildx --platform linux/amd64` (slow on arm64: the Rust build is emulated), pushes and records it, and stops before the rollout while any container instance is busy unless `--allow-active`. Then migrations, deploys, `/health` checks and the smoke, with a timing table. `cargo xtask runtime-image record --env dev --built-from <commit>` records the inputs of an image pushed before records existed (take the commit from the CI run that pushed it).

Workflow deploy tokens live in the `YONEDA_ENV_FILE` secret of the GitHub Environments `dev` (deploy-dev) and `production` (deploy-prod), one token each, never shared: account Workers Scripts Write, D1 Write, Workers R2 Storage Write, Queues Write, **Secrets Store Write** (deploying a Worker with `secrets_store_secrets` bindings fails with code 10021 on Read alone), Artifacts Write, Workers Containers Write, Account Settings Read; zone Workers Routes Write, Zone Read, DNS Write. `infra plan` needs only the Read variants plus Workers Containers Read.

Each env's secrets file (`~/.config/yonedarepo/staging.env` for dev, the name kept from before the rename; `prod.env` for prod; mode 0600) holds the Worker secrets its spec lists, such as `OWNER_TOKEN`, `VAULT_KEY` (64 hex), and superfan's `CF_ANALYTICS_TOKEN` (read-only: Account Analytics, Workers Scripts, Queues, Containers; superfan looks up the platform's queue, Durable Object and container ids by name with it) and `SUPERFAN_READ_TOKEN`. `deploy` uploads only the secrets a Worker does not have yet.

### Synthetic checks

Superfan's checks (`PROBES`, [observability-plan.md](observability-plan.md)) need two things `/health` doesn't:

- **Clone:** a small public repository, under 1 MiB, in each environment. Put its id in the secrets file as `PROBE_CLONE_REPO`; `deploy` uploads it. It's a secret so that the id stays out of the public repository, not because it's private.
- **Landing, dev only:** a repository of its own, with policy `{ "required_checks": [], "approvals": 0 }`, and a repository token with `read`, `write` and `land`: `PROBE_LAND_REPO` and `PROBE_LAND_TOKEN`. It takes 96 landings a day on one file, so never point it at a test repository you keep.

Without them those checks don't run and the others do. Then set `PROBES` or `PROBE_LANDING` to `on` in `infra/envs/<env>.json`, run `cargo xtask infra gen --env <env>`, and deploy.

## Public downloads: the CLI and the Claude Code marketplace

The front Worker serves `/install.sh` and `/install.ps1` (`frontend/public/`, with the site's origin filled in) and `/downloads/*` from the `<prefix>-downloads` R2 bucket (`DOWNLOADS`; layout in `cloudflare/worker/downloads.ts`). `cargo xtask infra up --env <env>` creates the bucket.

1. `cargo xtask downloads stage --env <env>` builds `yoneda` and `git-remote-yoneda` for darwin-arm64 and darwin-x64 (Cargo, on a Mac) and linux-x64, linux-arm64, windows-x64 and windows-arm64 (static musl and MinGW, `cargo zigbuild`: needs `cargo install cargo-zigbuild`, zig, and `rustup target add x86_64-apple-darwin x86_64-unknown-linux-musl aarch64-unknown-linux-musl x86_64-pc-windows-gnu aarch64-pc-windows-gnullvm`), packs each as `cli/<version>/yoneda-<version>-<target>.tar.gz` (`.zip` on Windows) with `SHA256SUMS`, `cli/latest.json` and `cli/LATEST`, and zips `plugins/yoneda` as `claude/yoneda-<plugin version>.zip` with `claude/marketplace.json` pinning its sha256. All under `target/downloads/<env>/`. `--targets linux-x64,linux-arm64` stages fewer.
2. `cargo xtask downloads upload --env <env> --dry-run` prints the wrangler commands; without `--dry-run` it runs them (needs `CLOUDFLARE_API_TOKEN` with R2 write). Version pointers (`cli/LATEST`, `cli/latest.json`, `claude/marketplace.json`) go last.
3. Check: `curl -fsSL https://<site>/install.sh | sh` on a Mac and a Linux box and `irm https://<site>/install.ps1 | iex` on Windows, then `yoneda auth token --show` after `yoneda login`.

Both installers fetch Cloudflare's cloudflared at a pinned version, each file checked against a pinned SHA-256, and a failure only warns. To move the pin, set the version in both scripts and take each asset's hash from the release: `gh api repos/cloudflare/cloudflared/releases/tags/<version>` lists a `digest` per asset, which is the one to pin. The release notes agree for the bare binaries, but their `darwin-*.tgz` lines hash the binary inside the archive, not the archive the installer downloads. Download the assets and compare with `shasum -a 256`, and on a Mac check `codesign -dv` names Cloudflare (team 68WVV388M8). There is no windows-arm64 build: install.ps1 uses the x86-64 one there.

The CLI version is the workspace version in `Cargo.toml`; the plugin's is `plugins/yoneda/.claude-plugin/plugin.json` (Claude Code updates a plugin only when it changes). Bump them before staging a new release: versioned files are served as immutable.

## Real-world kit

`node tools/staging-realworld.mjs` exercises a live environment the way a person, an agent client and a script use the platform. It runs against dev unless `--prod` is given, prints a pass/fail table and writes evidence to `.local/staging/`. Nothing in it starts an agent run; only the model-check gate calls a model (the platform's own AI check, under $0.01).

Credentials come only from 0600 files in `~/.config/yonedarepo/`, never arguments or output:

- `staging-kit.env`: `KIT_USERNAME` / `KIT_PASSWORD`, created on first run. A second kit account `<kit username>_m` with the same password is signed up on first use; the members gate shares repositories with it, and it authors or approves where the platform refuses an author's own review (items 18 and `browser`).
- `staging-bench.env`: `BENCH_KEY` of the dev bench Worker (`yonedarepo-dev-bench`), for the bursts and the webhook receiver. Without it those items skip.

The CLI items need `cargo build -p yoneda-cli --release` (`--cli-bin <dir>` names another build).

| Item | What must hold |
|---|---|
| `0` | `/health` revisions of the front and platform Workers (recorded with the evidence) |
| `browser` | Headless system Chrome signs the kit account in through the login form, creates a repository with "New repository", opens Code, History (creates a branch under "Branches and tags" and deletes it), Landings (the empty list), Settings (Landing rules, Connect) and account Settings; then the second account commits on a branch, the kit account opens a change for it by API, approves and lands it on the Landing page, and the page and the API both read it back `landed`. Needs Google Chrome; screenshots in `.local/staging/browser-<ts>/` |
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
| `27` | Git semantics (L1 of the agent e2e strategy, no model): over smart HTTP a protocol v2 clone, a partial clone (`blob:none`, lazy blobs) and a shallow clone deepened; two `yoneda::` clones push a branch, fetch and pull, merge `--no-ff`, rebase locally and force-push the branch (main refused), cherry-pick, revert, push an annotated tag, hit a same-line conflict that is refused naming the file and resolved with `git pull --rebase`, and open and land a change with the CLI; the repository MCP reads `git_log`, `git_context` and `git_sessions_recent`; a 1 MiB Git LFS file round-trips (when git-lfs is installed) |
| `28` | Agent hooks (L2, no model): a seeded session is recorded; a Claude Code session (`yoneda hook claude-*`) and the opencode plugin (`plugins/opencode`, with a stand-in opencode context) each start with a context naming the earlier summaries, record a read, are refused a plain smart-HTTP push while reads are pending, push with the read declared and record their session (cli, model, session id), read back newest first from `GET /sessions` |
| `29` | Real agents (L3, paid): `--agents N` opencode agents (default model `zai-coding-plan/glm-5.3`), each in its own `yoneda::` clone with its own repository token and the yoneda plugin, add a function to the same file and a line to the same changelog and push to main at once; then `--agents-wave2` more. Every agent's change is on main, no merge commit was made in a clone, every agent commit has an opencode session record, and each second-wave agent's start context names a first-wave session. Per-agent time limit `--agent-timeout` (s) and spend cap `--agent-budget` (USD, from opencode's reported costs); commands, events and hook logs in `.local/staging/agents-<ts>/`. Every agent runs only in its own Docker container (`tools/staging/agent-sandbox/`): its clone is the only host path mounted, no host environment, configuration, `gh` or SSH agent, the model credential arrives on stdin, egress goes only through a proxy on an internal Docker network to the model provider's API and the platform (`agent-sandbox/egress-proxy.mjs`; an agent does not start unless other hosts are refused, and the run's metrics list what was refused), and it refuses to start unless the clone's origin is the kit repository. The host checkouts (root, cwd, `$PWD`) and their remotes are snapshotted before and after: any change (HEAD, branch, status, local main, nested worktree, remote ref) fails the item loudly, so do not work in the checkout during an L3 run |
| `22` | Forks: the second account, refused a fork without read, forks a repository it reads, pushes a branch to the fork with stock Git and opens a change on the parent from it; the owner approves and lands it; a fresh clone of the parent holds the commit and its bytes; the parent refuses deletion (409) until the fork is deleted |
| `31` | Public and private repositories (`--visibility`): a repository created public is cloned by stock Git with no credentials at all (no helper, header or prompt), read through the API and the front origin and its page loaded without a session, listed by `/explore`; an anonymous push is refused. Made private, an anonymous API read is 404 and an anonymous fetch 401 within the 1 s access bound of the change's answer, `/explore` drops it and the owner still reads it; the repository is deleted |
| `33` | CTC: a Claude Code session (the real `yoneda hook claude-*`) on a branch touching a file an open Landing changes hears of it at its start and once per Landing and file on reads, and never of its own Landing; REST and the account MCP answer the same; a path-limited token gets 403 from `/context`, `/context/relevant` and `/ctc`, no path, and an MCP refusal; the radar by API, MCP and page: state, reasons, place, same-file and read overlaps, the page's 15 s poll and Refresh; with a ticket held in line (`tools/staging/ticket-line.mjs`: automation paused so it stays pending, then cancelled) a Landing that read what it writes shows `SEPARATION`, with `LAND_WHEN_CLEARED` off too |
| `34` | Land when cleared, needs `LAND_WHEN_CLEARED=on` and `LANDING_INSTRUMENTS=on`: an approval lands the head as `platform:land-when-cleared` with why on the record and on the page, High Risk holds, and a Landing behind a ticket is held with `SEPARATION` on the record and lands once the way clears. Off, it skips with what to do |
| `35` | Landings: every switch off on a new repository and a push opens nothing; the switch in Settings → Landing rules; a pushed branch gets an `auto` row that follows it, and main, a release branch and a branch on main get none; `yoneda change create` adopts it and a second create is refused; a closed Landing stays closed through a push, a landed branch pushed again gets a new row; a push to main lists as "Landed directly"; Planned, In flight, Cleared to land, Go-around, Landed and Closed on real pages; the rename (`/landings` and `/changes`, the tab, Clearance) |
| `36` | Flight plan and go-around: filed by CLI and MCP and shown on the Landing, or, while `0045` isn't applied, `NOT_SUPPORTED` from REST, CLI and MCP and "No flight plan" on the page; an open finding reaches `yoneda change show`, `yoneda context`, a session's start and `git_context`, is marked on an older commit after a push, and leaves when resolved; with `findings_block` a token's finding refuses the landing until resolved |
| `37` | Search across repositories: a word pushed with stock Git to a private repository is found by `GET /search`, `yoneda search --all`, MCP `search_repos` and the Search page; a stranger finds nothing, a member finds it, a removed member and a token allowlisted elsewhere don't, a revoked token gets 401, anonymous 401, a repository token 403; with 26 newer repositories it is reached by walking `next`, and by `--after` |
| `38` | Clone panel: no token line on a public repository, one on a private one, Copy puts the shown command on the clipboard, and at 320, 375 and 390 px the panel fits, commands stay on one line and the page doesn't scroll sideways |
| `39` | Admin, as the dev owner from `dev-owner.env` (no model, no money moves): Revenue's sum by API and page, a bad range, by month, refused to the kit account; `cargo xtask admin revenue-rebuild` refuses without `--confirm`, then changes no total; Traffic by API and page, and 30 marked page views at a unique path leave no count and no row. There is no unmarked control beside them (a tool may not send one), so a platform that stopped counting would pass that part |
| `40` | Org delete during create: nine rounds at offsets from -150 to +400 ms, and each of the two must win at least once; one side wins, or a repository is stranded. Then the org pages of `browser`, with the create's 50 s wait |
| `41` | Audit log, needs `AUDIT_LOG=on` on the platform and front Workers: 12 repository events on an org's repository reach its log with the actor; kind and actor filters, the chain's walk, both exports and the page read them back; a member who isn't an owner gets 403 and a personal repository reaches no log. Off, it skips with what to do |
| `42` | The shared empty state on Sessions, Landings (each filter) and CTC, wide and at 375 px: one, centred on its section, no box, no command syntax, at most one action, no table, and no intro line on CTC |

A full run (`node tools/staging-realworld.mjs`) runs every item except `model`, `hooks`, `members`, `reads`, `22` and `29`, which need a review key, a receiver, the second account or model spend and run only when named. A prod deploy refuses evidence with any item not `pass`, so a full run keeps `34` and `41` out of `items` while their switch is off and lists them under `not_run` with the reason; on, they run and count like any other. Options:

- `--only 0,6,7` runs the listed items; `--skip-bursts` leaves out 8–10.
- `--browser [--headed]`, `--model-check`, `--webhooks --receiver <origin>`, `--members`, `--forks` (item 22), `--reads-sessions`, `--visibility` (item 31), `--ssh [--ssh-host <host>] [--ssh-port 22]` (item 26, skipped while the SSH front door is off): one gate with item 0.
- `--git-semantics [--ssh]` (items 0, 12, 13, 18, 21, 23, 27, 17, and 26 with `--ssh`), `--agent-hooks` (0, 12, 28, 17) and `--agents N [--agents-wave2 2] [--agent-model <provider/model>] [--agent-timeout 600] [--agent-budget 2]` (0, 12, 29, 17; needs Docker and the host opencode's stored credential for the model's provider) are the agent e2e gates; evidence `git-semantics-gate-*`, `agent-hooks-gate-*`, `agents-gate-*`. Locally, without a model: `cargo build -p yoneda-cli && node tests/agents/e2e.mjs [--only 27,28] [--fake-agents 4]` runs 27 and 28 (and 29 with scripted agents standing in for opencode, in the same sandbox containers) against `wrangler dev`.
- `--agent-tools [--agent-tools-repo oss-commander] [--headed]` (item 30.6, dev only, the owner's account from `dev-owner.env` as for `--realuser`, which also runs it after 30.4): on an open-source test repository with Rust, TypeScript or JavaScript functions, through the repository MCP and REST, an authored contract read back (list, show, `yoneda context` in a clone changing the file) and stale after `symbol_edit` on a scratch branch; a pin kept through its branch's deletion and a vacuum, then released; a bisect over six scratch commits naming the one that breaks a tiny command check added to the policy for the run (restored after; check minutes recorded); then Agent tools → Contracts, Kept commits and Find a breaking commit in Chrome show those rows, with Agent tools the one highlighted sidebar entry. Scratch branches, the pin, the runner and the tokens are removed; the contract record stays.
- `--memory-test [--memory-runs 6] [--memory-parallel 1] [--yes]` (dev only, refuses `--prod`; the owner's account from `dev-owner.env`; needs Docker, the host opencode's credential and `cargo build -p yoneda-cli --release`): stage 2 of [landings-plan.md](landings-plan.md), real agents in the sandbox, plain clone against memory and context, one fresh fork per run. It prints the estimate and starts only with `--yes`. Run it from a checkout nobody is working in: a new worktree or commit in it reads as host drift. Forks and tokens are removed on any failure and on Ctrl-C; a fork left by a killed process goes when the next run starts. Evidence `memory-test-<ts>.json` and `memory-test-<ts>/`; the run fills the plan's results section, to commit. Dry run without a model: `node tests/agents/e2e.mjs --only none --memory-stub 6`.
- `--feature-tests [--headed]` (0, 12, 33-44, 17, no model): this week's features, with one session held for the whole run: the browser items reuse its cookie, the second account is signed in once, and only `39` signs in again, as the dev owner, and out at the end. Evidence `feature-gate-*`, also for an `--only` naming nothing else, so neither reads as a full kit.
- `--flight-path [--headed]` (0, 12, 43, 44, 17, no model): one Landing through the whole Flight Path, then its failure cases ([flight-path-test-plan.md](flight-path-test-plan.md)). `--only 0,12,45,17 --yes` flies it with a real agent in the Docker sandbox, on a model's quota.
- `--memory-page [--headed]` (0, 12, 32, 17, dev only, no model): a session record, its transcript and context delivery behind a change, through the API and in Chrome; evidence `memory-page-gate-*`.
- `--api <origin>` is the platform API host for the CLI items (default `https://api.dev.yonedarepo.com`); `--origin`, `--platform` and `--client` name the front, platform and bench Workers.
- `--cleanup-repos <prefix>` deletes the kit account's leftover repositories with that name prefix and exits. Every item deletes the repositories it creates, pass or fail (the fanout bench too), so leftovers come only from runs killed mid-item or from runs before this change (2026-10-27): `kit-clone`, `kit-check`, `kit-burst`, `fanout`; and `kit-ssh` (item 26, before 2026-10-28).

Evidence is `realworld-<ms>.json`; a single gate writes its own name (`browser-gate-*`, `model-check-*`, `webhook-gate-*`, `members-gate-*`, `reads-gate-*`). Evidence records the tree of the commit item 0 saw live. After a full pass, `cargo xtask live-tests` sets the `live-tests` commit status a ship needs. A local prod deploy reads the newest `realworld*.json` and refuses unless its item 0 recorded both Workers at the commit being deployed or one of the same tree, its tree (when recorded) is that tree, and every item passed.

**Prod smoke.** After a prod deploy (`deploy-prod.yml` has run `cargo xtask infra smoke --env prod` on a merged ship PR; this one stays on the Mac), run the live revisions, the browser gate and the CLI items against production (they create and then delete their own repositories):

```sh
node tools/staging-realworld.mjs --prod --only 0,browser,12,13,14,15,16,17
```

`--prod` switches the front, API and platform hosts to `yonedarepo.com`, `api.yonedarepo.com` and `yonedarepo-prod-platform`, and writes `prod-smoke-<ms>.json`, never `realworld*` (which the prod guard reads as dev evidence). The kit account and its second account are created on production on first use. Always pass `--only`: the bursts and gates are for dev.

## Importing history behind the head

`FAST_IMPORT=on` (unset or anything else: an import records all of its history, then lands main) lands main at the remote's head from the import's own request, in its 30 s after the answer: it asks the remote for its default branch beside the request's writes, asks Artifacts for the remote, looks every 0.25 s until Artifacts has it, reads the log (1 call per 1,000 commits) and lands (`startImport`). The Workflow repeats all of that harmlessly, so what the request does not reach, it does; then it records the first-parent history newest first, a Workflow step per 250 commits (`cloudflare/worker/repo-import-fill.ts`, `repo_store/history_fill.rs`). Budget and bench: `docs/load-testing.md`, `tools/import-bench.mjs`. No schema change: the state is main's imported head and where its `ref_chain` stops, so turning the switch off mid-import leaves the running fill safe.

`DIRECT_IMPORT=on` (with `FAST_IMPORT`, `PACK_CACHE` and `PUSH_BUNDLES` on; unset or anything else: Artifacts' fetch alone) also fetches a public `https://github.com/<owner>/<repo>` from the Worker, beside Artifacts' own fetch: main lands from that pack, usually first, and the same pack answers `git clone` and fills history (`cloudflare/worker/repo-import-direct.ts`). Any other remote, a pack over 24 MiB or 40,000 objects, and any failure leave the import to Artifacts as before, and Artifacts still ends up holding the whole history. No schema change: turning it off affects only new imports, and a repository imported either way reads the same. Numbers and limits: `docs/direct-import.md`.

While history fills:

| What | Answer |
|---|---|
| Files, tree, blob, search of code, status | Work, at the head |
| `repo_status`, log, path history, blame, record search, agent context | Carry `history_import {recorded, total}`: what they list is the newest part of the history. `yoneda log` says so on stderr |
| A commit not recorded yet | 404 saying history is still importing |
| Clone through `git-remote-yoneda` | Works: the object store holds all of it, and main is projected right after landing |
| `git clone` and `git fetch` over HTTPS or SSH, `--depth` too | Work, during the fill and after it. With `DIRECT_IMPORT` a clone of the head, at any depth or filter, is served from the pack the import stored, before Artifacts has finished; otherwise the pack streams from the object store (`cloudflare/worker/repo-git-mirror.ts`) when every want is a branch or tag it holds and nothing is withheld. A `--filter` clone receives every file. If the object store cannot answer within 20 s: 409 or an `ERR` line, `IMPORT_IN_PROGRESS`, saying how long it waited and to try again, while filling; after that as before, `held only as imported history`. No fetch is ever built from the recorded part: `repo_git_walk` refuses while filling, whatever the switch says |
| A `yoneda::` clone | Whole: it reads commits it has no record of from the object store, and fails rather than cut history short |
| Landings, pushes, branches, tags, releases, forks, bisects, break-glass, purges | Refused, 409 `IMPORT_IN_PROGRESS`, naming how far it has come. A commit may still record from the published head; its landing is refused |

A fill never leaves a repository refusing work. A commit of more than 10,000 changed files, or a wave that still fails after 5 retries (about 2.5 minutes), ends the fill where it reached: the repository holds what a capped import holds (`repo_record_imported_end`), takes changes at once, and says for good that only the newest N of M commits came in (`history_stopped` in `repo_status` and every read of history; the note is a row in `repairs`). A Workflow that died without doing that is ended by the next `GET /repos/:id/import`. A head of more than 10,000 changed files lands alone, with no changed paths recorded for it. A Workflow that fails before main lands fails the import, as with the switch off.

## Repository size

A repository has two limits. **Size** is its Git objects, which live in object storage; the cap is 10 GB, published with wave 2 of migration 0046, once something enforces it. **The history database** is the next section: it grows with activity, not code, and its limit is internal.

`REPO_SIZE_GUARD=on` (unset or `off`: nothing is refused; a byte count sets another limit, for tests only) makes a repository at 10,000,000,000 bytes answer 507 `REPO_SIZE_LIMIT` to pushes (at `repo_git_access`, before a push stores anything) and new commits. Reads, landings of recorded commits, branch moves and deletes go on. A push that starts under the cap finishes, so a repository can pass it by one push, at most 2 GiB. On for dev; off on prod until a ship turns it on.

The size is `repo_settings.git_bytes` (migration 0046), read with the row every command reads, so a refusal adds no read. It is a running total, and `repo_storage` answers it:

| Counted | How |
|---|---|
| A Git push | Bytes of its request, compressed as Git sent them; added with `repo_record_pushed` when it records a new commit |
| A direct import | Bytes of the pack it fetched |
| API commits, so `yoneda::` pushes | Blob bytes, uncompressed, reported from each isolate per MiB (`repo_size_add`); an isolate's unreported bytes are lost with it |

| Not counted | Why, and what would fix it |
|---|---|
| Everything from before migration 0046 | It starts at 0. Measure it once by summing `size` over R2 `list` of `platform/v1/<repo>/` (one Class A call per 1,000 keys), and add it through `repo_size_add`. Those are raw bytes, larger than a `.git` folder |
| History an import took through Artifacts | Nothing reports it: `repo.info()` has no size field. Artifacts' own limit bounds it, published as 1 GB for repositories created since 2026-09-29 and 10 GB before |
| A fork's inherited objects | A fork counts what it adds. Its parent's size isn't copied |
| Purges | The total never goes down |

R2 `list` on every push was ruled out as a new read per request. `SUM(size)` over `bundled_objects` was too, and it sees only bundles.

## Repository database size

New work stops at 9,400,000,000 bytes of `databaseSize`. This limit is internal: users see only the refusal, and the limits page says high activity has its own limit. A repository's Durable Object refuses writes at about 10.7 GB (`docs/global-scale-plan.md`, spike results), though Cloudflare publishes 10 GB, decimal. A commit shard is its own database with the same limits.

- **Watching.** `repo_storage` (the owner and the platform) answers `db_bytes` and row estimates per large table; `store_status` answers the same for a shard. The derive job samples it at most every 10 minutes per repository per isolate, in its existing `platform_activity` write (`db_bytes`, D1 migration 0010). Admin shows the largest repositories and one repository's live size under Repositories.
- **Alerts.** `repo.storage` is logged once each time a sampled size crosses 5, 8, 9 or 9.4 GB going up (`{event, level, repo, threshold, db_bytes}`; `level` is the line's own). A refusal for size logs `repo.full` (`{event, level, repo, operation}`), at most every 10 minutes per repository per isolate: a full repository stops landing, so the sampling job may never see it reach the limit. Superfan sends 8 GB in the digest, and 9 GB and the limit (either line) as urgent mail.
- **Refusing new work.** `REPO_STORAGE_GUARD=on` (unset or `off`: nothing changes) makes a repository at that size answer 507 `REPO_FULL` to commits, pushes, imports, new landings (one by one in `batch` mode), new branches and tags, Landings, comments, sessions, memories, releases and flight plans, and a shard refuse new records. Reads, projection, changeset records, hooks, adoption, compaction, queued landings, checks, reviews, moving and deleting branches, resolving comments, token revocation, quarantine and deletes keep working. A commit on main normally begins from the published head, so until the head next reloads a commit may record in its shard and be refused when it lands. A byte count in the variable sets another limit, for tests only. On for dev; off on prod until a ship turns it on.
- **What's above the limit.** 600,000,000 bytes up to Cloudflare's published limit, 1,313,108,480 up to the last size the spike accepted. What finishes there, measured on local SQLite with the full schema: one commit of 100,000 changed files, 63 MB, or 274 MB at the 512-byte path limit; about 2.9 KB per landing not yet projected (600 MB is 208,000 of them); at most 82 MB of pending hook events (computed); a schema-only migration, 20 KB.
- **Migrations on a full repository.** A migration runs in one transaction on the first request after a deploy, and a failure blocks every command, reads included. New tables, columns and small indexes fit. **One that writes rows in proportion to history doesn't:** `0042_search_text`'s index of changed paths added 17.7% to a database of path rows, about 1.7 GB at 9.4 GB, and one 950 MB transaction already resets an object. Do that work in small batches outside the migration.
- **At the limit itself.** A write past it breaks the Durable Object's instance: the failure is thrown out of the call and the next request gets a new instance. Clients get 507 `REPO_FULL` (Git: in the push report, or as the HTTP status), guard or no guard, and in that moment so does anything else in flight on that instance.

Rollout: D1 migration 0010 before the Worker, as the deploy does. Deleting data lowers the size at once, but delete in small batches: one 950 MB delete reset an object for minutes.

## Land when cleared

`LAND_WHEN_CLEARED=on` on the platform Worker (`infra/envs/<env>.json`; unset or `off`: no job is queued, and a repository can't turn the switch on) has what can clear a Landing queue a `platform_land_check` job for CTC (docs/landings-plan.md).

- **Rollout.** A queue job of a kind a Worker doesn't know is acked and dropped (`platformJob`), so deploy this code with the variable `off`, let the rollout finish, then deploy again with it `on`.
- **Rolling back.** Set it `off` first. A job that reaches a binary without the handler is dropped, and its Landing waits for its next trigger: nothing is lost, and nothing lands late by itself.
- **A Landing that didn't land.** Its page gives the reason, and `changes.clearance` keeps each decision with the head it judged. The next check, review, resolved comment or push tries again.

## Trimming commit data

Stage A of `docs/global-scale-plan.md`, item 3. All four switches are off until set to `on` in `infra/envs/<env>.json`, on the platform Worker. They affect new writes only: nothing already stored is rewritten, so existing duplicates, full chains and shard copies stay. Savings are unmeasured until the load tests run.

| Switch | With it on | Off again |
|---|---|---|
| `CHECK_EVIDENCE_ONCE` | A pass or fail keeps its evidence only in `checks`; the run reads it from there. An errored run keeps its own | Safe: readers take either form |
| `REF_CHAIN_SHARED` | A new branch's `ref_chain` stores only the commits above main's chain, not up to 5,000 rows. Its path history reads on into main's chain, so it can reach further back than the 5,000 commits a branch read before | Safe: readers take either form, and a branch rebuilds in full when it next leaves its rows |
| `SHARD_FORGET_RECORDED` | A projector drops a shard's copy of a batch-landed commit once the authority holds it | Safe: copies just stop being dropped |
| `COMPACTION_SWEEP` | The every-minute cron sends a `platform_compact` job for each repository in that minute's id range, so every repository's object is woken once a day | Safe: only a landing starts compaction again |

**Turn on `CHECK_EVIDENCE_ONCE` and `REF_CHAIN_SHARED` only once a build with their readers is the oldest you would roll back to.** An older build reads a stored-once run's result as null, so `/check-runs/:id/log` answers 404, and reads a shared branch's path history short, with no error. Going forward again restores both, as nothing was lost. The other two switches have no such limit.

**A stalled log raises an alarm.** Unprojected changesets and undelivered webhook events hold compaction with no limit. `repo_compact_plan` and `GET /repos/:id/compaction` answer `held` with what holds a due segment, and `stalled` once it is 8 segments or a day overdue. `compaction.stalled` is logged when a job finds that, and Superfan opens a `compaction_stalls` finding on `derived_jobs` from one such line, open for 20 hours after the last. A job has to run to see it: after a landing, or daily with `COMPACTION_SWEEP` on. `compaction.sweep_full` means a minute's range passed 1,000 repositories and some went unvisited.

## Creating a repository's store

Artifacts is the projected mirror: a new repository's commits, pushes, reads and clones go through its authority, R2 and the outboxes. With `ASYNC_STORE=on` on the platform Worker (`infra/envs/<env>.json`; unset or `off`: the create waits for Artifacts, up to 28 s over three attempts), a create answers without Artifacts, and a `platform_store` queue job creates the store.

- **Rollout.** A queue job of a kind a Worker doesn't know is acked and dropped (`platformJob`), so the order is: deploy this code with the variable `off` (nothing sends the job), let the rollout finish, then deploy again with it `on`. To roll back, set it `off` first and let the queue drain.
- **Clones.** `git clone` over HTTPS, SSH and `yoneda clone` never need the store: a store that isn't there reads as empty, and the store of record has the objects. `yoneda clone --offline` asks `POST /repos/:id/clone`, which waits up to 20 s for the store and then answers a retryable 503; a commit too large to stage waits the same. A fork of a repository without a store gets an empty store of its own, by its own job.
- **Failures.** The job comes back as a fresh delayed message (5 s doubling to 15 minutes), so it never reaches the dead letters. After 200 attempts, about two days, it logs `store.create_failed` at error level and stops. The repository keeps working without a mirror; `repo_status` shows its projection waiting. A projection that finds no store ends, and the job asks for it again.
- **Measuring.** `node tools/staging/create-bench.mjs --runs 3 --creates 20` (the kit account on dev) prints min, median and max of the create and of each server-side phase. Budget of a seeded create with the job: median under 2 s, slowest under 4 s, and no `create.store` phase (before it: median 3.5 s, with stalls the bound turned into 503s).

## Erasing deleted repositories

Deleting a repository leaves a tombstone and purges its objects. With `REPO_ERASE=on` on the platform Worker (unset: nothing changes), the purge also deletes `derived/v1/<repo>/` (search indexes, packs, symbols and facts hold file content), and its last act queues `platform_erase`, which empties the rest; `infra/envs/<env>.json` carries the variable. Nothing assumes the purge follows the deletion closely.

- **Order.** It waits while `hook_outbox` holds payloads for an active hook, sending their jobs again every 5 minutes, with no time limit: a hook that keeps failing is switched off after 50 failures (about 11 hours), and is then given up on. Then it clears all 64 commit shards (`deleteAll`, then a seal: a shard woken later answers GONE and recreates nothing) and the combiners, purges again, and deletes the authority's rows in transactions of at most 2,000 rows or 8 MB. It never starts while a fork is listed.
- **What stays.** The repository object, with its empty tables, its migration record and a `repo_settings` row holding only `deleted_at`, so it keeps answering GONE. `object_store='erased'` marks it. `repo.erase` log lines carry ids and counts.
- **Recovery.** Every part repeats safely. A job lost to the dead-letter queue leaves a tombstone partly erased and still answering GONE; run the backfill.
- **Backfill.** `cargo xtask admin erase-backfill --env dev --dry-run` lists tombstones and their sizes without changing anything; `--confirm` erases them, one at a time, and needs `REPO_ERASE=on`. It walks Cloudflare's object list (ids only), so it wakes every repository object, and needs `OWNER_TOKEN` in the secrets file and a token that can read Durable Object namespaces in `CLOUDFLARE_API_TOKEN` or `--token-file`. `--delay-ms` (default 1000) spaces objects, `--limit` stops early and `--after <cursor>`, printed per page, resumes. A tombstone whose store does not lead back to its object id is reported as `unnamed` and left alone.


## Search across repositories

`NEWSLETTER=on` on the platform Worker opens the Flight log sign-up at `/updates` (`cloudflare/worker/platform-newsletter.ts`, D1 `newsletter_subscribers`). Off, the page says Coming soon with no form, and nothing is stored or sent; unsubscribe links keep working. To turn it on: list this data in `frontend/src/content/legal/privacy.md` first (its own promise), put a generated `NEWSLETTER_KEY` in the env's secrets file, deploy, then set the switch in `infra/envs/<env>.json`. The key signs unsubscribe links, which never expire: changing it breaks every link already mailed. Double opt-in goes through Resend like the account emails. An address gets at most three confirmations a day, and the answer never changes, so the form can't show who is on the list; addresses nobody confirms are deleted after 7 days. The Overview shows the confirmed count. `cargo xtask admin newsletter-export --env <env> --out <file>` writes the confirmed list to a new CSV (mode 0600), each row with its unsubscribe link; each page is audited.

`ACCOUNT_SEARCH=on` on the platform Worker serves `GET /api/v1/search`, the `search_repos` MCP tool and `yoneda search --all`, and keeps a summary per repository in its owner's directory (`search:<owner>` instances of `WorkspaceAuthority`, one `workspace_records` row per repository). Off, nothing is written and the route answers 404; the website then asks each repository itself, as it always has. `infra/envs/<env>.json` carries the variable. Budget and known costs: `docs/global-scale-plan.md`, item 5.

- **Rows are rebuildable.** A missing row only means the repository is always asked. Nothing is read from a row but a yes or no.
- **Backfill.** Derive writes a summary after a landing, so older repositories have none until their next one. `cargo xtask admin search-backfill --env dev --owner <account> --dry-run` counts an owner's repositories; `--confirm` queues a summary job for each, a page of 100 at a time. It needs `OWNER_TOKEN` in the secrets file and takes one owner, so a large account can be done on its own. `--delay-ms` (default 5000) spaces pages. Repeating it is safe.
- **Turning it off and on.** With the switch off, deletes, quarantines and visibility changes don't reach the directory. After turning it back on, run the backfill for any owner who had rows.

## Undo window

`REPO_UNDO_DAYS` on the platform Worker sets how long a deleted repository can be restored (30 is the plan; dev can set a fraction of a day). Unset, empty or 0 means an immediate purge, as before. A value that is not a number means 30, never zero. It is off by default in `infra/envs/<env>.json`; a non-zero value there is the whole switch.

- **What changes.** The tombstone, revoked tokens, freed name, unlisting and `repo.deleted` happen at delete. The purge, the erase, managed review cleanup and a new `repo.purged` webhook happen at `deleted_at` plus the window. `repo.deleted` then carries `purge_at`.
- **How it runs.** The delete writes `deleted_repo:<id>` in the owner's authority and a row in D1's `platform_deleted_repos`. The every-minute cron sends a normal `platform_purge` (`due-<repo>`) for up to 50 due rows, and sends again after 6 hours while a row remains: a job lost, or a legal hold. No future purge ever sits in a queue, and `SourceRepository` has no alarm. `repo_purge_target` refuses with `NOT_DUE` until the window has passed, so a stray job acknowledges and lists the repository instead.
- **Restore.** `POST /repos/<id>/restore {name?}`, by whoever may delete it. A purge that started wins, for good; `policy_digest` marks that tombstone. Past its due time a repository nothing purged yet (a legal hold, a sweep not there yet) still restores. Tokens stay revoked. A managed agents connection needs its owner to save the agent once, which replaces the token.
- **Deploy order.** D1 migration `0011`, applied by the deploy. Then the managed Worker (it reads `purge_at` and `repo.purged`), then the platform with the variable still unset, then set the variable. A managed Worker older than the platform clears reviews at delete, so a restored repository would lose them. Setting the variable to unset is the rollback: new deletions purge at once, and repositories already listed keep their due time and can still be restored, because the sweep always runs.
- **Older code.** A build without the window leaves listed repositories alone: nothing sends their purge. A job already sent to the queue is the one exception, and the sweep sends only what is due.
- **An org deleted during the window.** Nobody can restore its repositories any more, as only its owners could, and its name is retired for good. They purge on schedule. The org's delete page warns; a hold refuses the delete.
- **Operator.** `POST /admin/repos/<id>/purge-now` purges one deleted repository at once. It is audited and refused under a hold, and there is no public way to skip the window: the window exists to survive a stolen token. The kit calls it after every deletion when the window is on and `OWNER_TOKEN` is in `staging.env`. `POST /admin/repos/<id>/purge-orphan {confirm: <name>}` deletes and purges a live repository whose org is gone, which nobody else can reach. It is audited as `repo.purge_orphan`, refused under a hold even with `LEGAL_HOLD` off, and refused for any owner that is not a deleted org, a provisioned workspace with no record included. `POST /admin/deleted-repos/rebuild {owner}` rebuilds one owner's D1 rows from its records; `cargo xtask admin erase-backfill --confirm` finds tombstones with no row, and each goes back on the schedule.
## Operators' billing

The Billing section of an admin user page, and refunds, disputes and the nightly reconcile behind it. Off by default: without `ADMIN_BILLING=on` the routes answer 404 and the new Stripe events are ignored.

To turn it on:

1. Create a Stripe restricted key with **Refunds: Write**, and put it in the env's secrets file as `STRIPE_REFUND_KEY`. Without it the refund route answers `NOT_CONFIGURED`. `STRIPE_SECRET_KEY` never refunds.
2. Add `charge.refunded`, `charge.dispute.created` and `charge.dispute.closed` to the Stripe webhook endpoint (`https://managed.<env host>/stripe/webhook`).
3. In `infra/envs/<env>.json`, set `REFUND_MAX_USD` (per refund) and `REFUND_DAILY_USD` (per UTC day, across all accounts) on the managed Worker. Unset, every refund is refused.
4. Set `ADMIN_BILLING` to `on` for the managed and platform Workers, run `cargo xtask infra gen --env <env>`, and deploy.

How it behaves:

- **Credit is spent oldest first**, so promotional credit goes before a later top-up. A top-up's unspent credit is what the balance still holds of it. Refunding more needs the spent-credit override; leaving the balance negative needs its own flag.
- **A refund cannot be split by a crash.** The ledger records it and takes the credit first, then Stripe is asked under the idempotency key `refund:<id>`. An open refund is retried every 5 minutes by the ledger's alarm and on `charge.refunded`. Each attempt looks the refund up at Stripe first, because Stripe replays a saved 500 for a key and may prune a key after 24 hours. If Stripe refuses or fails it, the credit comes back.
- **A refund made in Stripe's dashboard** is what Stripe's running total shows beyond the refunds here. Its credit is taken even past zero, since the money has left.
- **A dispute** freezes what is left of its top-up's credit and stops the card being charged until it closes. If it is lost the frozen credit stays gone. The customer's own auto top-up switch is not touched.
- **Pausing billing** stops the card being charged. Credit already held stays usable, and agent runs go on.
- **Nightly reconcile**: the platform cron starts it at 03:17 UTC. Stripe names the accounts with a charge or refund in the last two days, and each is compared with its ledger. Read-only: differences are logged as `billing.reconcile.mismatch`, with a `problem` of `amount`, `refund_total`, `dispute_missing`, `charge_without_top_up` or `top_up_without_charge`. An account with no activity in those two days is not checked.
- **Audit**: each action writes `admin_audit` as `billing.<action>` before the money moves and updates it after. A row still reading `pending` is an action cut off midway; `unknown` means the managed Worker never answered, so check the account's refunds.

A refund Stripe reports as succeeded and later fails is not reversed automatically: nothing here listens for it. The reconcile logs it as `refund_total`.

### Revenue

The Overview shows platform-wide money with `ADMIN_BILLING` on. The platform asks the managed Worker (`/admin/billing/revenue`, with `MANAGED_ADMIN_TOKEN`), which reads its own D1, `<prefix>-managed-revenue`, and wakes no ledger. Every figure is the ledger's, in micro-USD, by UTC day.

To turn it on, after the steps above:

1. Run `cargo xtask infra up --env <env>`. It creates `<prefix>-managed-revenue`, whose lock entry says `pending` until then, and **every deploy of that env refuses while it does**. Commit the lock.
2. Deploy. The database's migrations (`cloudflare/managed/migrations`) run first, then the managed Worker, which binds it as `REVENUE`.
3. Run `cargo xtask admin revenue-rebuild --env <env> --confirm` once. Ledgers from before the rollup hold days it has never seen, and only a rebuild sends them. It wakes every account in `platform_accounts` and every repository owner, so it isn't for routine use.

How it stays right:

- **Outbox.** Triggers mark a day in the transaction that changes it, so no write path can skip the rollup. The ledger's alarm pushes marked days to D1 about 5 seconds later, outside any transaction, as whole rows. A D1 outage delays the figures, keeps the marks, retries each minute, and never touches a charge.
- **Retries.** `version` rises with each push, so a late retry can't overwrite newer numbers.
- **Checks.** The nightly reconcile holds the ledger to Stripe and the rollup to the ledger (`rollup_total`), for accounts with Stripe activity in the last two days.

What the figures mean:

- **Net revenue** is gross top-ups less refunds and disputes lost: money kept, on a cash basis. It includes credit sold and not yet used, and it is before Stripe's fees, which aren't in the ledger. A lost dispute counts the disputed money, not Stripe's dispute fee.
- **Refunds** count on the day Stripe confirmed them. A refund still open is under **Refunds awaiting Stripe**.
- **Credit outstanding** is each account's position now, not the range's. Sold credit is what the balance holds of top-ups under the oldest-first rule; the rest of a positive balance was given away.
- **Model cost** is the provider's reported usage at list rates, recorded per call. It isn't an invoice, so a discount or a provider's rounding isn't in it. **Margin** exists only for those calls.
- **Not recorded**: container cost, the cost of calls with an unknown outcome, and Stripe fees. Container time is charged at a flat rate with no cost beside it.
- **Usage includes free credit.** Model margin counts calls paid with promotional credit, which brought in no money. The free credit granted in the range is shown beside it.


## Internal accounts

Our own and test accounts stay out of every figure once `TRAFFIC_REPORT` is on.

`OPS_REPORT=on` on the platform Worker opens the admin Operations and Infrastructure tabs. Infrastructure also needs `OPS_RESOURCES`, ids and names as JSON: `{"scripts":["yonedarepo-dev-platform"],"queues":{"jobs":"<queue id>","checks":"<queue id>","dead-letter":"<queue id>"},"d1":"<database id>","r2":"<bucket>"}`. `wrangler queues info <name>` gives a queue's id; the database id is in `infra/envs/<env>.lock.json`. A queue whose label holds `dead` reads as dead letters. It uses `ANALYTICS_READ_TOKEN`.

`OPERATOR_AUDIT=on` on the platform Worker needs D1 migration `0015`, which a deploy applies first. Unset it to roll back: the log reads as it did, and the new columns stay, unused.

`VISITORS=on` goes on both Workers, and needs D1 migration `0016`. Keep it off until the owner has reviewed `privacy.md` (the lines are in [docs/analytics-plan.md](analytics-plan.md#phase-5-visitors-and-the-funnel)). Unset it to roll back: pings go back to what they were. Stored hashes stay until Analytics Engine drops them at three months, and the salts that made them are gone within two days.

`REPO_ANALYTICS=on` on the platform Worker, with `TRAFFIC_EVENTS` and `TRAFFIC_REPORT` on, adds the repository, bytes and a landing's outcome to its points, and opens the repository Insights page and the landing and repository reports. Unset it to roll back: the points go back to what they were and the page leaves the sidebar. Points already written stay until Analytics Engine drops them at three months, and they name a repository only by its id. Budget: [docs/load-testing.md](load-testing.md).

1. Run `cargo xtask admin internal --env <env> <account>...`. Add `--off` to undo it. Each change is audited.
2. It reaches every isolate within ten minutes. Points already written can't be taken back.
3. Repository tokens and signed-out readers name no account, so tools using them send the own-traffic mark (`tools/own-traffic.mjs`).

## Basin analytics

After a landing, the derive job streams one change record per landed version, merged commit and refused ticket to a Basin Pipeline (`CHANGELOG`, `cloudflare/worker/repo-changelog.ts`). The records land in an Iceberg table that Basin SQL queries. No binding means no stream, no cursor and no hold on compaction. **Analytics never stops a repository:** it is off the commit path, and it gives up history before it keeps a repository waiting.

Setup, once per environment. xtask does not know this resource kind, so `tools/platform-analytics.mjs` makes it. Dev first; bind prod after a soak.

1. Check the names and credentials, with no network: `node tools/platform-analytics.mjs setup --env dev --dry-run`. This proves names only, not access.
2. Create what is missing: `node tools/platform-analytics.mjs setup --env dev`. It reads `BASIN_TOKEN` (an R2 "Admin Read & Write" account API token) from `~/.config/yonedarepo/basin.env`, uses `CLOUDFLARE_API_TOKEN` or the wrangler login for the Cloudflare API, prints no credential, and is safe to run again. That token needs **Pipelines Write**, **Workers R2 Data Catalog Write** and **Workers R2 Storage Write**; it reads first, so a token without the first two stops before anything exists, and names what is missing. It answers the `binding` to add.
3. Add that binding to the platform Worker's `config` in `infra/envs/<env>.json`, then run `cargo xtask infra gen` and deploy. Dev has it; prod does not yet.

   ```jsonc
   // The stream's id, not the pipeline's.
   "pipelines": [{ "binding": "CHANGELOG", "stream": "<stream id from setup>" }]
   ```

4. Land something twice, wait out the first flush (3 to 7 minutes), then run `node tools/platform-analytics.mjs status --env dev`.

| Resource | dev | prod |
|---|---|---|
| Bucket (with Basin Catalog) | `yonedarepo-dev-change-log` | `yonedarepo-prod-change-log` |
| Stream | `yonedarepo_dev_changes_v1` | `yonedarepo_prod_changes_v1` |
| Sink | `yonedarepo_dev_changes_sink_v1` | `yonedarepo_prod_changes_sink_v1` |
| Pipeline | `yonedarepo_dev_changes_pipeline_v1` | `yonedarepo_prod_changes_pipeline_v1` |
| Table | `platform.changes_v1` | `platform.changes_v1` |

Limits: 20 each of streams, sinks and pipelines per account, 1 GB/s per stream, 5 MB per request (the job splits its sends at 4 MB). Streams, sinks and pipelines cannot be changed once created. Pricing was not found.

The stream's `credential_id` and `credential_kind` columns are reserved and empty. A record is built from the log entry and the repository's rows, and neither holds the credential, so filling them is a repository change in two waves (`docs/analytics-plan.md`, Phase 3). They exist now because the stream cannot take a column later.

**Gaps are expected and counted.** Queries on this table give a floor, not a total. `GET /repos/:id/changelog` shows the cursor: `version`, `sent`, `failures`, `last_error`, `stalled_since`, `gaps` and `last_gap`. Each gap also logs `changelog.gap` with its range and reason.

| When | What happens | Gap |
|---|---|---|
| A repository has no cursor (first job after binding, new repository, lost cursor) | That job records the head and sends nothing; nothing is held before it | Everything up to that head, including a new repository's first versions |
| Sends fail | The range goes back and later jobs re-send it, as long as the limits below allow | None |
| A segment is due and the stream is over 16,384 versions behind (`MAX_HOLD_VERSIONS`, `compaction.rs`) | The authority moves it anyway and answers `hold_released`; the cursor jumps to the head (`size`) | Cursor to head |
| Sends have failed for 7 days (`MAX_STALL_MS`, `repo-changelog.ts`) | The hold stops at once; the next job jumps to the head (`age`) | Cursor to head |

Refused landings are not skipped by a jump: they stay in the queue table, and compaction does not touch it. A cursor left below the floor still reads, through the archive, one 100-version page at a time.

**A record shows its rows as they were when it was read, not when it landed.** The log entry never changes, and compaction moves only log rows, so a version read from a segment gives the same record. A check, repair or review class recorded after the first read is missing from what was sent. A later read (a failed send given back, a rewound cursor) shows it under the same `event_key`. The queries group by key and take `MAX` per column, so a count that fell afterwards, such as a re-run clearing a failure, keeps its old value. Only an erase deletes these rows, and what the stream already sent stays in the table: identifiers, counts and times, never contents.

**Schema changes need a new stream.** Basin accepts an event that does not match the stream and drops it later without an error, so `records_and_the_stream_schema_agree` fails when `change_records.rs` and `cloudflare/basin/change-log.schema.json` disagree. To change a field, add a `_v2` stream, sink and pipeline, and bind the new stream. The `user error` metrics in GraphQL show dropped events.

## Regional clients and the same-region test

`yonedarepo-dev-region-na`, `-eu` and `-ap` are clients placed in each region, dev only (`tools/fanout-bench/region-worker.js`, [global scale plan](global-scale-plan.md#same-region-test)). `REGION_HINT_TEST` turns the test on; it's off, and absent from prod.

1. **Test buckets, once, before the first deploy.** A location hint counts only when a bucket is first made, and wrangler refuses a binding to a missing bucket: `wrangler r2 bucket create yonedarepo-dev-region-weur --location weur` and the same for `apac`. Each holds one probe object.
2. **D1 replication, for the replica figure:** `PUT /accounts/<account>/d1/database/<id>` with `{"read_replication":{"mode":"auto"}}`. Queries outside `withSession` stay on the primary, so the platform doesn't change. Turning it off takes up to 24 hours to stop.
3. **Run:** set `REGION_HINT_TEST` to `on` in `infra/envs/dev.json`, `cargo xtask infra gen --env dev`, deploy, `node tools/platform-region-matrix.mjs --yes`. Set it off and deploy again afterwards.
4. **A stopped run:** `node tools/platform-region-matrix.mjs --cleanup` deletes the test repositories in `.local/platform-live/region-hint-repos.json`, as their owners, and nothing else.

## Recovery

Queues are at least once: redelivery is expected, so consumers must be idempotent (leases, epochs, idempotency keys). The dead-letter queue is diagnostic transport evidence; the repository Durable Object's records remain authoritative. Check the repository's current state before retrying anything by hand.

Each `CheckContainer` runs one check and is destroyed afterwards. `yoneda-runtime check-server` writes the commit's files to a fresh directory and runs the policy's argv as UID 1000 with no capabilities, `NoNewPrivs=1`, a scrubbed environment, no network and a hard timeout that kills the whole process group. The image carries sh, git, Python, Node/npm with the workspace's TypeScript under `/opt/yoneda/node_modules`, and Rust; no agent CLIs.

A landing whose branch moved meanwhile is merged on the server or refused with `CONFLICT` and the paths; nothing rebases or overwrites automatically. Resolve in a new commit and land again.

Migration changes must be additive and appended. Check fresh, repeat and preceding-version upgrades locally, then apply D1 migrations before deploying code that needs them. Do not modify an already-applied SQL file or remove Durable Object class migration history. Roll back code only to versions compatible with the deployed schema; [docs/ship-pipeline.md](ship-pipeline.md#rollback) has the steps.

Object bundles: with `PUSH_BUNDLES=on` (dev) a large push stores its objects as a few R2 bundles under `platform/v1/<repo>/bundles/`, indexed by the repository authority (`bundled_objects`, migration 0030); code from before the bundle reader cannot read those objects. Before rolling back below it, set `PUSH_BUNDLES` to `off` in the env spec, regenerate and deploy, then roll back. Even then, objects already pushed into bundles stay unreadable to the older code until it is deployed again.

No live run, deployment or acceptance should be inferred from passing local tests. Record actual commands and outcomes in `docs/progress.md`.
