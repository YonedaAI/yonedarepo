//! Owner-only bounded verification recovery of an already registered immutable source seal.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_agents_core::{
    Error, Result,
    source_workspace::{SourceAccess, SourceBinding, SourceRole},
};
mod guards;
pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let repository = repo(db)?;
    if ["job_id", "_grant", "_reviewer"]
        .iter()
        .any(|f| c.get(*f).is_some())
        || c["_workspace"].as_str() != Some(repository["workspace"].as_str().unwrap_or("_admin"))
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Only the repository owner can retry source capture",
        ));
    }
    let request = string(c, "request_id")?;
    yoneda_agents_core::source_workspace::validate_id(&request)?;
    let mut old = get(db, "jobs", &string(c, "capture_job_id")?)?;
    let input = json!({"request_id":request,"capture_job_id":old["id"],"expected_producer_epoch":number(c,"expected_producer_epoch")?,"expected_registration_id":string(c,"expected_registration_id")?,"expected_commit":hash(c,"expected_commit",&[40,64])?,"expected_version":number(c,"expected_version")?,"expected_policy_digest":hash(c,"expected_policy_digest",&[64])?});
    let fingerprint = yoneda_agents_core::fingerprint(&input)?;
    if !old["source_capture_retry"].is_null() {
        let previous = &old["source_capture_retry"];
        if previous["request_id"] != request {
            return Err(Error::new(
                "RESOURCE_LIMIT",
                "Registered seal recovery is already used",
            ));
        }
        if previous["fingerprint"] != fingerprint {
            return Err(Error::new(
                "IDEMPOTENCY_CONFLICT",
                "Capture recovery request changed",
            ));
        }
        return Ok(previous["receipt"].clone());
    }
    if old["kind"] != "capture"
        || old["status"] != "failed"
        || old["attempt"] != 2
        || old["payload"]["capture_subtype"] != "source_changeset"
        || old["payload"]["workspace_transport"] != "api-source-v1"
        || !old["payload"]["verification_recovery"].is_null()
    {
        return Err(Error::new(
            "INVALID_STATE",
            "Recovery requires the original exhausted API source capture",
        ));
    }
    let pointer = &old["payload"]["source_registered"];
    let producer = get(db, "jobs", &string(pointer, "producer_job_id")?)?;
    let registration = &producer["source_registered"]["registration"];
    let b: SourceBinding = serde_json::from_value(registration["binding"].clone())
        .map_err(|_| Error::new("SOURCE_CHANGED", "Registered source binding is missing"))?;
    b.validate()?;
    let mut execution = get(db, "executions", &b.execution_id)?;
    let mut run = get(db, "runs", &b.run_id)?;
    guards::validate_source(&old, &producer, registration, &b, &execution, c)?;
    guards::validate_run(db, &repository, &run, &execution, &b, c)?;
    let id = format!(
        "capture:source-retry:{}",
        yoneda_agents_core::fingerprint(
            &json!({"repo":repository["id"],"producer":b.job_id,"epoch":b.epoch,"registration":registration["registration_id"]})
        )?
    );
    match get(db, "jobs", &id) {
        Ok(_) => {
            return Err(Error::new(
                "RESOURCE_LIMIT",
                "Registered seal recovery is already used",
            ));
        }
        Err(e) if e.code == "NOT_FOUND" => {}
        Err(e) => return Err(e),
    }
    let recovery = json!({"version":1,"kind":"same_registered_source_seal","authority":"owner_verification_recovery","automatic_review":false,"request_id":request,"original_capture_job_id":old["id"],"producer_job_id":b.job_id,"producer_epoch":b.epoch,"registration_id":registration["registration_id"]});
    let audit_id = format!(
        "verification-recovery:{}",
        yoneda_agents_core::fingerprint(&recovery)?
    );
    let mut audit = recovery.clone();
    audit["stale_review_id"] = run["comparison"]["latest_review_id"].clone();
    audit["stale_review_execution_id"] = run["comparison"]["review_execution_id"].clone();
    audit["stale_manifest_digest"] = run["comparison"]["manifest_digest"].clone();
    if let Some(review_id) = run["comparison"]["latest_review_id"].as_str() {
        let review = get(db, "nodes", review_id)?;
        if review["kind"] != "proposed_decision"
            || review["author"] != "agent_assertion"
            || review["data"] != run["comparison"]["latest_review"]
            || review["data"]["run_id"] != run["id"]
        {
            return Err(Error::new("FENCED", "Historical review assertion changed"));
        }
        edge(
            db,
            &audit_id,
            review_id,
            "marks_stale",
            "Owner requested new capture and checks; original review retained",
        )?;
    } else if !run["comparison"]["latest_review"].is_null() {
        return Err(Error::new(
            "FENCED",
            "Historical review reference is missing",
        ));
    }
    node(
        db,
        &audit_id,
        "verification_recovery",
        "Recapture registered source without rerunning builders",
        "owner",
        now,
        audit,
    )?;
    let mut payload = old["payload"].clone();
    payload["execution"]["epoch"] = json!(b.epoch);
    payload["verification_recovery"] = recovery.clone();
    job(db, &id, "capture", now, payload)?;
    let receipt = json!({"version":1,"run_id":b.run_id,"job_id":id,"capture_job_id":id,"registration_id":registration["registration_id"],"producer_epoch":b.epoch,"status":"queued","authority":"owner_verification_recovery","checked":false,"published":false});
    old["source_capture_retry"] =
        json!({"request_id":request,"fingerprint":fingerprint,"receipt":receipt});
    save(db, "jobs", &string(&old, "id")?, &old)?;
    execution["status"] = json!("capturing");
    execution["verification_recovery"] = recovery.clone();
    save_execution(db, &execution, now)?;
    run["status"] = json!("exploring");
    run["comparison"]["status"] = json!("building");
    run["comparison"]["verification_recovery"] = recovery;
    for field in [
        "review_execution_id",
        "manifest_digest",
        "latest_review_id",
        "latest_review",
        "reviewer_status",
        "review_skip_reason",
    ] {
        run["comparison"][field] = Value::Null;
    }
    save(db, "runs", &b.run_id, &run)?;
    edge(
        db,
        &audit_id,
        &id,
        "requested_verification",
        "Same registered seal; fresh capture and independent checks required",
    )?;
    event(db, "source.capture_retry_requested", now, receipt.clone())?;
    Ok(receipt)
}
#[cfg(test)]
#[path = "source_capture_retry_tests.rs"]
mod tests;
