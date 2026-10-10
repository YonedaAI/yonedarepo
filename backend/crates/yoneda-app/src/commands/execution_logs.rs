//! Bounded diagnostics, separate from authoritative graph events and their outbox.
//! Adapters supply observations, but identity and routing come from the active job.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

pub(super) fn record<S: SqlStore>(db: &S, c: Value, now: i64) -> Result<Value> {
    let job = active(db, &c, now)?;
    if job["kind"] != "agent" {
        return Err(Error::new(
            "FORBIDDEN",
            "Only agent attempts record execution logs",
        ));
    }
    let id = string(&c, "event_id")?;
    if id.len() > 80 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err(bad("Invalid log event identifier"));
    }
    let stage = string(&c, "stage")?;
    if ![
        "model.request_started",
        "model.response_headers",
        "model.rejected",
        "model.transport_failed",
        "execution.started",
        "execution.completion_received",
        "execution.failure_received",
    ]
    .contains(&stage.as_str())
    {
        return Err(bad("Unknown execution log stage"));
    }
    let execution = &job["payload"]["execution"];
    let execution_id = string(execution, "id")?;
    let mut data = json!({"stage":stage,"job_id":job["id"],"epoch":job["epoch"],
        "execution_id":execution_id,"run_id":execution["run_id"],
        "provider":execution.get("provider").unwrap_or(&execution["harness"]),
        "model":job.get("model").unwrap_or(&execution["model"]),
        "routing":execution["routing"]});
    for (key, min, max) in [
        ("http_status", 100, 599),
        (
            "duration_ms",
            0,
            yoneda_core::model_budget::MAX_MODEL_EXECUTION_MS,
        ),
        ("request_number", 1, i64::MAX),
    ] {
        if let Some(value) = c.get(key) {
            let value = value
                .as_i64()
                .filter(|v| (min..=max).contains(v))
                .ok_or_else(|| bad("Invalid execution log number"))?;
            data[key] = json!(value);
        }
    }
    if let Some(code) = c.get("error_code") {
        let code = code
            .as_str()
            .filter(|code| {
                [
                    "PROVIDER_CONFIGURATION",
                    "PROVIDER_CHANGED",
                    "PROVIDER_MISSING",
                    "PROVIDER_AUTH",
                    "PROVIDER_BALANCE",
                    "PROVIDER_FORBIDDEN",
                    "PROVIDER_MODEL",
                    "PROVIDER_REQUEST",
                    "PROVIDER_REQUEST_LIMIT",
                    "PROVIDER_RATE_LIMIT",
                    "PROVIDER_UNAVAILABLE",
                    "PROVIDER_TRANSPORT",
                    "MODEL_REQUEST_LIMIT",
                    "MODEL_SPEND_LIMIT",
                    "BUDGET_LIMIT",
                    "RESOURCE_LIMIT",
                    "FENCED",
                    "RUNTIME",
                    "EXECUTION_TIMEOUT",
                    "MODEL_PROXY",
                    "UNKNOWN",
                ]
                .contains(code)
            })
            .ok_or_else(|| bad("Unknown execution log error code"))?;
        data["error_code"] = json!(code);
    }
    let serialized = data.to_string();
    let existing = db.query(
        "SELECT seq,data,data_pruned FROM execution_logs WHERE event_id=?",
        &[json!(id)],
    )?;
    if let Some(row) = existing.first() {
        if row["data_pruned"] != 1 && row["data"].as_str() != Some(serialized.as_str()) {
            return Err(Error::new("IDEMPOTENCY_CONFLICT", "Log event is immutable"));
        }
        return Ok(json!({"seq":row["seq"]}));
    }
    let rows = db.query(
        "INSERT INTO execution_logs(event_id,execution_id,at,data) VALUES(?,?,?,?) RETURNING seq",
        &[
            json!(id),
            json!(execution_id),
            json!(now),
            json!(serialized),
        ],
    )?;
    Ok(json!({"seq":rows[0]["seq"]}))
}

pub(super) fn read<S: SqlStore>(db: &S, c: Value) -> Result<Value> {
    let execution_id = string(&c, "execution_id")?;
    get(db, "executions", &execution_id)?;
    let after = c.get("after").map_or(Ok(0), |v| {
        v.as_i64()
            .filter(|v| *v >= 0)
            .ok_or_else(|| bad("Invalid log cursor"))
    })?;
    let mut rows = db.query("SELECT seq,at,data FROM execution_logs WHERE execution_id=? AND seq>? ORDER BY seq LIMIT 101",
        &[json!(execution_id),json!(after)])?;
    let has_more = rows.len() > 100;
    rows.truncate(100);
    for row in &mut rows {
        row["data"] = serde_json::from_str(row["data"].as_str().ok_or_else(|| bad("Corrupt log"))?)
            .map_err(|_| bad("Corrupt log"))?;
    }
    let next = rows
        .last()
        .map_or(after, |r| r["seq"].as_i64().unwrap_or(after));
    Ok(json!({"entries":rows,"next":next,"has_more":has_more}))
}
