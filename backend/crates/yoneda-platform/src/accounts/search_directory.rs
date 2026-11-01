//! An owner's search directory: a sibling authority instance (`search:<owner>`) holding one
//! `workspace_records` row per repository (`search:<repo>`), so that a search across an
//! account's repositories can skip the ones that can't match. Rows are rebuildable and
//! nothing depends on them: no row, a row with no bits, a row of another version and activity
//! newer than the row all answer "maybe", and the repository's own search decides. Nothing
//! here answers anything but repository ids the caller named, and the bits never leave.
//!
//! A row's `at` is when its content was read, not when it was written. It only moves forward,
//! so a slow job can't bring back a summary that was voided after it read.
use super::op::SearchOp;
use super::*;
use std::collections::HashMap;
use yoneda_core::search::summary::{SUMMARY_VERSION, Summary, digit_holds, digit_of, query_bits};

const RECORD: &str = "search:";
/// Repositories one `search_match` takes.
const MOST: usize = 200;

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, op: SearchOp, now: i64) -> Result<Value> {
    if get(db, "account").is_ok() {
        return Err(bad("An account's authority holds no search directory"));
    }
    match op {
        SearchOp::Put => put_summary(db, c),
        SearchOp::Touch => touch(db, c),
        SearchOp::Fork => fork(db, c),
        SearchOp::Void => void(db, c, now),
        SearchOp::Drop => drop_row(db, c),
        SearchOp::Match => matching(db, c),
    }
}

fn repo(value: &Value) -> Result<String> {
    let repo = value.as_str().unwrap_or_default();
    let valid = repo.len() == 21
        && repo.starts_with('r')
        && repo[1..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if valid {
        Ok(format!("{RECORD}{repo}"))
    } else {
        Err(bad("repo must be a repository id"))
    }
}

/// The row's `at`, if it has one.
fn stored_at<S: SqlStore>(db: &S, id: &str) -> Result<Option<i64>> {
    let rows = db.query(
        &format!("SELECT json_extract(payload,'$.at') AS at FROM {TABLE} WHERE id=?"),
        &[json!(id)],
    )?;
    Ok(rows.first().and_then(|row| row["at"].as_i64()))
}

/// `search_put {repo, at, commit, bits | saturated}`: main's summary as it was at `at`,
/// unless the row knows something later.
fn put_summary<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let id = repo(&c["repo"])?;
    let at = crate::storage::number(c, "at")?;
    if stored_at(db, &id)?.is_some_and(|stored| stored >= at) {
        return Ok(json!({ "stored": false }));
    }
    let commit = string(c, "commit")?;
    let row = match c["bits"].as_str() {
        Some(bits) => {
            Summary::from_hex(bits)?;
            json!({"v": SUMMARY_VERSION, "at": at, "commit": commit, "bits": bits})
        }
        None if c["saturated"] == true => {
            json!({"v": SUMMARY_VERSION, "at": at, "commit": commit, "saturated": true})
        }
        None => return Err(bad("A summary has bits or is saturated")),
    };
    put(db, &id, &row)?;
    Ok(json!({ "stored": true }))
}

/// `search_touch {repo, commit, at}`: whether the row already summarizes `commit`; if so it
/// is good as of `at`, so a job for another branch needn't read main.
fn touch<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let id = repo(&c["repo"])?;
    let at = crate::storage::number(c, "at")?;
    let rows = db.query(
        &format!("SELECT 1 AS x FROM {TABLE} WHERE id=? AND json_extract(payload,'$.commit')=?"),
        &[json!(id), json!(string(c, "commit")?)],
    )?;
    if rows.is_empty() {
        return Ok(json!({ "current": false }));
    }
    db.query(
        &format!("UPDATE {TABLE} SET payload=json_set(payload,'$.at',?) WHERE id=? AND json_extract(payload,'$.at')<?"),
        &[json!(at), json!(id), json!(at)],
    )?;
    Ok(json!({ "current": true }))
}

/// `search_fork {repo, at}`: a new fork, nothing of its own yet: it holds what its parent
/// does, so a search leaves it out until it has activity of its own.
fn fork<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let id = repo(&c["repo"])?;
    let at = crate::storage::number(c, "at")?;
    if stored_at(db, &id)?.is_none() {
        put(
            db,
            &id,
            &json!({"v": SUMMARY_VERSION, "at": at, "fork": true}),
        )?;
    }
    Ok(json!({ "ok": true }))
}

/// `search_void {repo}`: forgets the summary but not when: anything read before now stays out.
fn void<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    put(
        db,
        &repo(&c["repo"])?,
        &json!({"v": SUMMARY_VERSION, "at": now}),
    )?;
    Ok(json!({ "ok": true }))
}

/// `search_drop {repo}`: the repository is gone.
fn drop_row<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    db.query(
        &format!("DELETE FROM {TABLE} WHERE id=?"),
        &[json!(repo(&c["repo"])?)],
    )?;
    Ok(json!({ "ok": true }))
}

/// What one row says about a query's bits.
fn can_match(row: &Value, activity: i64, bits: &[u32]) -> bool {
    if row["v"].as_i64() != Some(SUMMARY_VERSION)
        || row["at"].as_i64().is_none_or(|at| activity > at)
    {
        return true;
    }
    if row["fork"] == 1 {
        return false;
    }
    bits.iter().enumerate().all(|(i, &bit)| {
        // No bits (voided or saturated) has no digit, which proves nothing.
        let digit = row[format!("d{i}")].as_str().unwrap_or_default();
        digit_holds(digit, bit)
    })
}

/// `search_match {repos: [{id, at}], query}`: of the repositories named, each with its newest
/// activity, those that may hold `query`. SQL reads the few digits the query needs, so a
/// summary's bits stay in this object.
fn matching<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let asked = c["repos"]
        .as_array()
        .filter(|repos| repos.len() <= MOST)
        .ok_or_else(|| bad(&format!("repos must list at most {MOST} repositories")))?;
    let query = string(c, "query")?;
    let bits = query_bits(&query);
    let mut activity = HashMap::with_capacity(asked.len());
    for entry in asked {
        activity.insert(
            repo(&entry["id"])?,
            entry["at"].as_i64().unwrap_or(i64::MAX),
        );
    }
    if bits.is_empty() {
        let all: Vec<&str> = activity.keys().map(|id| &id[RECORD.len()..]).collect();
        return Ok(json!({ "maybe": all }));
    }
    let digits: String = (0..bits.len())
        .map(|i| format!(",substr(json_extract(payload,'$.bits'),?,1) AS d{i}"))
        .collect();
    let sql = format!(
        "SELECT id,json_extract(payload,'$.v') AS v,json_extract(payload,'$.at') AS at,\
         json_extract(payload,'$.fork') AS fork{digits} FROM {TABLE} \
         WHERE id IN (SELECT value FROM json_each(?))"
    );
    let ids: Vec<&String> = activity.keys().collect();
    let mut params: Vec<Value> = bits.iter().map(|&b| json!(digit_of(b) + 1)).collect();
    params.push(json!(json!(ids).to_string()));
    let rows = db.query(&sql, &params)?;
    let by_id: HashMap<&str, &Value> = rows
        .iter()
        .filter_map(|row| Some((row["id"].as_str()?, row)))
        .collect();
    let maybe: Vec<&str> = activity
        .iter()
        .filter(|(id, at)| {
            by_id
                .get(id.as_str())
                .is_none_or(|row| can_match(row, **at, &bits))
        })
        .map(|(id, _)| &id[RECORD.len()..])
        .collect();
    Ok(json!({ "maybe": maybe }))
}
