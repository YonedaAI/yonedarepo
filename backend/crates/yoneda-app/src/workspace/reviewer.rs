//! Operator-configured reviewer access: expiry and revocation. Neither browser nor agent may
//! amend it. The funded reviewer trial was retired; a retained `active_trial` stays readable.
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
pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    account(db)?;
    match string(c, "op")?.as_str() {
        "reviewer_status" => Ok(policy(db)?.unwrap_or(Value::Null)),
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
        _ => Err(bad("Unknown reviewer operation")),
    }
}
