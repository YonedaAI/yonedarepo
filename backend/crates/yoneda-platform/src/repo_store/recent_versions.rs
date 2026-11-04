//! Bounded newest-first browser pages. The default ascending txlog protocol is unchanged.
use super::{maintenance::archive, rows};
use crate::storage::{SqlStore, bad};
use serde_json::{Value, json};
use yoneda_core::{Error, Result, txlog::TxEntry};

fn integer(c: &Value, key: &str, default: u64) -> Result<u64> {
    match c.get(key) {
        None => Ok(default),
        Some(v) => v
            .as_u64()
            .ok_or_else(|| bad(&format!("{key} must be a nonnegative integer"))),
    }
}

fn chain_at<S: SqlStore>(db: &S, version: u64, floor: u64) -> Result<String> {
    if version == 0 {
        return Ok(String::new());
    }
    if version == floor {
        return archive::anchor(db)?
            .map(|a| a.chain)
            .ok_or_else(|| rows::corrupt("log anchor"));
    }
    if version < floor {
        return archive::recent_page(db, version, 1)?
            .last()
            .map(|e| e.chain.clone())
            .ok_or_else(|| rows::corrupt("archived version"));
    }
    db.query("SELECT chain FROM txlog WHERE version=?", &[json!(version)])?
        .first()
        .and_then(|r| r["chain"].as_str().map(str::to_owned))
        .ok_or_else(|| rows::corrupt("log chain"))
}

pub(super) fn read<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    if c.get("before").is_some() && (c.get("through").is_none() || c.get("history_chain").is_none())
    {
        return Err(bad("An older page needs its version and history chain"));
    }
    let current = rows::current_version(db)?;
    let through = integer(c, "through", current)?;
    if through > current {
        return Err(Error::new(
            "ACTIVITY_CHANGED",
            "Versions changed. Refresh to continue.",
        ));
    }
    let before = integer(c, "before", through.saturating_add(1))?;
    if before == 0 || before > through.saturating_add(1) {
        return Err(bad("before is outside this version page"));
    }
    let upper = before - 1;
    let limit = integer(c, "limit", 50)?.clamp(1, 50);
    let floor = archive::floor(db)?;
    archive::recent_required(db, through, upper, floor)?;
    let chain = chain_at(db, through, floor)?;
    if let Some(wanted) = c.get("history_chain")
        && wanted.as_str() != Some(chain.as_str())
    {
        return Err(Error::new(
            "ACTIVITY_CHANGED",
            "Versions changed. Refresh to continue.",
        ));
    }
    let entries = if upper == 0 {
        Vec::new()
    } else if upper <= floor {
        archive::recent_page(db, upper, limit)?
    } else {
        rows::entries(db, upper.saturating_sub(limit).max(floor), upper, None)?
    };
    let lower = entries.first().map(|e| e.version).unwrap_or(1);
    if upper > floor {
        let mut previous = chain_at(db, lower - 1, floor)?;
        for entry in &entries {
            entry.validate(&previous)?;
            previous = entry.chain.clone();
        }
    }
    let compact = c["compact"] == true;
    let entries: Vec<Value> = entries
        .into_iter()
        .rev()
        .map(|e: TxEntry| {
            if compact {
                json!({"version":e.version,"kind":e.kind,"committed_at_ms":e.committed_at_ms})
            } else {
                json!({"version":e.version,"kind":e.kind,"refname":e.refname,"new":e.new,
                    "actor":e.actor,"paths":e.paths,"committed_at_ms":e.committed_at_ms,"chain":e.chain})
            }
        })
        .collect();
    Ok(json!({"format":"recent-versions-v1","version":through,
        "history_chain":if through == 0 { Value::Null } else { json!(chain) },
        "entries":entries,"next_before":(lower > 1).then_some(lower)}))
}
