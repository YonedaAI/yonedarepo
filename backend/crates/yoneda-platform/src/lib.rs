//! YonedaRepo source platform: the SourceRepository authority (refs, hash-chained log,
//! checks, reviews, landing, grants) and the stateless Rust compute the Worker runs next
//! to the object cache (diffs, merges, search, blame, symbols, review classes, contracts
//! and the agent and human views).
mod commit_store;
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
mod platform_git_verify;
mod platform_graph;
mod platform_head;
mod platform_instructions;
mod platform_narrative;
mod platform_objects;
mod platform_project;
mod platform_push;
mod platform_review;
mod platform_symbol_graph;
mod platform_symbols;
mod platform_views;
pub(crate) mod repo_store;
mod secret_scan;

pub use commit_store::{execute_commit_store, migrate_commit_store};
pub use platform_compute::compute as platform_compute;
pub use repo_store::{execute_migrated, execute_repo_store, migrate_repo_store};

/// The store contract under the name the modules were written against.
pub(crate) mod storage {
    pub use yoneda_store::{SqlStore, bad, number, string};
}

#[cfg(test)]
pub(crate) mod native {
    pub use yoneda_store::native::NativeStore;
}
