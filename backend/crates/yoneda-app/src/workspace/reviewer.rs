//! Operator-configured trial policy. Neither browser nor agent may amend it.
use super::*;
use crate::storage::{create, number};

pub(super) fn policy<S: SqlStore>(db: &S) -> Result<Option<Value>> {
    let rows = db.query(
        "SELECT payload FROM workspace_records WHERE id='reviewer_policy'",
        &[],
    )?;
    rows.first()
        .map(|r| {
            serde_json::from_str(
                r["payload"]
                    .as_str()
                    .ok_or_else(|| bad("Corrupt reviewer policy"))?,
            )
            .map_err(|e| bad(&e.to_string()))
        })
        .transpose()
}
pub(super) fn valid<S: SqlStore>(db: &S, now: i64) -> Result<bool> {
    Ok(policy(db)?
        .is_none_or(|p| p["revoked"] != true && p["expires"].as_i64().is_some_and(|e| e > now)))
}
pub(super) fn require<S: SqlStore>(db: &S, now: i64) -> Result<Value> {
    let p = policy(db)?.ok_or_else(|| Error::new("FORBIDDEN", "Reviewer workspace required"))?;
    if !valid(db, now)? {
        return Err(Error::new(
            "REVIEWER_EXPIRED",
            "Reviewer access has expired or been revoked",
        ));
    }
    Ok(p)
}
pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    account(db)?;
    match string(c, "op")?.as_str() {
        "reviewer_status" => {
            let Some(mut p) = policy(db)? else {
                return Ok(Value::Null);
            };
            if let Some(id) = p["active_trial"].as_str()
                && let Ok(t) = get(db, TABLE, &format!("trial:{id}"))
            {
                p["_active_trial_status"] = t["status"].clone();
                if t["status"] == "repair_pending" {
                    p["_active_repair_request_id"] = t["repair_request_id"].clone();
                    p["_active_repair_fingerprint"] = t["repair_fingerprint"].clone();
                }
            }
            Ok(p)
        }
        "reviewer_configure" => {
            let repo_id = string(c, "repo_id")?;
            let expires = number(c, "expires")?;
            if repo_id.len() > 80
                || repo_id.is_empty()
                || !repo_id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
                || expires <= now
            {
                return Err(bad("Invalid reviewer configuration"));
            }
            if let Some(p) = policy(db)? {
                if p["repo_id"] != repo_id || p["expires"] != expires {
                    return Err(Error::new(
                        "IDEMPOTENCY_CONFLICT",
                        "Reviewer configuration is immutable",
                    ));
                }
                return Ok(p);
            }
            let p = json!({"repo_id":repo_id,"expires":expires,"revoked":false,"limit_microusd":50_000_000,"trial_limit_microusd":5_000_000,"active_trial":null,"trial_epoch":0});
            create(db, TABLE, "reviewer_policy", &p)?;
            let mut a = account(db)?;
            a["reviewer"] = json!(true);
            put(db, "account", &a)?;
            let mut budget = get(db, TABLE, "budget")
                .unwrap_or(json!({"charged":0,"currency":"USD","unit":"microdollar"}));
            budget["limit"] = json!(50_000_000);
            put(db, "budget", &budget)?;
            audit(
                db,
                "reviewer.configured",
                now,
                json!({"repo_id":repo_id,"expires":expires}),
            )?;
            Ok(p)
        }
        "reviewer_revoke" => {
            let mut p = policy(db)?.ok_or_else(|| bad("Reviewer not configured"))?;
            p["revoked"] = json!(true);
            put(db, "reviewer_policy", &p)?;
            db.query(
                "DELETE FROM workspace_records WHERE id LIKE 'session:%' OR id LIKE 'grant:%'",
                &[],
            )?;
            audit(db, "reviewer.revoked", now, json!({}))?;
            Ok(p)
        }
        "reviewer_trial" => {
            let mut p = require(db, now)?;
            let id = string(c, "id")?;
            if !(1..=80).contains(&id.len())
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
            {
                return Err(bad("Invalid trial ID"));
            }
            let key = format!("trial:{id}");
            if let Ok(t) = get(db, TABLE, &key) {
                return Ok(t);
            }
            if !p["active_trial"].is_null() {
                return Err(Error::new(
                    "TRIAL_ACTIVE",
                    "A reviewer trial is already running",
                ));
            }
            let t = json!({"id":id,"repo_id":p["repo_id"],"status":"active","created_at":now});
            create(db, TABLE, &key, &t)?;
            p["trial_epoch"] = json!(p["trial_epoch"].as_i64().unwrap_or(0) + 1);
            p["active_trial"] = json!(id);
            put(db, "reviewer_policy", &p)?;
            Ok(t)
        }
        "reviewer_trial_complete" => {
            let id = string(c, "id")?;
            let mut p = policy(db)?.ok_or_else(|| bad("Reviewer not configured"))?;
            let key = format!("trial:{id}");
            let mut t = get(db, TABLE, &key)?;
            let expected_epoch = number(c, "expected_epoch")?;
            let current_epoch = p["trial_epoch"].as_i64().unwrap_or(0);
            if expected_epoch != current_epoch
                || (t["status"] == "repair_pending"
                    && t["repair_pending_until"]
                        .as_i64()
                        .is_some_and(|until| until > now))
            {
                return Ok(t);
            }
            t["status"] = json!("complete");
            t.as_object_mut().map(|v| v.remove("repair_pending_until"));
            t.as_object_mut().map(|v| v.remove("repair_request_id"));
            t.as_object_mut().map(|v| v.remove("repair_fingerprint"));
            put(db, &key, &t)?;
            if p["active_trial"] == id {
                p["active_trial"] = Value::Null;
                put(db, "reviewer_policy", &p)?;
            }
            Ok(t)
        }
        "reviewer_trial_reopen" => {
            let mut p = require(db, now)?;
            let id = string(c, "id")?;
            let request_id = string(c, "request_id")?;
            let fingerprint = string(c, "fingerprint")?;
            if !(16..=64).contains(&request_id.len())
                || !request_id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                || fingerprint.len() != 64
                || !fingerprint.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err(bad("Invalid reviewer repair receipt"));
            }
            if p["active_trial"]
                .as_str()
                .is_some_and(|active| active != id)
            {
                return Err(Error::new(
                    "TRIAL_ACTIVE",
                    "A reviewer trial is already running",
                ));
            }
            let key = format!("trial:{id}");
            let mut t = get(db, TABLE, &key)?;
            if t["repo_id"] != p["repo_id"] {
                return Err(Error::new(
                    "FORBIDDEN",
                    "Trial belongs to another reviewer repository",
                ));
            }
            if t["last_repair_request_id"] == request_id
                && t["last_repair_fingerprint"] != Value::Null
                && t["last_repair_fingerprint"] != fingerprint
            {
                return Err(Error::new(
                    "IDEMPOTENCY_CONFLICT",
                    "Reviewer repair request ID was reused with different content",
                ));
            }
            if p["active_trial"] == id && t["status"] == "repair_pending" {
                if t["repair_request_id"] != request_id || t["repair_fingerprint"] != fingerprint {
                    return Err(Error::new(
                        "TRIAL_ACTIVE",
                        "A different reviewer repair is pending",
                    ));
                }
                return Ok(
                    json!({"id":id,"repo_id":p["repo_id"],"active_trial":id,"status":"reopened"}),
                );
            }
            if t["status"] != "complete" && !(p["active_trial"] == id && t["status"] == "active") {
                return Err(Error::new(
                    "INVALID_STATE",
                    "Only a completed reviewer trial can be reopened",
                ));
            }
            let epoch = p["trial_epoch"].as_i64().unwrap_or(0) + 1;
            p["trial_epoch"] = json!(epoch);
            t["status"] = json!("repair_pending");
            t["reopened_at"] = json!(now);
            t["repair_pending_until"] = json!(now + 120_000);
            t["repair_request_id"] = json!(request_id);
            t["repair_fingerprint"] = json!(fingerprint);
            p["active_trial"] = json!(id);
            put(db, &key, &t)?;
            put(db, "reviewer_policy", &p)?;
            audit(db, "reviewer.trial_reopened", now, json!({"id":id}))?;
            Ok(json!({"id":id,"repo_id":p["repo_id"],"active_trial":id,"status":"reopened"}))
        }
        "reviewer_trial_repair_finish" | "reviewer_trial_repair_abort" => {
            let id = string(c, "id")?;
            let mut p = require(db, now)?;
            let key = format!("trial:{id}");
            let mut t = get(db, TABLE, &key)?;
            let request_id = string(c, "request_id")?;
            let fingerprint = string(c, "fingerprint")?;
            let operation = string(c, "op")?;
            if operation == "reviewer_trial_repair_finish"
                && p["active_trial"] == id
                && t["status"] == "active"
                && t["last_repair_request_id"] == request_id
                && t["last_repair_fingerprint"] == fingerprint
            {
                return Ok(json!({"id":id,"active_trial":id,"status":"active"}));
            }
            if operation == "reviewer_trial_repair_abort"
                && p["active_trial"].is_null()
                && t["status"] == "complete"
                && t["last_repair_request_id"] == request_id
                && t["last_repair_fingerprint"] == fingerprint
            {
                return Ok(json!({"id":id,"status":"complete"}));
            }
            if p["active_trial"] != id || t["status"] != "repair_pending" {
                return Err(Error::new(
                    "INVALID_STATE",
                    "No matching reviewer repair is pending",
                ));
            }
            if t["repair_request_id"] != request_id || t["repair_fingerprint"] != fingerprint {
                return Err(Error::new(
                    "TRIAL_ACTIVE",
                    "Reviewer repair receipt changed",
                ));
            }
            if operation == "reviewer_trial_repair_finish" {
                t["status"] = json!("active");
                p["trial_epoch"] = json!(p["trial_epoch"].as_i64().unwrap_or(0) + 1);
                t["last_repair_request_id"] = json!(request_id);
                t["last_repair_fingerprint"] = json!(fingerprint);
                t.as_object_mut().map(|v| v.remove("repair_pending_until"));
                t.as_object_mut().map(|v| v.remove("repair_request_id"));
                t.as_object_mut().map(|v| v.remove("repair_fingerprint"));
                put(db, &key, &t)?;
                put(db, "reviewer_policy", &p)?;
                return Ok(json!({"id":id,"active_trial":id,"status":"active"}));
            }
            t["status"] = json!("complete");
            t["last_repair_request_id"] = json!(request_id);
            t["last_repair_fingerprint"] = json!(fingerprint);
            t.as_object_mut().map(|v| v.remove("repair_pending_until"));
            t.as_object_mut().map(|v| v.remove("repair_request_id"));
            t.as_object_mut().map(|v| v.remove("repair_fingerprint"));
            put(db, &key, &t)?;
            p["active_trial"] = Value::Null;
            put(db, "reviewer_policy", &p)?;
            audit(db, "reviewer.trial_repair_aborted", now, json!({"id":id}))?;
            Ok(json!({"id":id,"status":"complete"}))
        }
        _ => Err(bad("Unknown reviewer operation")),
    }
}
