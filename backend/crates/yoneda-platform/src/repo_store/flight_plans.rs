//! Flight plans: what a coding session means to do, filed on purpose (`yoneda flight-plan`,
//! MCP `git_flight_plan`) before it flies, and read by whoever reviews the landing. Agents
//! are asked to file one and never made to: a landing with none just shows "No flight plan".
//! A plan is not a change row, and it is never taken from a prompt: prompts are not kept
//! (`memory::deliveries`). Its link to a landing is what the client said: the branch name,
//! a change number, or both. A plan names the whole work, so path-restricted credentials
//! neither file one nor read one.
//!
//! A repository that has not run migration 0045 has no table, so every read and write here
//! asks first (`available`): a binary that knows the version without applying it behaves as
//! if no plan was ever filed, and only the filing is refused.
use super::auth::Actor;
use super::changes::{self, whole_repository};
use super::{memory, rows};
use crate::storage::{SqlStore, bad, number};
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

/// The table's name, for what lists tables (`erase::wipe`).
pub(crate) const TABLE: &str = "flight_plans";
pub const MAX_GOAL: usize = 2000;
pub const MAX_SCOPE: usize = 2000;

const PLAN: &str = "SELECT id,session_id,branch,change_number,goal,scope,principal,at \
     FROM flight_plans";

/// Whether this repository has run the migration that adds the table.
pub(crate) fn available<S: SqlStore>(db: &S) -> Result<bool> {
    Ok(!db
        .query(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            &[json!(TABLE)],
        )?
        .is_empty())
}

/// `repo_flight_plan {goal, scope?, branch?, change?, session_id?}`.
pub fn file<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    whole_repository(actor)?;
    if !available(db)? {
        return Err(Error::new(
            "NOT_SUPPORTED",
            "This repository's schema has no flight plans yet",
        ));
    }
    let goal = changes::text(c, "goal", MAX_GOAL)?.ok_or_else(|| bad("A plan needs a goal"))?;
    let scope = changes::text(c, "scope", MAX_SCOPE)?;
    let session = memory::records::session_id(c)?;
    let change = match c.get("change").filter(|v| !v.is_null()) {
        Some(n) => Some(changes::get(
            db,
            n.as_i64()
                .filter(|n| *n > 0)
                .ok_or_else(|| bad("change must be a change number"))?,
        )?),
        None => None,
    };
    let named = match c["branch"].as_str() {
        Some(name) => Some(
            rows::branch_ref(&json!({ "ref": name }))?
                .trim_start_matches("refs/heads/")
                .to_owned(),
        ),
        None => None,
    };
    let branch = named.or_else(|| Some(change.as_ref()?["branch"].as_str()?.to_owned()));
    if branch.is_none() && session.is_none() {
        return Err(bad("A plan needs a branch, a change or a session"));
    }
    db.query(
        "INSERT INTO flight_plans(session_id,branch,change_number,goal,scope,principal,at) \
         VALUES(?,?,?,?,?,?,?)",
        &[
            json!(session),
            json!(branch),
            change.as_ref().map_or(Value::Null, |c| c["number"].clone()),
            json!(goal),
            json!(scope),
            json!(actor.principal),
            json!(number(c, "now")?),
        ],
    )?;
    let plan = db
        .query(&format!("{PLAN} WHERE id=last_insert_rowid()"), &[])?
        .into_iter()
        .next()
        .unwrap_or(Value::Null);
    Ok(json!({ "plan": plan }))
}

/// The newest plan filed for the change `number` or for its `branch` (null when none).
pub(super) fn newest<S: SqlStore>(db: &S, number: &Value, branch: &Value) -> Result<Value> {
    if !available(db)? {
        return Ok(Value::Null);
    }
    let mut plans = Vec::new();
    for (column, key) in [("change_number", number), ("branch", branch)] {
        plans.extend(db.query(
            &format!("{PLAN} WHERE {column}=? ORDER BY id DESC LIMIT 1"),
            std::slice::from_ref(key),
        )?);
    }
    Ok(plans
        .into_iter()
        .filter(|p| p["change_number"].is_null() || p["change_number"] == *number)
        .max_by_key(|p| p["id"].as_i64())
        .unwrap_or(Value::Null))
}

/// A deleted change takes the plans filed for it by number; a plan on its branch stays.
pub(super) fn forget_change<S: SqlStore>(db: &S, number: &Value) -> Result<()> {
    if available(db)? {
        db.query(
            "DELETE FROM flight_plans WHERE change_number=?",
            std::slice::from_ref(number),
        )?;
    }
    Ok(())
}
