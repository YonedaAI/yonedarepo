use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result, Workspace};

pub(super) fn register<S: SqlStore>(db: &S, c: Value, now: i64) -> Result<Value> {
    let mut job = active(db, &c, now)?;
    if job["kind"] != "evaluate"
        || job["payload"]["policy"]["build"]["static_dir"]
            .as_str()
            .is_none()
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Only static evaluators register site assets",
        ));
    }
    let files: Workspace =
        serde_json::from_value(c["files"].clone()).map_err(|e| bad(&e.to_string()))?;
    yoneda_core::validate_workspace(&files)?;
    if !files.contains_key("index.html") {
        return Err(bad("Static output must contain index.html"));
    }
    let digest = hash(&c, "digest", &[64])?;
    let site = json!({"digest":digest,"commit":job["payload"]["candidate"]["revision"]["commit"],"candidate":job["payload"]["candidate"]["id"]});
    if !job["site"].is_null() && job["site"] != site {
        return Err(Error::new(
            "IDEMPOTENCY_CONFLICT",
            "Evaluator already registered different assets",
        ));
    }
    if job["site"] == site {
        return Ok(site);
    }
    job["site"] = site.clone();
    save(db, "jobs", &string(&job, "id")?, &job)?;
    event(db, "site.captured", now, site.clone())?;
    Ok(site)
}
