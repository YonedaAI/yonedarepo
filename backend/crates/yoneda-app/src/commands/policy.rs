use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result};
pub(super) fn update<S: SqlStore>(db: &S, c: Value, now: i64) -> Result<Value> {
    let mut repository = repo(db)?;
    if !repository["pending"].is_null() {
        return Err(Error::new(
            "PUBLICATION_PENDING",
            "Policy changes wait for publication",
        ));
    }
    if repository["head_commit"] != c["expected_commit"]
        || repository["version"] != c["expected_version"]
        || repository["policy"]["version"] != c["expected_policy"]
    {
        return Err(Error::new("HEAD_MOVED", "Repository or policy changed"));
    }
    let typed: yoneda_core::Policy =
        serde_json::from_value(c["policy"].clone()).map_err(|e| bad(&e.to_string()))?;
    yoneda_core::build::validate_policy(&typed)?;
    let policy = serde_json::to_value(typed).map_err(|e| bad(&e.to_string()))?;
    if repository["policy"] == policy {
        return Ok(repository);
    }
    if repository["policy"]["version"] == policy["version"] {
        return Err(bad("Changed policy requires a new version"));
    }
    repository["policy"] = policy.clone();
    save(db, "repository", "repo", &repository)?;
    for mut candidate in all(db, "candidates")? {
        if candidate["base"]["commit"] != repository["published_commit"]
            || ["cancelled", "stale"].contains(&candidate["status"].as_str().unwrap_or_default())
        {
            continue;
        }
        let run = get(db, "runs", &string(&candidate, "run_id")?)?;
        if run["status"] == "cancelled" || run["status"] == "accepted" {
            continue;
        }
        let cid = string(&candidate, "id")?;
        candidate["status"] = json!("evaluating");
        save(db, "candidates", &cid, &candidate)?;
        job(
            db,
            &format!("evaluate:{cid}:{}", string(&policy, "version")?),
            "evaluate",
            now,
            json!({"candidate":candidate,"run_id":run["id"],"policy":policy}),
        )?;
    }
    event(db, "policy.updated", now, json!({"policy":policy}))?;
    Ok(repository)
}
