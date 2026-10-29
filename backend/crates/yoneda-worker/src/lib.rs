//! workers-rs glue between the TypeScript adapter (`cloudflare/worker`) and the Rust
//! platform. No product policy lives here: each entry point decodes JSON, calls one
//! `yoneda_platform` operation and encodes its `Result` as `{"error":{"code","message"}}` on
//! failure.
//!
//! | Rust entry point | Called from | State |
//! |---|---|---|
//! | [`SourceRepository`], [`CommitShard`], [`WorkspaceAuthority`] (Durable Object `fetch`) | `repo-ops.ts` via `durable.ts`; `repo-commit-shard.ts`; `workspace.ts` | DO SQLite through `yoneda_cloudflare::CloudStore` |
//! | `platformCompute` (`compute.rs`) | `repo-compute.ts` | none: runs in the calling isolate |
//! | Git push/fetch sessions (`git_http.rs`) | `repo-git-sessions.ts` | per-isolate Wasm memory, evicted by age |
//!
//! The adapter authenticates and passes the principal; the Durable Objects stamp time. The
//! adapter owns all network I/O (object tiers, Artifacts, queues) and feeds bytes in.
use worker::*;
mod workspace;
pub use workspace::WorkspaceAuthority;
mod commit_shard;
mod compute;
mod git_http;
mod source_repository;
mod stack;
pub use commit_shard::CommitShard;
pub use source_repository::SourceRepository;

#[event(fetch)]
pub async fn fetch(_req: Request, _env: Env, _ctx: Context) -> Result<Response> {
    Response::error("Use the authenticated SDK entrypoint", 404)
}
