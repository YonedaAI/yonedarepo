//! Identity of the guided task-board profile shared by the ledger and the evaluator.
use serde_json::Value;

/// The oracle family. Every version runs the same immutable phase checks.
pub const PROFILE_ID: &str = "task-board-v1";

/// Starter and brief versions. A project, its session and its run bindings stay pinned
/// to the version recorded when the project was created.
pub const VERSIONS: [u64; 2] = [1, 2];

/// Whether `value` names a supported profile version.
pub fn supported_version(value: &Value) -> bool {
    value
        .as_u64()
        .is_some_and(|version| VERSIONS.contains(&version))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_published_versions_are_supported() {
        assert!(supported_version(&json!(1)));
        assert!(supported_version(&json!(2)));
        for value in [json!(0), json!(3), json!("2"), json!(2.5), json!(null)] {
            assert!(!supported_version(&value), "{value}");
        }
    }
}
