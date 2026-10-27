//! Shared owner allowance. Historical authorities are observed, never debited again or rewritten.
use super::*;
use crate::storage::{create, number};
use yoneda_agents_core::model_budget::MAX_SAFE_BUDGET_INTEGER;
mod history;
mod reservations;
mod transition;
#[cfg(test)]
mod transition_tests;

const STATE: &str = "workspace-spend:state";
const DEFAULT_LIMIT: i64 = 50_000_000;

fn optional<S: SqlStore>(db: &S, id: &str) -> Result<Option<Value>> {
    let rows = db.query(
        "SELECT payload FROM workspace_records WHERE id=?",
        &[json!(id)],
    )?;
    rows.first()
        .map(|r| {
            serde_json::from_str(
                r["payload"]
                    .as_str()
                    .ok_or_else(|| bad("Invalid allowance record"))?,
            )
            .map_err(|_| bad("Invalid allowance record"))
        })
        .transpose()
}
fn state<S: SqlStore>(db: &S) -> Result<Value> {
    Ok(optional(db, STATE)?.unwrap_or_else(|| json!({"version":0,"limit_microusd":DEFAULT_LIMIT,"charged_microusd":0,"reserved_microusd":0})))
}
fn add(a: i64, b: i64) -> Result<i64> {
    a.checked_add(b)
        .filter(|v| (0..=MAX_SAFE_BUDGET_INTEGER).contains(v))
        .ok_or_else(|| bad("Workspace allowance overflow"))
}
fn money(v: &Value, key: &str) -> Result<i64> {
    let n = number(v, key)?;
    if !(0..=MAX_SAFE_BUDGET_INTEGER).contains(&n) {
        return Err(bad("Invalid allowance amount"));
    }
    Ok(n)
}
fn status<S: SqlStore>(db: &S, state: &Value) -> Result<Value> {
    let (charged, reserved) = history::totals(db)?;
    let charged = add(charged, money(state, "charged_microusd")?)?;
    let reserved = add(reserved, money(state, "reserved_microusd")?)?;
    let used = add(charged, reserved)?;
    Ok(
        json!({"version":number(state,"version")?,"limit_microusd":money(state,"limit_microusd")?,"charged_microusd":charged,"reserved_microusd":reserved,"remaining_microusd":(money(state,"limit_microusd")?-used).max(0)}),
    )
}
pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    account(db)?;
    let mut s = state(db)?;
    match string(c, "op")?.as_str() {
        "workspace_spend_status" => status(db, &s),
        "workspace_spend_configure" => {
            if number(c, "expected_version")? != number(&s, "version")? {
                return Err(Error::new(
                    "STALE_VERSION",
                    "Workspace allowance configuration changed",
                ));
            }
            if number(&s, "version")? == 0 {
                transition::require_unlocked(db)?;
            }
            let limit = money(c, "limit_microusd")?;
            let before = status(db, &s)?;
            if limit == 0
                || limit
                    < add(
                        money(&before, "charged_microusd")?,
                        money(&before, "reserved_microusd")?,
                    )?
            {
                return Err(Error::new(
                    "WORKSPACE_SPEND_LIMIT",
                    "Allowance cannot be below retained spend and reservations",
                ));
            }
            let version = add(number(&s, "version")?, 1)?;
            if version == 1 {
                s["bootstrap_historical"] = json!({"charged_microusd":before["charged_microusd"],"reserved_microusd":before["reserved_microusd"]});
            }
            s["version"] = json!(version);
            s["limit_microusd"] = json!(limit);
            put(db, STATE, &s)?;
            audit(
                db,
                "workspace_spend.configured",
                now,
                json!({"version":version,"limit_microusd":limit,"retained":before}),
            )?;
            status(db, &s)
        }
        _ => {
            if number(&s, "version")? == 0 {
                return Err(Error::new(
                    "WORKSPACE_ALLOWANCE_NOT_CONFIGURED",
                    "Configure the existing workspace allowance before inference",
                ));
            }
            reservations::handle(db, c, &mut s, now)?;
            status(db, &s)
        }
    }
}
