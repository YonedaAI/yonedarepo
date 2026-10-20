//! Trusted capture must match current registered source lineage, never model claims.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_agents_core::{Error, Result};
pub(super) fn validate<S: SqlStore>(
    db: &S,
    j: &Value,
    result: &Value,
    now: i64,
) -> Result<Option<Value>> {
    if j["payload"]["capture_subtype"] != "source_changeset" {
        return Ok(None);
    }
    let context = crate::source_binding::capture_record(
        db,
        &json!({"job_id":j["id"],"epoch":j["epoch"]}),
        now,
    )?;
    let b = &context["binding"];
    let seal = &context["seal"];
    let pointer = &j["payload"]["source_registered"];
    let expected = json!({"version":1,"authority":"registered_source_changeset","workspace_id":b["workspace_id"],"registration_id":pointer["registration_id"],"producer_job_id":pointer["producer_job_id"],"producer_epoch":pointer["producer_epoch"],"seal_id":seal["seal_id"],"checkpoint_id":seal["checkpoint_id"],"changeset_digest":seal["changeset_digest"],"view_digest":b["view_digest"],"baseline_overrides_digest":b["baseline_overrides_digest"]});
    if result["source_verified"] != true
        || result["source_lineage"] != expected
        || result["source_changeset_digest"] != seal["changeset_digest"]
        || result["source_manifest_digest"] != seal["changeset_digest"]
        || result["parents"] != b["parents"]
        || j["payload"]["execution"]["id"] != b["execution_id"]
        || j["payload"]["execution"]["run_id"] != b["run_id"]
    {
        return Err(Error::new(
            "INVALID_CAPTURE",
            "Capture lineage or ordered parents differs from the registered seal",
        ));
    }
    Ok(Some(expected))
}
