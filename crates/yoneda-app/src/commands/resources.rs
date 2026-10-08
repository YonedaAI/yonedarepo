use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

pub(super) fn reserve<S: SqlStore>(db: &S, c: Value) -> Result<Value> {
    let now = number(&c, "now")?;
    let mut job = active(db, &c, now)?;
    let kind = string(&c, "kind")?;
    if (kind == "model" && job["kind"] != "agent")
        || (kind == "dependency" && job["kind"] != "agent" && job["kind"] != "evaluate")
    {
        return Err(Error::new("FORBIDDEN", "Attempt lacks this capability"));
    }
    if kind == "model" {
        return super::model_reservations::reserve(db, &c, job, now);
    }
    let limit = match kind.as_str() {
        "dependency" => 512,
        _ => return Err(bad("Unknown request kind")),
    };
    let field = format!("{kind}_requests");
    let number = job[&field]
        .as_i64()
        .unwrap_or_default()
        .checked_add(1)
        .ok_or_else(|| bad("Request overflow"))?;
    if number > limit {
        return Err(Error::new(
            "RESOURCE_LIMIT",
            format!("{kind} request limit reached"),
        ));
    }
    if kind == "dependency" {
        let bytes = crate::storage::number(&c, "bytes")?;
        if !(0..=16 * 1024 * 1024).contains(&bytes) {
            return Err(Error::new(
                "RESOURCE_LIMIT",
                "Dependency object exceeds 16 MiB",
            ));
        }
        let total = job["dependency_bytes"]
            .as_i64()
            .unwrap_or_default()
            .checked_add(bytes)
            .ok_or_else(|| bad("Dependency budget overflow"))?;
        if total > 128 * 1024 * 1024 {
            return Err(Error::new(
                "RESOURCE_LIMIT",
                "Dependency downloads exceed 128 MiB",
            ));
        }
        job["dependency_bytes"] = json!(total);
    }
    job[&field] = json!(number);
    save(db, "jobs", &string(&job, "id")?, &job)?;
    Ok(json!({"number":number}))
}
