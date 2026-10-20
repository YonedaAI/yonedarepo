//! Preserve only the adapter-verified fresh guided starter and immutable oracle identity.
use crate::storage::*;
use serde_json::Value;
use yoneda_agents_core::Result;

pub(super) fn initialize(command: &Value, repository: &mut Value) -> Result<()> {
    let Some(marker) = command.get("_guided_project") else {
        return Ok(());
    };
    let object = marker
        .as_object()
        .ok_or_else(|| bad("Invalid guided project marker"))?;
    if object.keys().any(|key| {
        ![
            "profile_id",
            "version",
            "starter",
            "policy_digest",
            "test_bundle_digest",
        ]
        .contains(&key.as_str())
    }) || marker["profile_id"] != yoneda_agents_core::guided::PROFILE_ID
        || !yoneda_agents_core::guided::supported_version(&marker["version"])
        || repository["policy"]["version"] != yoneda_agents_core::guided::PROFILE_ID
        || marker["policy_digest"] != yoneda_agents_core::fingerprint(&repository["policy"])?
        || marker["test_bundle_digest"] != repository["policy"]["build"]["test_bundle"]["digest"]
        // The adapter seeded the platform repository from the starter and read back its
        // root tree; the commit differs (a new platform commit), the tree must not.
        || marker["starter"]["tree"] != command["tree"]
    {
        return Err(bad(
            "Guided source or checks differ from the verified starter",
        ));
    }
    hash(marker, "policy_digest", &[64])?;
    hash(marker, "test_bundle_digest", &[64])?;
    hash(&marker["starter"], "commit", &[40])?;
    hash(&marker["starter"], "tree", &[40])?;
    let source = string(&marker["starter"], "repository")?;
    let Some((_, name)) = source.split_once('/') else {
        return Err(bad("Invalid guided starter repository"));
    };
    if name.is_empty()
        || name.len() > 100
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
    {
        return Err(bad("Invalid guided starter repository"));
    }
    repository["guided_project"] = marker.clone();
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::{execute, native::NativeStore, storage::*};
    use serde_json::{Value, json};

    fn command() -> Value {
        let policy = json!({"version":"task-board-v1","suite":"commands-v1",
            "environment":"linux-node24-rust1.94-v1","required_checks":["guided-task-board"],
            "build":{"setup":[],"static_dir":"public","checks":[{"name":"guided-task-board",
                "argv":["node","/opt/yoneda/test-bundle/fixtures/guided-task-board/oracle/run.mjs"],
                "timeout_seconds":30}],"test_bundle":{"digest":"d".repeat(64),"protected_paths":["README.md"]}}});
        json!({"op":"init","id":"fresh-guide","name":"Fresh guide","workspace":"owner",
            "commit":"c".repeat(40),"tree":"b".repeat(40),"remote":{"namespace":"platform","name":"fresh-guide","branch":"main"},
            "policy":policy,"_guided_project":{"profile_id":"task-board-v1","version":1,
                "policy_digest":yoneda_agents_core::fingerprint(&policy).unwrap(),"test_bundle_digest":"d".repeat(64),
                "starter":{"repository":"test/guided-starter","branch":"main","commit":"a".repeat(40),"tree":"b".repeat(40)}}})
    }

    #[test]
    fn preserves_only_the_exact_verified_starter_and_policy_marker() {
        let db = NativeStore::memory().unwrap();
        let command = command();
        let result = execute(&db, command.clone()).unwrap();
        assert_eq!(result["guided_project"], command["_guided_project"]);
        assert_eq!(
            repo(&db).unwrap()["guided_project"],
            command["_guided_project"]
        );
    }

    #[test]
    fn records_the_version_two_starter_marker() {
        let db = NativeStore::memory().unwrap();
        let mut command = command();
        command["_guided_project"]["version"] = json!(2);
        execute(&db, command).unwrap();
        assert_eq!(repo(&db).unwrap()["guided_project"]["version"], 2);
    }

    #[test]
    fn altered_source_and_checks_leave_no_repository_or_project_authority() {
        for (path, value) in [
            ("/policy_digest", json!("e".repeat(64))),
            ("/test_bundle_digest", json!("e".repeat(64))),
            ("/starter/tree", json!("c".repeat(40))),
            ("/starter/repository", json!("no-namespace")),
            ("/version", json!(3)),
            ("/version", json!("2")),
        ] {
            let db = NativeStore::memory().unwrap();
            let mut command = command();
            *command["_guided_project"].pointer_mut(path).unwrap() = value;
            assert_eq!(execute(&db, command).unwrap_err().code, "INVALID_INPUT");
            assert_eq!(
                get(&db, "repository", "repo").unwrap_err().code,
                "NOT_FOUND"
            );
        }
    }
}
