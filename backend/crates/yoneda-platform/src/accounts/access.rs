//! Operator-set account access. An operator's suspension refuses every credential of the
//! account (sessions, password and provider sign-in, personal access tokens, SSH keys) until
//! it is lifted; nothing is deleted, so each works again afterwards. An account that once
//! held a reviewer policy (the retired judging trial) also signs in only while that policy is
//! unexpired and unrevoked; nothing writes a policy any more, existing ones keep their limits.
use super::op::AccessOp;
use super::*;

const SUSPENSION: &str = "suspension";

pub(super) fn handle<S: SqlStore>(db: &S, op: AccessOp, now: i64) -> Result<Value> {
    match op {
        AccessOp::Summary => summary(db),
        AccessOp::Suspend => {
            account(db)?;
            let at = match suspended_at(db)? {
                Some(at) => at,
                None => {
                    put(db, SUSPENSION, &json!({"at":now}))?;
                    audit(db, "account.suspended", now, json!({}))?;
                    now
                }
            };
            Ok(json!({"suspended_at":at}))
        }
        AccessOp::Unsuspend => {
            account(db)?;
            if suspended_at(db)?.is_some() {
                db.query(
                    &format!("DELETE FROM {TABLE} WHERE id=?"),
                    &[json!(SUSPENSION)],
                )?;
                audit(db, "account.unsuspended", now, json!({}))?;
            }
            Ok(json!({"suspended_at":null}))
        }
    }
}

/// What the admin index shows of an account: when it was made, its contact email, sign-in
/// providers and password, handle, organization hints and suspension. Never a secret or a
/// digest.
fn summary<S: SqlStore>(db: &S) -> Result<Value> {
    let a = account(db)?;
    let providers: Vec<Value> = db
        .query(
            "SELECT provider FROM account_identities ORDER BY created_at,provider",
            &[],
        )?
        .into_iter()
        .map(|row| row["provider"].clone())
        .collect();
    Ok(json!({
        "username": a["username"],
        "created_at": a["created_at"],
        "email": a.get("email").cloned().unwrap_or(Value::Null),
        "handle": super::handles::own(db)?,
        "providers": providers,
        "password": a["verifier"].is_object(),
        "orgs": super::orgs::hints(db)?,
        "suspended_at": suspended_at(db)?,
    }))
}

/// When an operator suspended the account; `None` while it is not suspended.
pub(super) fn suspended_at<S: SqlStore>(db: &S) -> Result<Option<i64>> {
    Ok(get(db, SUSPENSION).ok().and_then(|s| s["at"].as_i64()))
}

/// Refuses a credential of a suspended account (tokens and SSH keys): its own code, so the
/// adapter never takes it for a revoked credential and drops its lookup.
pub(super) fn refuse_suspended<S: SqlStore>(db: &S) -> Result<()> {
    if suspended_at(db)?.is_some() {
        return Err(Error::new("ACCOUNT_SUSPENDED", "This account is suspended"));
    }
    Ok(())
}

/// Whether the account may sign in now: not suspended, and within any retained reviewer
/// policy.
pub(super) fn valid<S: SqlStore>(db: &S, now: i64) -> Result<bool> {
    if suspended_at(db)?.is_some() {
        return Ok(false);
    }
    let rows = db.query(
        "SELECT payload FROM workspace_records WHERE id='reviewer_policy'",
        &[],
    )?;
    let Some(row) = rows.first() else {
        return Ok(true);
    };
    let policy: Value = serde_json::from_str(
        row["payload"]
            .as_str()
            .ok_or_else(|| bad("Corrupt reviewer policy"))?,
    )
    .map_err(|e| bad(&e.to_string()))?;
    Ok(policy["revoked"] != true && policy["expires"].as_i64().is_some_and(|e| e > now))
}
