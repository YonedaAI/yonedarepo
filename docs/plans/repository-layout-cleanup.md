# REPO-001: repository layout cleanup

Status: queued. Requested October 8, 2026. Finish the current repository deletion and per-run agent changes before starting this structural move.

The root mixes browser code, Rust crates, Cloudflare adapters and deployment configuration. Group these by responsibility while preserving the shared Rust application layer and the commands used for local development and deployment.

Proposed layout to validate during implementation:

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
