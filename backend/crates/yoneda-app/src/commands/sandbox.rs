//! `sandbox-cli-v1`: one agent runs an unmodified coding CLI (Claude Code) in a Cloudflare
//! Sandbox that the Worker's `AgentSandbox` Durable Object drives. The ledger keeps only:
//! - the claim, with one long lease that is a safety backstop, never a heartbeat;
//! - the latest observed activity, for "last activity" and the idle marker;
//! - the pushed commit, which becomes the candidate directly (no capture job), with the same
//!   checks as a contribution capture: one commit on the frozen base in the project's repository.
//!
//! Failure uses the ordinary `fail` operation, cancellation the ordinary `cancel_run`.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_agents_core::agents::DelegationPolicy;
use yoneda_agents_core::{Error, Result};

pub(crate) const TRANSPORT: &str = "sandbox-cli-v1";
/// The Durable Object stops the CLI after two hours and then commits and pushes what exists;
/// the lease outlives that so finalization can finish before recovery fails the attempt.
const LEASE_MS: i64 = 2 * 3_600_000 + 15 * 60_000;
const SUMMARY_LIMIT: usize = 200;

/// Whether `start_run` asks for a sandbox attempt (set only by the authenticated adapter).
pub(super) fn requested(c: &Value) -> bool {
    c["workspace_transport"] == TRANSPORT
}

/// Single-agent coding runs only: compare, team and delegation come later.
pub(super) fn freeze(
    c: &Value,
    general: bool,
    team: bool,
    delegation: &DelegationPolicy,
    run: &mut Value,
) -> Result<()> {
    let agents = c["agents"].as_array().map_or(0, Vec::len);
    if !general || agents != 1 || team || c["mode"] == "collaborate" || !c["comparison"].is_null() {
        return Err(Error::new(
            "NOT_SUPPORTED",
            "Sandbox runs take exactly one coding agent, without team or comparison review",
        ));
    }
    if delegation.enabled {
        return Err(Error::new("NOT_SUPPORTED", "Sandbox runs do not delegate"));
    }
    run["runtime"] = json!(TRANSPORT);
    Ok(())
}

/// Marks a sandbox execution at schedule time.
pub(super) fn mark_execution(run: &Value, execution: &mut Value) {
    if run["runtime"] == TRANSPORT {
        execution["runtime"] = json!(TRANSPORT);
    }
}

/// A claimed sandbox job holds one lease for the whole attempt and is never re-dispatched:
/// `attempt` 2 makes lease expiry a failure in `recover`, not a second launch.
pub(super) fn claimed(job: &mut Value, now: i64) {
    if job["payload"]["execution"]["runtime"] != TRANSPORT {
        return;
    }
    job["sandbox"] = json!(true);
    job["attempt"] = json!(2);
    job["lease_until"] = json!(now + LEASE_MS);
    job["attempt_deadline"] = json!(now + LEASE_MS);
}

pub(super) fn handle<S: SqlStore>(db: &S, c: Value, now: i64) -> Result<Value> {
    let mut j = active(db, &c, now)?;
    if j["sandbox"] != true {
        return Err(Error::new("FORBIDDEN", "Not a sandbox attempt"));
    }
    match string(&c, "op")?.as_str() {
        "sandbox_progress" => progress(db, &mut j, &c["activity"], now),
        "sandbox_finish" => finish(db, &mut j, &c["result"], now),
        _ => Err(Error::new("NOT_FOUND", "Unknown sandbox operation")),
    }
}

/// Observed activity: what the CLI last did and when. It never changes the lease.
fn progress<S: SqlStore>(db: &S, j: &mut Value, activity: &Value, now: i64) -> Result<Value> {
    let phase = string(activity, "phase")?;
    if !["starting", "cloning", "running", "finalizing", "recording"].contains(&phase.as_str()) {
        return Err(bad("Unknown sandbox phase"));
    }
    let at = activity["last_activity_at"]
        .as_i64()
        .filter(|at| *at > 0 && *at <= now)
        .ok_or_else(|| bad("last_activity_at must be a past timestamp"))?;
    let summary: String = activity["summary"]
        .as_str()
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .take(SUMMARY_LIMIT)
        .collect();
    let idle_ms = activity["idle_ms"].as_i64().unwrap_or(0).max(0);
    let recorded = json!({"stage":"sandbox","phase":phase,"last_activity_at":at,"summary":summary,"idle_ms":idle_ms});
    let eid = string(&j["payload"]["execution"], "id")?;
    let mut e = get(db, "executions", &eid)?;
    let changed = e["activity"]["phase"] != recorded["phase"]
        || e["activity"]["summary"] != recorded["summary"]
        || (e["activity"]["idle_ms"].as_i64().unwrap_or(0) >= 600_000) != (idle_ms >= 600_000);
    e["activity"] = recorded.clone();
    save_execution(db, &e, now)?;
    j["progress"] = recorded.clone();
    save(db, "jobs", &string(j, "id")?, j)?;
    if changed {
        let mut data = job_event(j);
        data["progress"] = recorded;
        event(db, "job.progress", now, data)?;
    }
    Ok(json!({"recorded":true}))
}

/// The pushed commit is the candidate; evaluation then runs on that exact commit.
fn finish<S: SqlStore>(db: &S, j: &mut Value, result: &Value, now: i64) -> Result<Value> {
    let id = string(j, "id")?;
    let eid = string(&j["payload"]["execution"], "id")?;
    let mut e = get(db, "executions", &eid)?;
    let run_id = string(&e, "run_id")?;
    e["status"] = json!("completed");
    e["finished_at"] = json!(now);
    save_execution(db, &e, now)?;
    let capture = json!({"id":id,"epoch":j["epoch"],"payload":{"execution":e,"run_id":run_id,"base":e["base"],"capture_subtype":"platform_commit"}});
    super::capture_completion::complete(db, &capture, result, now)?;
    j["status"] = json!("done");
    j["result"] = result.clone();
    j["finished_at"] = json!(now);
    save(db, "jobs", &id, j)?;
    event(db, "job.completed", now, job_event(j))?;
    Ok(json!({"status":"completed","id":id,"candidate":result["id"]}))
}

#[cfg(test)]
#[path = "sandbox_tests.rs"]
mod tests;
