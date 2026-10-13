# Isolated app execution

This Worker is a separate, private-binding app host. The platform remains the authority for candidate eligibility, publication versions, scoped capability signatures and current-policy checks. No deployment or paid inference was performed for this implementation.

## Platform interface

`PLATFORM.authorizeAppPreview(preview_id, token)` returns `TrustedApp | null`; `preview_id` is the raw `repoID:candidateID` string. `PLATFORM.publishedApp(repoID)` returns `TrustedApp | null`. The descriptor has `app_id` (repo ID), `revision` (exact commit), `policy_digest`, `bundle_digest`, `mode` (`preview` or `published`) and monotonic `generation`. See `contracts.ts`.

Preview gateway URLs are `${APP_ORIGIN}/v/${encodeURIComponent(preview_id)}/${encodeURIComponent(token)}`. They redirect to `https://preview-<first 24 hex characters of SHA256(raw preview_id)>.${APP_DOMAIN}/v/...`. Only that exact host can exchange the authorized token for the Secure, HttpOnly, host-only `__Host-yoneda-app-preview` cookie and redirect to `/`. Subsequent requests reauthorize the capability and verify the host. The compatibility `/p/:repoID` gateway redirects to `https://app-<repoID>.${APP_DOMAIN}/`; that hostname resolves the published descriptor by repo ID. Gateway origins never serve app code. Published repo IDs must fit a DNS label when prefixed with `app-`.

App mutations require an `Origin` header equal to their exact host origin. Input headers use an allowlist; the platform cookie, preview cookie, authorization, URL capability and internal authority metadata are removed before dispatch. Untrusted app responses cannot set cookies, emit arbitrary security headers or redirect to external hosts. CSP allows same-origin API requests and blocks browser outbound resources and service workers. Request/response bodies are bounded to 1 MiB/2 MiB; captured bundles are bounded to 2 MiB.

The apps Worker needs `APP_DOMAIN`, `APP_ORIGIN`, `PLATFORM_ORIGIN`, `PLATFORM`, `APP_RUNNERS`, `OBJECTS` and `LOADER`. `wrangler.apps.jsonc` uses explicit existing development service/R2 names and compatibility date `2026-10-12`. Its exact gateway Custom Domain is declared; the app wildcard is staged pending parent-owned `www` route protection and proxied wildcard DNS. See [the live routing/TLS review and activation ordering](ROUTING.md). The parent owns zone changes, production configuration and deployment.

## Capture and execution

`yoneda_core::build::AppManifest` is an optional version-1 `BuildProfile.app`, with `entrypoint`, `export_name`, ordered `migrations: [{version, sql}]` and initial `seed`. Core and host validation allow only bounded, single-statement additive migrations (`CREATE TABLE`, `CREATE [UNIQUE] INDEX`, `ALTER TABLE ... ADD COLUMN`) and initial `INSERT INTO` seed statements. Old build profiles remain valid.

`yoneda_runtime::app_bundle::capture(root, revision, policy) -> Result<Value>` captures compiled `.js`/`.mjs` files beneath the entrypoint's parent, rejects symlinks/nonregular files/reserved module paths, and binds the exact evaluator revision and normalized policy digest. `encode(...) -> Result<(String, String)>` returns the canonical bundle JSON bytes as a string and their SHA256 digest. JSON fields are `version`, `revision`, `policy_digest`, `manifest`, `modules`; module paths are relative to the captured directory, while the manifest retains its repository-relative entrypoint. Store the exact returned bytes at private R2 `sha256/<digest>` using create-only writes. `build::policy_digest(&Policy)` supplies the normalized, sorted-key fingerprint used by capture and evaluation.

Parent evaluator wiring calls encode after the exact source's protected behavioral checks, posts `/app-bundle` through the trusted broker, verifies returned digest, then reports `app_bundle_digest`, `app_revision`, `app_policy_digest`. Core rejects command-only success when an app is required. The ledger independently compares the app receipt to the candidate commit/current policy; successful protected command observations must include actual workerd behavioral acceptance. The booking oracle requires pinned Vitest, Cloudflare testing plugin and workerd dependencies outside the candidate checkout in the runtime image.

`AppRunner.serve(trusted_descriptor, sanitized_request)` is only called through the private DO namespace. HTTP access to the DO is rejected. Preview parents are named `preview:<raw preview_id>` so identical revision bundles from different candidates still have independent seeded databases. Published parents are named `published:<repoID>` with stable `appDB`. Supervisor authority is a separate SQLite database inaccessible to dynamic code.

Loader IDs are `app:<repoID>:<bundle_digest>`. Explicit `{ js: source }` module objects support `.mjs` paths. Loaded code receives an empty environment, `globalOutbound: null`, CPU limit 50 ms and subrequest limit 0. The trusted wrapper installs migrations/seed in a transaction before constructing the candidate App class. The host fences stale publication generations and changed migration history, then uses `facets.abort()` and `get()` to upgrade code while retaining storage. Facet restart does not reseed. App code has its own SQLite access; owner behavioral checks remain responsible for application data semantics.

## Local verification

- `cargo xtask doctor`: passed.
- `pnpm exec vitest run --config tests/workers/apps-canary.config.ts`: actual WorkerLoader/facet SQLite persistence and outbound-denial canary, 1 passed.
- `pnpm exec vitest run --config tests/workers/apps-runtime.config.ts`: 15 passed in actual workerd. Covers SQL API persistence, app/candidate/revision isolation, outbound denial, empty environment, publication fencing, migration history/restart/rollback, corrupt R2 and direct-access rejection, host capability exchange/revocation, exact-origin writes, credential stripping and the real event-booking multi-module API/UI.
- `cargo test -p yoneda-core`: 18 passed; app policy/report tests included.
- `cargo test -p yoneda-runtime app_bundle::tests`: 2 passed.
- Owned Rust formatting, apps TypeScript and Biome checks: passed. Scoped all-target Clippy passed after the parent fixed its concurrent `team_prompt.rs` ordering warning. The parent owns the final combined gate.
- `pnpm exec wrangler deploy --dry-run --config cloudflare/wrangler.apps.jsonc --outdir .local/stream-c-apps-build`: local bundling/config validation passed without an upload.

CPU resource caps are configured; these local tests do not certify production CPU enforcement, wildcard TLS/routing, deployed authorization wiring or user acceptance. The rollback test intentionally logs a workerd constructor SQLite error for its invalid migration and still verifies recovery.

Official APIs verified on 2026-10-12: [WorkerLoader API](https://developers.cloudflare.com/dynamic-workers/api-reference/), [SQLite facets and abort/get](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/), [egress control](https://developers.cloudflare.com/dynamic-workers/usage/egress-control/), [custom resource limits](https://developers.cloudflare.com/dynamic-workers/usage/limits/). Installed types `5.20261008.1` and Wrangler `4.147.0` expose the same APIs; no dependency upgrades were needed.
