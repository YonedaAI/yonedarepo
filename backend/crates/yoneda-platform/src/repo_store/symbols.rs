//! Symbol-level write sets. The platform deriver (adapter compute over both sides of
//! each file) records which symbols a commit's changes touched; clients never declare
//! them. Landing narrows later entries' writes with these rows, and any file without one
//! stays a whole-file write. Planning checks proposed work for stale reads the same way.
use super::rows::{self, branch_ref, current_version};
use crate::storage::{SqlStore, bad, number};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use yoneda_core::{
    Error, Result,
    git_object::ObjectId,
    txlog::{AccessSet, Refinements, SymbolTouch, TxEntry, WorkItem, stale_read},
};

const MAX_SYMBOLS_PER_FILE: usize = 10_000;

pub fn record<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let id = rows::recorded(db, &rows::object_id(c, "commit")?)?.id;
    let touched: BTreeSet<String> = rows::touches(db, &id)?
        .into_iter()
        .map(|t| t.path)
        .collect();
    let touches: Vec<Value> = c["touches"]
        .as_array()
        .cloned()
        .ok_or_else(|| bad("touches must be a list"))?;
    let now = number(c, "now")?;
    for touch in &touches {
        let path = touch["path"].as_str().unwrap_or_default();
        if !touched.contains(path) {
            return Err(bad(&format!("{path} is not changed by this commit")));
        }
        let symbols: Vec<String> = serde_json::from_value(touch["symbols"].clone())
            .map_err(|_| bad("symbols must be a list of names"))?;
        if symbols.is_empty() || symbols.len() > MAX_SYMBOLS_PER_FILE {
            return Err(bad("A refined file lists 1-10000 symbols"));
        }
        // Derived once per commit: the rows are immutable like the commit itself.
        db.query(
            "INSERT INTO commit_symbols(commit_id,path,symbols,derived_at) VALUES(?,?,?,?) ON CONFLICT(commit_id,path) DO NOTHING",
            &[json!(id.hex()), json!(path), json!(json!(symbols).to_string()), json!(now)],
        )?;
    }
    Ok(json!({ "commit": id, "files": touches.len() }))
}

pub fn for_commit<S: SqlStore>(db: &S, id: &ObjectId) -> Result<Vec<SymbolTouch>> {
    db.query(
        "SELECT path,symbols FROM commit_symbols WHERE commit_id=? ORDER BY path",
        &[json!(id.hex())],
    )?
    .into_iter()
    .map(|row| {
        Ok(SymbolTouch {
            path: row["path"].as_str().unwrap_or_default().into(),
            symbols: serde_json::from_str(row["symbols"].as_str().unwrap_or_default())
                .map_err(|_| rows::corrupt("symbol touches"))?,
        })
    })
    .collect()
}

pub fn as_json(touches: &[SymbolTouch]) -> Value {
    json!(
        touches
            .iter()
            .map(|t| json!({ "path": t.path, "symbols": t.symbols }))
            .collect::<Vec<_>>()
    )
}

/// Derived symbol writes of each entry's landed commit, by version.
pub fn refinements<S: SqlStore>(db: &S, entries: &[TxEntry]) -> Result<Refinements> {
    let mut out = Refinements::new();
    for entry in entries {
        if let Some(commit) = entry.new {
            let touches = for_commit(db, &commit)?;
            if !touches.is_empty() {
                out.insert(entry.version, touches);
            }
        }
    }
    Ok(out)
}

/// Proposed work items whose reads a later entry (up to the plan version) invalidated.
pub fn stale_reads<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let refname = branch_ref(c)?;
    let current = current_version(db)?;
    let at = c["at"].as_u64().unwrap_or(current);
    if at > current {
        return Err(Error::new("STALE_INPUT", "Version is newer than the log"));
    }
    let items: Vec<WorkItem> = serde_json::from_value(c["items"].clone())
        .map_err(|_| bad("items must be a list of work items"))?;
    let mut stale = Vec::new();
    for item in items {
        let Some(base) = item.base_version.filter(|b| *b < at) else {
            continue;
        };
        let later = rows::entries(db, base, at, Some(&refname))?;
        let refined = refinements(db, &later)?;
        let reads = AccessSet::parse(&item.read_set);
        if let Some((version, entries)) = stale_read(&reads, &refname, &later, &refined) {
            stale.push(json!({ "id": item.id, "version": version, "entries": entries }));
        }
    }
    Ok(json!({ "ref": refname, "version": at, "stale": stale }))
}
