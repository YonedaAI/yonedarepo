//! The YonedaRepo client: the `yoneda` command line and the `git-remote-yoneda` helper.
//! Locally it is plain Git; the platform's value (server-side merges on landing, one
//! transaction per push, server-side reads) is reached through the public HTTP API.
//!
//! Only this client runs `git`: it shells out to the local executable for worktree
//! plumbing (`git`, `session_cmd`). The server never does; it reads and writes Git objects
//! with `yoneda_core`.
pub mod account;
mod agent_hook;
mod agent_transcript;
pub mod api;
pub mod args;
mod auth_token;
mod brief;
mod change_cmd;
mod change_route;
mod changes;
mod checkout;
mod chunk;
mod clone;
pub mod command;
mod completion;
mod conflict;
mod context_cmd;
mod context_inject;
mod context_render;
pub mod credentials;
mod declared_reads;
mod efficiency;
pub mod error;
mod flight_plan;
mod git;
mod go_around;
mod http;
pub mod import;
pub mod login;
mod memory_cmd;
mod opencode_hook;
mod org_cmd;
pub mod output;
mod plan;
mod pull;
mod reads;
mod reconcile;
mod release_cmd;
pub mod remote;
mod replay;
mod repo_ops;
mod repo_remote;
mod run;
mod search_all;
pub mod session_cmd;
pub mod session_files;
pub mod setup;
mod snapshot;
mod sparse;
mod ssh_key_cmd;
mod ssh_setup;
mod state;
mod status;
mod sync;
mod target;
#[cfg(test)]
mod testkit;
mod traffic;

pub use run::main;
