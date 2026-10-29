//! YonedaRepo source platform: the SourceRepository authority (refs, hash-chained log,
//! checks, reviews, landing, grants) and the stateless Rust compute the Worker runs next
//! to the object cache (diffs, merges, search, blame, symbols, review classes, contracts
//! and the agent and human views), plus the account authority (sessions, personal access
//! tokens, device login).
//!
//! # Seams
//!
//! - **Core below.** Only pure `yoneda_core` contracts are used (`git_object`, `transport`,
//!   `txlog`, `merge`, `textdiff`, `search`, `blame`, `account` and the error and digest
//!   primitives; `tests/runtime/platform-boundary.test.mjs` enforces the list). The platform
//!   relies on their invariants: object ids are the SHA-1 of the
//!   exact Git encoding, so an id names its bytes; txlog entries are hash-chained
//!   (`txlog::chain_digest`), so a version names its whole history; receive-pack bodies
//!   carry an expected-old id per ref, so the object store refuses a stale ref update.
//! - **Store beside.** Durable state enters only through [`yoneda_store::SqlStore`]: each
//!   repository command runs in one store transaction (`execute_migrated`), so refs, txlog
//!   entries and events commit together.
//! - **Adapter above.** Every other input arrives as a JSON command from the Worker
//!   (`yoneda-worker`): principal, workspace and time are set by the authenticating adapter,
//!   and object bytes the adapter fetched from the object tiers arrive as arguments. The
//!   platform performs no network I/O; it answers with what to write (pack bodies, pushes)
//!   and the adapter writes it and reports back (readback before recording, expected-old on
//!   pushed ref moves). It never runs `git`; Git objects are built and parsed by
//!   `yoneda_core`.
mod accounts;
mod commit_store;
mod ops;
mod platform_access;
mod platform_build;
mod platform_code;
mod platform_compute;
mod platform_contracts;
mod platform_derived;
mod platform_facts;
mod platform_facts_rust;
mod platform_facts_script;
mod platform_git_http;
pub mod platform_git_receive;
pub mod platform_git_upload;
pub mod platform_git_v2;
mod platform_git_verify;
mod platform_graph;
mod platform_head;
mod platform_instructions;
pub(crate) mod platform_model_check;
mod platform_model_verdict;
mod platform_narrative;
mod platform_objects;
mod platform_project;
mod platform_push;
pub mod platform_push_reads;
mod platform_review;
mod platform_symbol_graph;
mod platform_symbols;
mod platform_views;
pub(crate) mod repo_store;
mod secret_scan;
pub mod shared_contracts;

pub use accounts::execute_workspace;
pub use commit_store::{execute_commit_store, migrate_commit_store};
pub use platform_compute::compute as platform_compute;
pub use repo_store::{execute_migrated, execute_repo_store, migrate_repo_store};

/// The store contract under the name the modules were written against.
pub(crate) mod storage {
    pub use yoneda_store::{SqlStore, bad, number, string};
}

#[cfg(test)]
pub(crate) mod native {
    pub use yoneda_store::{counted::Counted, native::NativeStore};
}
