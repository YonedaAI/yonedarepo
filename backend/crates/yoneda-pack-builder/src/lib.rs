//! The PackBuilder container's server (cloudflare/worker/pack-builder.ts starts it): one
//! repository's clone packs, built with stock Git and streamed to the Worker, which stores
//! them. It holds no credentials and has no internet; see `server` for its routes.
pub mod git;
pub mod http;
pub mod server;
