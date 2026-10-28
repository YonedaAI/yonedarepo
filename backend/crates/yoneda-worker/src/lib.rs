use worker::*;
mod workspace;
pub use workspace::WorkspaceAuthority;
mod commit_shard;
mod compute;
mod git_http;
mod source_repository;
pub use commit_shard::CommitShard;
pub use source_repository::SourceRepository;

#[event(fetch)]
pub async fn fetch(_req: Request, _env: Env, _ctx: Context) -> Result<Response> {
    Response::error("Use the authenticated SDK entrypoint", 404)
}
