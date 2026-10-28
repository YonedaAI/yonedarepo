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
mod attempt;
mod brief;
mod change_cmd;
mod changes;
mod checkout;
mod chunk;
mod clone;
pub mod command;
mod conflict;
mod context_cmd;
pub mod credentials;
pub mod error;
mod git;
pub mod import;
pub mod login;
mod opencode_hook;
mod org_cmd;
mod plan;
mod pull;
mod reads;
mod reconcile;
mod release_cmd;
pub mod remote;
mod replay;
mod repo_ops;
mod run;
pub mod session_cmd;
pub mod session_files;
pub mod setup;
mod snapshot;
mod ssh_key_cmd;
mod state;
mod status;
mod sync;
mod target;
#[cfg(test)]
mod testkit;

pub use run::main;
