//! Write scope of a three-way conflict resolver.
//!
//! Owner decision: wiring two same-base changes together often needs edits to
//! files outside the Git-overlapping paths (for example a file only one side
//! changed), so a resolver may edit any valid repository path except protected
//! verification paths. `conflict_paths` keeps meaning "actually conflicting";
//! the resolver's actual edits are recorded separately for display. The
//! capture must still be based on the reserved head and the exact captured
//! revision still receives fresh independent checks.
use crate::{Error, Result};
use serde_json::Value;

/// Guided-project verification paths that are protected for every resolver,
/// in addition to the repository policy's `test_bundle.protected_paths`.
pub const ALWAYS_PROTECTED: [&str; 3] = [
    "README.md",
    ".yoneda-guided",
    "fixtures/guided-task-board/oracle",
];

/// Whether `path` is, or lies beneath, a protected path (`ALWAYS_PROTECTED` or `extra`).
pub fn is_protected(path: &str, extra: &[&str]) -> bool {
    ALWAYS_PROTECTED.iter().chain(extra).any(|protected| {
        let protected = protected.trim_end_matches('/');
        !protected.is_empty()
            && (path == protected
                || path
                    .strip_prefix(protected)
                    .is_some_and(|rest| rest.starts_with('/')))
    })
}

/// Policy protected paths frozen into a resolver capture payload as
/// `resolver_protected_paths`; absent for payloads created before it existed.
pub fn frozen_protected(payload: &Value) -> Result<Vec<&str>> {
    match payload.get("resolver_protected_paths") {
        Some(Value::Null) | None => Ok(vec![]),
        Some(Value::Array(paths)) => paths
            .iter()
            .map(|path| {
                path.as_str()
                    .ok_or_else(|| invalid("Invalid protected path"))
            })
            .collect(),
        Some(_) => Err(invalid("Invalid protected path list")),
    }
}

/// Validate resolver edits: each path must be a safe relative path that is not protected.
pub fn validate_edits<'a>(paths: impl IntoIterator<Item = &'a str>, extra: &[&str]) -> Result<()> {
    for path in paths {
        crate::validate_path(path)?;
        if is_protected(path, extra) {
            return Err(invalid("Resolver capture edits a protected path"));
        }
    }
    Ok(())
}

fn invalid(message: &str) -> Error {
    Error::new("INVALID_CONFLICT_RESULT", message)
}
