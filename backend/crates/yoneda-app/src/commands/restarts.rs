use crate::storage::*;
use serde_json::Value;
use yoneda_core::{Error, Result};

pub(super) fn validate<S: SqlStore>(db: &S, c: &Value) -> Result<Option<String>> {
    if c.get("restart_of").is_none() {
        return Ok(None);
    }
    let previous = string(c, "restart_of")?;
    get(db, "runs", &previous)?;
    if run_jobs(db, &previous)?
        .iter()
        .any(|job| job["status"] == "queued" || job["status"] == "running")
    {
        return Err(Error::new(
            "RUN_ACTIVE",
            "Finish or cancel the previous run before restarting it",
        ));
    }
    Ok(Some(previous))
}
