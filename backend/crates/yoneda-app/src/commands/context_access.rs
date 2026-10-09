//! Receipts are immutable delivery evidence; only trusted adapters call this operation.
use crate::storage::*;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use yoneda_core::{
    Error, Result,
    context_usage::{AccessStage, AccessTarget, MAX_ACCESS_TARGETS},
};

pub(super) fn activation<S: SqlStore>(db: &S, now: i64) -> Result<i64> {
    db.query(
        "INSERT OR IGNORE INTO context_access_metadata(id,activated_at) VALUES(1,?)",
        &[json!(now)],
    )?;
    let rows = db.query(
        "SELECT activated_at FROM context_access_metadata WHERE id=1",
        &[],
    )?;
    number(&rows[0], "activated_at")
}

pub(super) fn record<S: SqlStore>(db: &S, c: Value, now: i64) -> Result<Value> {
    repo(db)?;
    let identity = super::context_sessions::identity(db, &c, now)?;
    if identity["execution_id"].is_null() && identity["grant_id"].is_null() {
        return Err(Error::new(
            "FORBIDDEN",
            "Access receipts require an authenticated MCP identity",
        ));
    }
    let call_id = string(&c, "call_id")?;
    if call_id.len() > 80
        || !call_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(bad("Invalid context call identifier"));
    }
    let tool = string(&c, "tool")?;
    if ![
        "repo_context",
        "context",
        "context_search",
        "context_get",
        "artifact_get",
        "graph",
        "why",
        "decision",
        "team_context",
        "integration_request",
    ]
    .contains(&tool.as_str())
    {
        return Err(bad("This tool does not produce context access receipts"));
    }
    let stage: AccessStage =
        serde_json::from_value(c["stage"].clone()).map_err(|_| bad("Invalid access stage"))?;
    if stage == AccessStage::Assigned
        || (tool == "context_search") != (stage == AccessStage::Returned)
    {
        return Err(bad("Search responses are returned; other reads are opened"));
    }
    let targets: Vec<AccessTarget> =
        serde_json::from_value(c["targets"].clone()).map_err(|_| bad("Invalid access targets"))?;
    if targets.len() > MAX_ACCESS_TARGETS {
        return Err(bad("Too many access targets"));
    }
    let mut canonical = BTreeMap::new();
    for target in targets {
        target.validate()?;
        let record = get(db, "nodes", &target.id)?;
        if let Some(digest) = &target.digest {
            let expected = record["data"]["digest"]
                .as_str()
                .or_else(|| record["data"]["evidence"].as_str());
            if expected != Some(digest.as_str()) {
                return Err(Error::new(
                    "DIGEST_MISMATCH",
                    "Access receipt digest does not match immutable evidence",
                ));
            }
        }
        if let Some(previous) = canonical.insert(target.id.clone(), target.clone())
            && previous != target
        {
            return Err(bad("Conflicting access targets"));
        }
    }
    let targets: Vec<_> = canonical.into_values().collect();
    let mut data = identity;
    data["call_id"] = json!(call_id);
    data["tool"] = json!(tool);
    data["stage"] = json!(stage);
    data["targets"] = json!(targets);
    if c.get("response_digest").is_some() {
        data["response_digest"] = json!(hash(&c, "response_digest", &[64])?);
    }
    let fingerprint = yoneda_core::fingerprint(&data)?;
    let existing = db.query(
        "SELECT seq,fingerprint FROM context_access WHERE call_id=?",
        &[json!(call_id)],
    )?;
    if let Some(row) = existing.first() {
        if row["fingerprint"] != fingerprint {
            return Err(Error::new(
                "IDEMPOTENCY_CONFLICT",
                "Context access receipt is immutable",
            ));
        }
        return Ok(json!({"seq":row["seq"],"replayed":true}));
    }
    if tool == "artifact_get" {
        if targets.len() != 1 || targets[0].digest.is_none() {
            return Err(bad(
                "Artifact access must identify its verified immutable digest",
            ));
        }
        if c.get("job_id").is_some() {
            let mut authorization = c.clone();
            authorization["op"] = json!("authorize_artifact");
            authorization["id"] = json!(targets[0].id);
            let artifact = super::mcp::handle(db, authorization, now)?;
            if artifact["digest"] != json!(targets[0].digest) {
                return Err(Error::new(
                    "DIGEST_MISMATCH",
                    "Artifact access digest changed",
                ));
            }
        }
        if let Some(execution) = data["execution_id"].as_str() {
            edge(
                db,
                &targets[0].id,
                execution,
                "retrieved_by",
                targets[0].digest.as_deref().unwrap_or_default(),
            )?;
            event(
                db,
                "artifact.retrieved",
                now,
                json!({"artifact":targets[0].id,"execution":execution,"epoch":data["epoch"],"call_id":call_id}),
            )?;
        }
    }
    let rows = db.query("INSERT INTO context_access(call_id,run_id,execution_id,epoch,grant_id,session_id,stage,tool,at,fingerprint,data) VALUES(?,?,?,?,?,?,?,?,?,?,?) RETURNING seq", &[
        json!(call_id),data["run_id"].clone(),data["execution_id"].clone(),data["epoch"].clone(),data["grant_id"].clone(),data["session_id"].clone(),json!(stage),json!(tool),json!(now),json!(fingerprint),json!(data.to_string())])?;
    event(
        db,
        "context.accessed",
        now,
        json!({"receipt_seq":rows[0]["seq"],"call_id":call_id,"tool":tool,"stage":stage,
            "run_id":data["run_id"],"execution_id":data["execution_id"],"epoch":data["epoch"],
            "target_count":targets.len()}),
    )?;
    Ok(json!({"seq":rows[0]["seq"],"replayed":false}))
}
