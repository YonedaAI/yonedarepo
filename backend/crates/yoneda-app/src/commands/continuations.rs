use crate::storage::{SqlStore, bad, get, string};
use serde_json::Value;
use yoneda_core::{Error, Result};

pub(super) fn validate<S: SqlStore>(
    db: &S,
    command: &Value,
    repository: &Value,
) -> Result<Option<String>> {
    if command.get("continuation_of").is_none() {
        return Ok(None);
    }
    if command.get("restart_of").is_some() {
        return Err(bad(
            "Choose either a published continuation or a run restart",
        ));
    }
    let id = string(command, "continuation_of")?;
    let decision = get(db, "decisions", &id)?;
    if decision["status"] != "published" {
        return Err(Error::new(
            "INVALID_STATE",
            "An update must continue a verified published decision",
        ));
    }
    if decision["target"]["commit"] != repository["published_commit"] {
        return Err(Error::new(
            "HEAD_MOVED",
            "The published revision changed; refresh before starting this update",
        ));
    }
    Ok(Some(id))
}
