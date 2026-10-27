//! The YonedaRepo client: the `yoneda` command line and the `git-remote-yoneda` helper.
//! Locally it is plain Git; the platform's value (server-side merges on landing, one
//! transaction per push, server-side reads) is reached through the public HTTP API.
pub mod account;
pub mod api;
pub mod args;
mod attempt;
mod brief;
mod changes;
mod checkout;
mod chunk;
mod clone;
pub mod command;
mod conflict;
pub mod credentials;
pub mod error;
mod git;
pub mod import;
pub mod login;
mod plan;
mod pull;
mod reads;
mod reconcile;
pub mod remote;
mod replay;
mod repo_ops;
mod run;
pub mod session_files;
pub mod setup;
mod snapshot;
mod state;
mod status;
mod sync;
mod target;
#[cfg(test)]
mod testkit;

pub use run::main;
