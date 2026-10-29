//! Bisect as a durable state machine over platform check runs: the candidates are the
//! first-parent commits after `good` up to `bad`; each step reads the policy check's
//! result on the midpoint (requesting a run if there is none) and halves the range.
use super::checks;
use super::rows::{self, Settings, branch_ref, object_id};
use crate::storage::{SqlStore, bad, number, string};
use serde_json::{Value, json};
use yoneda_core::{Error, Result, git_object::ObjectId};

const MAX_CANDIDATES: usize = 10_000;

pub fn start<S: SqlStore>(
    db: &S,
    c: &Value,
    principal: &str,
    settings: &Settings,
) -> Result<Value> {
    let refname = branch_ref(c)?;
    let check = string(c, "check")?;
    if !settings.policy.runners.contains_key(&check) {
        return Err(Error::new(
            "NOT_FOUND",
            format!("Policy has no runner for check {check}"),
        ));
    }
    let good = object_id(c, "good")?;
    let bad_commit = object_id(c, "bad")?;
    let mut candidates = Vec::new();
    let mut next = bad_commit;
    while next != good {
        candidates.push(next);
        if candidates.len() > MAX_CANDIDATES {
            return Err(bad("Range is too long to bisect"));
        }
        next = *rows::recorded(db, &next)?
            .parents
            .first()
            .ok_or_else(|| bad("good is not a first-parent ancestor of bad"))?;
    }
    if candidates.is_empty() {
        return Err(bad("good and bad are the same commit"));
    }
    candidates.reverse(); // oldest first; the last one is `bad`
    let now = number(c, "now")?;
    let id = format!(
        "bi_{}",
        &yoneda_core::digest(format!("{good}{bad_commit}{check}{now}").as_bytes())[..20]
    );
    db.query(
        "INSERT INTO bisects(id,refname,check_name,candidates,lo,hi,status,requested_by,created_at) VALUES(?,?,?,?,0,?,'running',?,?)",
        &[json!(id), json!(refname), json!(check), json!(json!(candidates).to_string()),
          json!(candidates.len() - 1), json!(principal), json!(now)],
    )?;
    step_bisect(db, &id, principal, settings, now)
}

/// Advances one bisect as far as recorded check results allow. Returns the next commit
/// whose check is needed (with any newly queued runs), or the first bad commit.
pub fn step_bisect<S: SqlStore>(
    db: &S,
    id: &str,
    principal: &str,
    settings: &Settings,
    now: i64,
) -> Result<Value> {
    let row = db
        .query("SELECT * FROM bisects WHERE id=?", &[json!(id)])?
        .into_iter()
        .next()
        .ok_or_else(|| Error::new("NOT_FOUND", "Unknown bisect"))?;
    let candidates: Vec<ObjectId> =
        serde_json::from_str(row["candidates"].as_str().unwrap_or("[]"))
            .map_err(|_| rows::corrupt("bisect"))?;
    let check = row["check_name"].as_str().unwrap_or_default().to_owned();
    let (mut lo, mut hi) = (
        row["lo"].as_u64().unwrap_or(0) as usize,
        row["hi"].as_u64().unwrap_or(0) as usize,
    );
    if row["status"] != "running" {
        // `result` is stored as JSON text; answer the object, as the step that found it did.
        let result: Value = match row["result"].as_str() {
            Some(text) => serde_json::from_str(text).map_err(|_| rows::corrupt("bisect result"))?,
            None => Value::Null,
        };
        return Ok(json!({ "id": id, "status": row["status"], "result": result }));
    }
    // Invariant: candidates[hi] is bad; the first bad commit is in [lo, hi].
    while lo < hi {
        let mid = (lo + hi) / 2;
        let status = db.query(
            "SELECT status FROM checks WHERE commit_id=? AND name=? AND policy_digest=?",
            &[
                json!(candidates[mid].hex()),
                json!(check),
                json!(settings.policy_digest),
            ],
        )?;
        match status.first().and_then(|r| r["status"].as_str()) {
            Some("pass") => lo = mid + 1,
            Some(_) => hi = mid,
            None => {
                db.query(
                    "UPDATE bisects SET lo=?,hi=? WHERE id=?",
                    &[json!(lo), json!(hi), json!(id)],
                )?;
                let runs = checks::request(
                    db,
                    &candidates[mid],
                    Some(vec![check.clone()]),
                    principal,
                    settings,
                    now,
                )?;
                return Ok(
                    json!({ "id": id, "status": "running", "testing": candidates[mid],
                    "remaining": hi - lo + 1, "runs": runs }),
                );
            }
        }
    }
    let result = json!({ "first_bad": candidates[hi], "tested_range": candidates.len() });
    db.query(
        "UPDATE bisects SET lo=?,hi=?,status='found',result=? WHERE id=?",
        &[json!(lo), json!(hi), json!(result.to_string()), json!(id)],
    )?;
    Ok(json!({ "id": id, "status": "found", "result": result }))
}

pub fn step_op<S: SqlStore>(
    db: &S,
    c: &Value,
    principal: &str,
    settings: &Settings,
) -> Result<Value> {
    step_bisect(
        db,
        &string(c, "id")?,
        principal,
        settings,
        number(c, "now")?,
    )
}

/// Running bisects waiting on `commit`'s `check` result.
pub fn waiting_on<S: SqlStore>(db: &S, commit: &str, check: &str) -> Result<Vec<String>> {
    Ok(db
        .query(
            "SELECT id,candidates FROM bisects WHERE status='running' AND check_name=?",
            &[json!(check)],
        )?
        .into_iter()
        .filter(|r| {
            r["candidates"]
                .as_str()
                .unwrap_or_default()
                .contains(commit)
        })
        .filter_map(|r| r["id"].as_str().map(str::to_owned))
        .collect())
}
