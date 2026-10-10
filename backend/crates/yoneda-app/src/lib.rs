//! Transactional application commands shared by native SQLite and Cloudflare DOs.
use serde_json::Value;
use yoneda_core::Result;
mod commands;
mod storage;
mod workspace;
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
