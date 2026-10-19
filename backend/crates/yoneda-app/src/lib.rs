//! Transactional application commands shared by native SQLite and Cloudflare DOs.
use serde_json::Value;
use yoneda_core::Result;
mod commands;
mod path_lists;
mod platform_code;
mod platform_compute;
mod platform_derived;
mod platform_objects;
mod platform_review;
mod platform_symbols;
pub(crate) mod repo_store;
mod source_binding;
mod source_workspace;
mod storage;
mod workspace;
pub use platform_compute::compute as platform_compute;
pub use repo_store::{execute_repo_store, migrate_repo_store};
pub use source_workspace::{execute_source_workspace, migrate_source_workspace};
pub use storage::{SqlStore, migrate};
pub use workspace::execute_workspace;
/// All ledger commands execute synchronously within the host's storage transaction.
/// The closure contains no network calls, clocks, or asynchronous work.
pub fn execute<S: SqlStore>(store: &S, command: Value) -> Result<Value> {
    migrate(store)?;
    let owned = store.clone();
    store.transaction(Box::new(move || commands::dispatch(&owned, command)))
}

#[cfg(any(test, feature = "native"))]
pub mod native;

#[cfg(test)]
mod tests;
#[cfg(test)]
#[path = "tests/workspace.rs"]
mod workspace_tests;

#[cfg(test)]
#[path = "tests/project_setup.rs"]
mod project_setup_tests;

#[cfg(test)]
#[path = "tests/reviewer.rs"]
mod reviewer_tests;
