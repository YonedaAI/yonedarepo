# REPO-001: repository layout cleanup

Status: complete. Requested and implemented October 8, 2026. Repository deletion and per-run agent changes were integrated before this structural move.

The root mixes browser code, Rust crates, Cloudflare adapters and deployment configuration. Group these by responsibility while preserving the shared Rust application layer and the commands used for local development and deployment.

Implemented layout:

```text
frontend/                  Browser app, components, styles and browser build config
backend/crates/            Rust domain, application, binding, Worker and runtime crates
cloudflare/worker/         Thin TypeScript SDK and transport adapters
cloudflare/sites/          Isolated static-site serving Worker
cloudflare/containers/     Cloudflare container image/deployment configuration
cloudflare/migrations/     D1 discovery migrations; DO migrations stay in yoneda-app
cloudflare/wrangler*.jsonc Worker resource and environment configuration
xtask/                     Shared developer/deployment command implementation
tests/                     Cross-boundary platform and acceptance tests
fixtures/                  Small, clearly identified test/demo repositories
docs/                      Maintained architecture, setup, operations and evidence
context/                   Original design input
```

The final paths should follow actual build dependencies, not force Cloudflare application policy into TypeScript. Keep a small root with the workspace manifests, lockfiles, toolchain, engineering guide, README and license. Generated outputs, local state and diagnostic artifacts must remain ignored; audit obsolete scaffolding and duplicated documents separately from essential source.

Implementation scope:

- Inventory tracked files, build contexts, generated contracts and configuration references before moving anything. Preserve unrelated work.
- Move cohesive directories and update Cargo members, pnpm workspaces, TypeScript imports, Vite, Vitest/workerd, Biome, Docker contexts, Wrangler, xtask, CI and portable deployment generation in one usable slice.
- Preserve Worker names, DO class names and migration history, namespaces, queue/database/bucket identities and existing deployed data. This is a source layout change, not a resource migration.
- Update AGENTS.md, README, architecture and runbook paths. Document where each responsibility lives and retain a quick local start.
- Remove proven obsolete tracked files and dependencies; do not delete retained evidence or user's local data merely to make the root look smaller.

Acceptance: a fresh checkout passes `cargo xtask doctor` and `cargo xtask check`; local startup serves the platform and isolated sites Worker; Linux container build and generated portable deployment paths work from the new locations. Verify the generated configuration without creating or replacing Cloudflare resources. Record the final directory map and any remaining manual setup. No behavior changes or provider inference are required for this task.


## Implementation and verification

Moved the browser to `frontend/`, Rust crates to `backend/crates/`, and Cloudflare adapters, sites Worker, container image, D1 migrations and Wrangler configs to `cloudflare/`. Shared contracts, cross-boundary tests, developer commands and workspace manifests retain their root roles. Updated imports, workspace/lockfile importer paths, CI, Docker context, lint/typecheck/test configuration and portable deployment generation. No dependency versions changed. The sites Worker now participates in the formatter/linter; its existing formatting was corrected during the combined gate.

Resource preservation was checked against the preceding commit: platform and sites settings are identical apart from source/build paths, DO class migration history is unchanged, and all nine SQL migration files are byte-identical. Default state remains `.wrangler/state`; named deployment state remains `.local/deploy/<name>/state`. Setup privately copies a legacy root `.dev.vars` to `cloudflare/.dev.vars` only when absent, retains existing canonical/named files and credential backups, and never prints values. Repeating `cloudflare-configure` upgrades only known legacy generated source paths; custom settings and resource identities stay intact.

Verified on October 8, 2026:

- A fresh staged-source export with no ignored builds, dependencies, secrets or local data passed locked offline pnpm installation, `cargo xtask doctor` and `cargo xtask check`: 130 native Rust tests, 88 workerd tests, one Node runtime test, rustfmt, Clippy with warnings denied, actual workers-rs Wasm build, TypeScript/Biome and production browser build. Host build caches were reused; source and generated build inputs were recreated in the export.
- `docker build --platform linux/amd64 -f cloudflare/containers/Dockerfile -t yonedarepo-runtime:layout .` passed, including 29 Linux runtime tests. The existing Gemini CLI/Rust MCP smoke passed with `--network none` and `paid_inference: false`.
- A generated `layout-acceptance` deployment used placeholder account/database identities. All seven source/assets/container/context/migration/schema paths resolved. `cargo xtask cloudflare-deploy --name layout-acceptance --dry-run` successfully bundled both Workers without changing remote resources or credentials.
- `cargo xtask dev` applied local D1 migrations and served both Workers. `/health` returned HTTP 200 and identified YonedaRepo; `/` served browser assets and Chrome rendered the actual account-creation screen. The sites origin on port 8788 returned its expected empty-route 404. Existing local variables were verified byte-for-byte at the new path with mode 0600. Test servers were stopped afterward.
- `git diff --check` passed. Generated output, nested Wrangler caches, local variables, private recordings and diagnostic exports remain ignored and excluded from the Docker context.

Local logs and the browser screenshot are retained under ignored `artifacts/layout-cleanup/`. No production deployment, paid agent run or new user acceptance is claimed by this source-layout task. To upgrade an existing checkout, run `cargo xtask setup`; repeat the original named `cloudflare-configure` command if applicable. Raw Wrangler commands need the explicit intended config path. The README and runbook document these steps.
