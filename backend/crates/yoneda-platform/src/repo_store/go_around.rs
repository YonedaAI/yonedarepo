//! Go-around: what a coding session must fix before its landing clears. The findings on a
//! branch's open change are unresolved comments on lines, pulled by the next session through
//! `repo_agent_context` and `repo_change_show`. The platform never wakes an agent.
//!
//! A comment stays on the commit it was made against, so one left on an older commit may
//! already be fixed. A token that commented on a newer commit has looked again, so what it
//! did not repeat is gone from here (a re-review that passes posts only a summary, and
//! nobody resolves the older findings). A person's comment stays until it is resolved. Those
//! on the head lead; `on_head` tells the rest apart. The list and bodies are bounded, and
//! the change page keeps every comment.
use crate::storage::SqlStore;
use serde_json::{Value, json};
use yoneda_core::{Result, git_object::ObjectId};

pub const MAX_FINDINGS: u64 = 10;
pub const MAX_BODY_CHARS: u64 = 400;

/// `select` over the open findings of a change, whose number binds twice.
fn open(select: &str) -> String {
    format!(
        "WITH newest AS (SELECT principal,commit_id AS looked_at,MAX(id) \
         FROM change_comments WHERE change_number=? GROUP BY principal) \
         SELECT {select} FROM change_comments k JOIN newest n ON n.principal=k.principal \
         WHERE k.change_number=? AND k.path IS NOT NULL AND k.resolved_at IS NULL \
         AND (k.principal NOT LIKE 'token:%' OR k.commit_id=n.looked_at)"
    )
}

/// The open findings of change `number`, whose current head is `head`.
pub(super) fn of_change<S: SqlStore>(db: &S, number: &Value, head: &Value) -> Result<Value> {
    let count = db.query(&open("COUNT(*) AS n"), &[number.clone(), number.clone()])?;
    let findings = db.query(
        &format!(
            "{} ORDER BY k.commit_id=? DESC,k.id DESC LIMIT ?",
            open(&format!(
                "k.id,k.commit_id AS \"commit\",k.path,k.line,k.side,\
                 substr(k.body,1,{MAX_BODY_CHARS}) AS body,k.principal,k.at"
            ))
        ),
        &[
            number.clone(),
            number.clone(),
            head.clone(),
            json!(MAX_FINDINGS),
        ],
    )?;
    let findings: Vec<Value> = findings
        .into_iter()
        .map(|mut f| {
            f["on_head"] = json!(f["commit"] == *head);
            f
        })
        .collect();
    Ok(json!({
        "change": number,
        "open": count.first().map_or(json!(0), |r| r["n"].clone()),
        "findings": findings,
    }))
}

/// Open findings from tokens, which is how agents post, on the open change whose head is
/// `commit` on base `refname`; a person's comment is theirs to resolve and isn't one.
pub(super) fn agent_findings<S: SqlStore>(db: &S, commit: &ObjectId, refname: &str) -> Result<u64> {
    let change = db.query(
        "SELECT c.number FROM changes c JOIN refs r ON r.name='refs/heads/'||c.branch \
         WHERE c.status='open' AND 'refs/heads/'||c.base=? AND r.commit_id=? LIMIT 1",
        &[json!(refname), json!(commit.hex())],
    )?;
    let Some(number) = change.first().map(|row| row["number"].clone()) else {
        return Ok(0);
    };
    let count = db.query(
        &format!("{} AND k.principal LIKE 'token:%'", open("COUNT(*) AS n")),
        &[number.clone(), number],
    )?;
    Ok(count.first().and_then(|r| r["n"].as_u64()).unwrap_or(0))
}

/// The open findings of `branch`'s open change; null when it has none open.
pub(super) fn of_branch<S: SqlStore>(db: &S, branch: &str) -> Result<Value> {
    let open = db.query(
        "SELECT c.number,(SELECT commit_id FROM refs WHERE name='refs/heads/'||c.branch) AS head \
         FROM changes c WHERE c.branch=? AND c.status='open' LIMIT 1",
        &[json!(branch)],
    )?;
    match open.first() {
        Some(change) => of_change(db, &change["number"], &change["head"]),
        None => Ok(Value::Null),
    }
}
