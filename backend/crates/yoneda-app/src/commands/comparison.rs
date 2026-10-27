//! The owner's explicit selection among compare results, separate from publication.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_agents_core::{Error, Result};
mod manifest;
mod provenance;
mod refresh;
mod selection;
fn view(run: &Value) -> Value {
    let mut comparison = run["comparison"].clone();
    if let Some(m) = comparison.as_object_mut() {
        m.remove("approval_receipt");
        m.remove("selection_receipts");
    }
    comparison
}
pub(super) use provenance::decision as decision_provenance;
pub(super) use selection::validate_publish;

pub(super) use selection::owner_select;

fn manual_roster(run: &Value) -> bool {
    run["mode"] == "compare"
        && run["agents"]
            .as_array()
            .is_some_and(|a| (1..=6).contains(&a.len()))
}
fn owner(c: &Value) -> Result<()> {
    if ["job_id", "_grant", "_reviewer"]
        .iter()
        .any(|f| c.get(*f).is_some())
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Only an owner may approve or select a comparison",
        ));
    }
    Ok(())
}
fn fingerprint(c: &Value) -> Result<String> {
    let mut input = c.clone();
    if let Some(m) = input.as_object_mut() {
        m.remove("now");
    }
    yoneda_agents_core::fingerprint(&input)
}
fn pending<S: SqlStore>(db: &S, rid: &str, except: Option<&str>) -> Result<bool> {
    Ok(run_jobs(db, rid)?.iter().any(|j| {
        Some(j["id"].as_str().unwrap_or("")) != except
            && ["queued", "running", "awaiting_intent"]
                .iter()
                .any(|s| j["status"] == *s)
    }))
}
fn persist<S: SqlStore>(db: &S, run: &Value, now: i64) -> Result<()> {
    let id = string(run, "id")?;
    save(db, "runs", &id, run)?;
    node(
        db,
        &id,
        "run",
        run["intent"].as_str().unwrap_or("Compare"),
        "platform",
        now,
        run.clone(),
    )
}
#[cfg(test)]
mod tests;
