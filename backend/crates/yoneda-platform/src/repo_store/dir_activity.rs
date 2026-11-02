//! What last changed each entry of a directory: one read for a page of the Code tab. A clone
//! lands as one entry of the transaction log, whatever its history, so only the commits' own
//! changed paths can say. This walks a branch's first-parent chain newest first and stops once
//! every name is found, which for a folder nobody touches lately means the whole chain:
//! `ref_chain` holds at most 5,000 commits on a branch, and a name last changed below that is
//! left out, as `path_history` leaves it, with `partial` saying so.
use super::ref_chain::{self, Below};
use super::rows::{self, branch_ref};
use crate::storage::{SqlStore, bad};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
use yoneda_core::{Error, Result};

/// Chain entries read at once. Most folders are found in the first batch.
const BATCH: i64 = 500;
/// The most entries a directory is asked about, a page's worth.
const NAMES: usize = 5_000;
const IDS: usize = 500;

pub fn dir_activity<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let refname = branch_ref(c)?;
    let dir = c["path"].as_str().unwrap_or_default().trim_matches('/');
    let mut wanted: BTreeSet<&str> = c["names"]
        .as_array()
        .filter(|names| names.len() <= NAMES)
        .ok_or_else(|| bad(&format!("names must list at most {NAMES} entries")))?
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let head = match c.get("at").filter(|v| !v.is_null()) {
        None => rows::ref_value(db, &refname)?,
        Some(_) => {
            let version = super::reads::at(db, c)?;
            super::reads::refs_at(db, c, version)?.remove(&refname)
        }
    };
    let head = head.ok_or_else(|| Error::new("NOT_FOUND", format!("{refname} does not exist")))?;
    let below = ref_chain::below(db, &refname)?;
    let chained = match below {
        Below::Lost => None,
        _ => ref_chain::depth(db, &refname, &head)?,
    };
    let Some(depth) = chained else {
        return Ok(json!({ "activity": {}, "partial": true }));
    };
    let mut spans = vec![(refname.as_str(), depth)];
    if let Below::Main(base) = below {
        spans.push((ref_chain::MAIN, depth.min(base)));
    }
    let prefix = if dir.is_empty() {
        String::new()
    } else {
        format!("{dir}/")
    };
    let mut found: BTreeMap<String, String> = BTreeMap::new();
    for (chain, top) in spans {
        walk(db, chain, top, &prefix, dir, &mut wanted, &mut found)?;
    }
    let partial = !wanted.is_empty() && ref_chain::truncated(db, &refname)?;
    Ok(json!({ "activity": described(db, found)?, "partial": partial }))
}

/// Takes from `wanted` into `found`, newest first, what the chain's commits changed.
fn walk<S: SqlStore>(
    db: &S,
    chain: &str,
    top: i64,
    prefix: &str,
    dir: &str,
    wanted: &mut BTreeSet<&str>,
    found: &mut BTreeMap<String, String>,
) -> Result<()> {
    let lowest = db.query(
        "SELECT MIN(depth) AS low FROM ref_chain WHERE ref=?",
        &[json!(chain)],
    )?;
    let lowest = lowest
        .first()
        .and_then(|r| r["low"].as_i64())
        .unwrap_or(top);
    let under = (!dir.is_empty()).then(|| [json!(prefix), json!(format!("{dir}0"))]);
    let clause = if under.is_some() {
        "AND p.path>? AND p.path<?"
    } else {
        ""
    };
    let sql = format!(
        "SELECT p.commit_id,p.path FROM ref_chain c JOIN commit_paths p ON p.commit_id=c.commit_id \
         WHERE c.ref=? AND c.depth<=? AND c.depth>? {clause} ORDER BY c.depth DESC"
    );
    let mut at = top;
    while at >= lowest && !wanted.is_empty() {
        let mut asked = vec![json!(chain), json!(at), json!(at - BATCH)];
        asked.extend(under.iter().flatten().cloned());
        for row in db.query(&sql, &asked)? {
            let path = row["path"].as_str().unwrap_or_default();
            let name = path[prefix.len()..].split('/').next().unwrap_or_default();
            if wanted.remove(name) {
                let commit = row["commit_id"].as_str().unwrap_or_default();
                found.insert(name.to_owned(), commit.to_owned());
            }
        }
        at -= BATCH;
    }
    Ok(())
}

/// Each name with what a row shows of its commit.
fn described<S: SqlStore>(db: &S, found: BTreeMap<String, String>) -> Result<Value> {
    let ids: BTreeSet<&String> = found.values().collect();
    let ids: Vec<&String> = ids.into_iter().collect();
    let mut commits: BTreeMap<String, Value> = BTreeMap::new();
    for chunk in ids.chunks(IDS) {
        for row in db.query(
            "SELECT id,message,principal,author_name,authored_at,recorded_at FROM commits \
             WHERE id IN (SELECT value FROM json_each(?))",
            &[json!(json!(chunk).to_string())],
        )? {
            let id = row["id"].as_str().unwrap_or_default().to_owned();
            let line = row["message"].as_str().unwrap_or_default();
            commits.insert(
                id.clone(),
                json!({
                    "commit": id, "message": line.lines().next().unwrap_or_default(),
                    "principal": row["principal"], "author_name": row["author_name"],
                    "authored_at": row["authored_at"], "recorded_at": row["recorded_at"],
                }),
            );
        }
    }
    let mut activity = Map::new();
    for (name, commit) in found {
        if let Some(row) = commits.get(&commit) {
            activity.insert(name, row.clone());
        }
    }
    Ok(Value::Object(activity))
}
