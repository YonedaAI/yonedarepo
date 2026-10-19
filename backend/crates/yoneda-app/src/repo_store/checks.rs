//! Platform-executed checks. A run is bound to (exact commit, check name, policy digest);
//! the adapter's queue consumer claims it with a fenced epoch and lease, executes the
//! policy's runner in a Container, and completes it. Only completions from the current
//! epoch count, so a stale or duplicated executor can never record a result.
use super::rows::{self, Policy, Runner, Settings, check_name, object_id};
use crate::storage::{SqlStore, bad, number, string};
use serde_json::{Value, json};
use yoneda_core::{Error, Result, git_object::ObjectId};

const MAX_ATTEMPTS: u64 = 3;
/// Lease beyond the runner's own timeout for container start and object transfer.
const LEASE_SLACK_MS: i64 = 5 * 60 * 1000;

/// Owner-only: replace the landing policy. Results recorded under the old digest stop
/// counting for gates, as they were produced under different rules.
pub fn set_policy<S: SqlStore>(db: &S, c: &Value, principal: &str) -> Result<Value> {
    let (_, json, digest) = Policy::parse(&c["policy"])?;
    let now = number(c, "now")?;
    db.query(
        "UPDATE repo_settings SET policy=?,policy_digest=? WHERE id='repository'",
        &[json!(json.to_string()), json!(digest)],
    )?;
    db.query(
        "INSERT INTO policy_history(digest,policy,set_by,set_at) VALUES(?,?,?,?)",
        &[
            json!(digest),
            json!(json.to_string()),
            json!(principal),
            json!(now),
        ],
    )?;
    Ok(json!({ "policy": json, "policy_digest": digest }))
}

fn run_id(commit: &ObjectId, name: &str, digest: &str, now: i64) -> String {
    let seed = format!("{commit}:{name}:{digest}:{now}");
    format!("cr_{}", &yoneda_core::digest(seed.as_bytes())[..24])
}

/// Queues runs for `names` (default: every runner in policy) unless a live run for the
/// same commit, check and policy already exists. Returns the runs to dispatch.
pub fn request<S: SqlStore>(
    db: &S,
    commit: &ObjectId,
    names: Option<Vec<String>>,
    principal: &str,
    settings: &Settings,
    now: i64,
) -> Result<Vec<Value>> {
    let names = names.unwrap_or_else(|| settings.policy.runners.keys().cloned().collect());
    let mut runs = Vec::new();
    for name in names {
        check_name(&name)?;
        let runner: &Runner = settings.policy.runners.get(&name).ok_or_else(|| {
            Error::new(
                "NOT_FOUND",
                format!("Policy has no runner for check {name}"),
            )
        })?;
        let live = db.query(
            "SELECT id,status FROM check_runs WHERE commit_id=? AND name=? AND policy_digest=? AND status<>'errored'",
            &[json!(commit.hex()), json!(name), json!(settings.policy_digest)],
        )?;
        if let Some(row) = live.first() {
            runs.push(
                json!({ "id": row["id"], "name": name, "status": row["status"], "existing": true }),
            );
            continue;
        }
        let id = run_id(commit, &name, &settings.policy_digest, now);
        db.query(
            "INSERT INTO check_runs(id,commit_id,name,policy_digest,runner,status,requested_by,created_at) VALUES(?,?,?,?,?,'queued',?,?)",
            &[json!(id), json!(commit.hex()), json!(name), json!(settings.policy_digest),
              json!(serde_json::to_string(runner).map_err(|e| bad(&e.to_string()))?), json!(principal), json!(now)],
        )?;
        runs.push(json!({ "id": id, "name": name, "status": "queued" }));
    }
    Ok(runs)
}

pub fn request_op<S: SqlStore>(
    db: &S,
    c: &Value,
    principal: &str,
    settings: &Settings,
) -> Result<Value> {
    let commit = object_id(c, "commit")?;
    rows::recorded(db, &commit)?;
    let names = match c.get("name").filter(|n| !n.is_null()) {
        Some(_) => Some(vec![string(c, "name")?]),
        None => None,
    };
    let runs = request(db, &commit, names, principal, settings, number(c, "now")?)?;
    Ok(json!({ "commit": commit, "runs": runs }))
}

fn run_row<S: SqlStore>(db: &S, id: &str) -> Result<Value> {
    db.query("SELECT * FROM check_runs WHERE id=?", &[json!(id)])?
        .into_iter()
        .next()
        .ok_or_else(|| Error::new("NOT_FOUND", "Unknown check run"))
}

/// Starts (or takes over an expired) run with a new epoch.
pub fn claim<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let id = string(c, "run_id")?;
    let now = number(c, "now")?;
    let row = run_row(db, &id)?;
    let status = row["status"].as_str().unwrap_or_default();
    if !matches!(status, "queued" | "running") {
        return Ok(json!({ "done": true, "status": status }));
    }
    let lease = row["lease_until"].as_i64().unwrap_or(0);
    if status == "running" && lease > now {
        return Ok(json!({ "busy": true, "retry_after_ms": lease - now }));
    }
    let epoch = row["epoch"].as_u64().unwrap_or(0) + 1;
    if epoch > MAX_ATTEMPTS {
        db.query(
            "UPDATE check_runs SET status='errored',finished_at=?,result=? WHERE id=?",
            &[
                json!(now),
                json!(json!({"error": "Executor did not finish after 3 attempts"}).to_string()),
                json!(id),
            ],
        )?;
        return Ok(json!({ "done": true, "status": "errored" }));
    }
    let runner: Runner = serde_json::from_str(row["runner"].as_str().unwrap_or_default())
        .map_err(|_| rows::corrupt("runner"))?;
    let lease_until = now + i64::from(runner.timeout_seconds) * 1000 + LEASE_SLACK_MS;
    db.query(
        "UPDATE check_runs SET status='running',epoch=?,lease_until=? WHERE id=?",
        &[json!(epoch), json!(lease_until), json!(id)],
    )?;
    let commit = ObjectId::parse(row["commit_id"].as_str().unwrap_or_default())?;
    let tree = rows::recorded(db, &commit)?.tree;
    Ok(json!({
        "run_id": id, "epoch": epoch, "commit": commit, "tree": tree, "name": row["name"],
        "command": runner.command, "timeout_seconds": runner.timeout_seconds,
    }))
}

/// Records the executor's outcome. `pass`/`fail` become the commit's check result under
/// the run's policy digest; `error` (infrastructure) records nothing and can be re-run.
pub fn complete<S: SqlStore>(db: &S, c: &Value, principal: &str) -> Result<Value> {
    let id = string(c, "run_id")?;
    let now = number(c, "now")?;
    let epoch = c["epoch"].as_u64().ok_or_else(|| bad("Missing epoch"))?;
    let outcome = string(c, "outcome")?;
    let status = match outcome.as_str() {
        "pass" => "passed",
        "fail" => "failed",
        "error" => "errored",
        _ => return Err(bad("Outcome must be pass, fail or error")),
    };
    let row = run_row(db, &id)?;
    if row["epoch"].as_u64() != Some(epoch) {
        return Err(Error::new(
            "STALE_EPOCH",
            "A newer attempt owns this check run",
        ));
    }
    if row["status"] != "running" {
        // Duplicate delivery of the same attempt's result is harmless.
        return Ok(json!({ "run_id": id, "status": row["status"], "already": true }));
    }
    let evidence = serde_json::to_string(&c["evidence"]).map_err(|e| bad(&e.to_string()))?;
    if evidence.len() > 16 * 1024 {
        return Err(bad("Check evidence exceeds 16 KiB; store logs as objects"));
    }
    db.query(
        "UPDATE check_runs SET status=?,finished_at=?,lease_until=NULL,result=? WHERE id=?",
        &[json!(status), json!(now), json!(evidence), json!(id)],
    )?;
    if outcome != "error" {
        db.query(
            "INSERT INTO checks(commit_id,name,policy_digest,status,evidence,principal,recorded_at) VALUES(?,?,?,?,?,?,?) \
             ON CONFLICT(commit_id,name,policy_digest) DO UPDATE SET status=excluded.status,evidence=excluded.evidence,principal=excluded.principal,recorded_at=excluded.recorded_at",
            &[row["commit_id"].clone(), row["name"].clone(), row["policy_digest"].clone(),
              json!(outcome), json!(evidence), json!(principal), json!(now)],
        )?;
    }
    Ok(json!({ "run_id": id, "status": status }))
}

pub fn run_op<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let mut row = run_row(db, &string(c, "run_id")?)?;
    row["runner"] =
        serde_json::from_str(row["runner"].as_str().unwrap_or("null")).unwrap_or(Value::Null);
    row["result"] =
        serde_json::from_str(row["result"].as_str().unwrap_or("null")).unwrap_or(Value::Null);
    Ok(row)
}

pub fn runs_for<S: SqlStore>(db: &S, commit: &ObjectId) -> Result<Vec<Value>> {
    db.query(
        "SELECT id,name,status,epoch,requested_by,created_at,finished_at,result FROM check_runs WHERE commit_id=? ORDER BY created_at,name",
        &[json!(commit.hex())],
    )
}
