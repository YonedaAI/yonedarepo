//! Interrupted agent attempts leave a staged source checkpoint for the next attempt.
//!
//! Every API-source write is committed to the attempt's SourceWorkspace authority as it happens,
//! so a timed-out or interrupted attempt's work survives the container. The ledger records which
//! workspace holds it (`resume_from`); the next claim of the same job exposes it as `resume`, and
//! the trusted Worker copies those staged files into the new attempt's own workspace before the
//! harness starts. Identity always comes from this job record, never from model arguments.
use serde_json::{Value, json};

/// Failures that interrupt otherwise valid work; their staged source remains a useful checkpoint.
const RESUMABLE: [&str; 3] = ["EXECUTION_TIMEOUT", "HARNESS_INTERRUPTED", "LEASE_EXPIRED"];

fn code(error: &Value) -> Option<&str> {
    let text = error.as_str().or_else(|| error["code"].as_str())?;
    Some(text.split_once(':').map_or(text, |(code, _)| code).trim())
}

fn writable_workspace(j: &Value) -> Option<Value> {
    j["source_bindings"]
        .as_object()?
        .values()
        .find(|entry| entry["binding"]["access"] == "read_write")
        .map(|entry| {
            json!({"workspace_id":entry["binding"]["workspace_id"],
                "view_digest":entry["binding"]["view_digest"],"epoch":entry["producer_epoch"],
                "binding":entry["binding"]})
        })
}

fn record(j: &mut Value, reason: &str) {
    if j["kind"] != "agent" || j["payload"]["workspace_transport"] != "api-source-v1" {
        return;
    }
    // An attempt that never bound source keeps the previous checkpoint.
    if let Some(mut checkpoint) = writable_workspace(j) {
        checkpoint["reason"] = json!(reason);
        j["resume_from"] = checkpoint;
    }
}

/// Interrupted work (timeouts, stopped harnesses, expired leases), as opposed to work that
/// failed on its merits. Owner retries of interruptions resume and do not consume the retry cap.
pub(in crate::commands) fn interrupted_error(error: &Value) -> bool {
    code(error).is_some_and(|code| RESUMABLE.contains(&code))
        || error.as_str() == Some("Execution deadline exceeded")
}

/// Record a checkpoint for an interrupted attempt that failed before checkpoints existed (its
/// bindings stay on the job until the next claim). An existing checkpoint is never replaced.
pub(in crate::commands) fn backfill(j: &mut Value) {
    if j["resume_from"].is_null() && j["status"] == "failed" {
        failed(j);
    }
}

pub(super) fn failed(j: &mut Value) {
    match code(&j["error"]).map(str::to_owned) {
        Some(reason) if RESUMABLE.contains(&reason.as_str()) => record(j, &reason),
        // Work that failed on its merits must not be replayed into a later attempt.
        _ if writable_workspace(j).is_some() => j["resume_from"] = Value::Null,
        _ => {}
    }
}

pub(super) fn interrupted(j: &mut Value) {
    record(j, "LEASE_EXPIRED");
}

/// The claimed epoch may resume the recorded checkpoint; the pointer survives until a newer
/// attempt records its own workspace, so a boot failure does not lose earlier work.
pub(super) fn claimed(j: &mut Value) {
    j["resume"] = j.get("resume_from").cloned().unwrap_or(Value::Null);
}
