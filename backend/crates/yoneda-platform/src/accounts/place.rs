//! Where an account or org lives, for a request to find its cell (docs/global-scale-plan.md,
//! cells as built). `region` is the code it started with; `cells` are the others that hold its
//! repositories or memberships. Neither is written unless a cell exists, so an older account
//! answers exactly as it did.
use super::*;
use yoneda_core::account::ACCOUNT_REGIONS;

const CELLS: &str = "cells";
const NO_REGION: &str = "enam";

fn cells<S: SqlStore>(db: &S) -> Vec<String> {
    get(db, CELLS)
        .ok()
        .and_then(|held| serde_json::from_value(held).ok())
        .unwrap_or_default()
}

/// Adds what is held to an answer that names an account: nothing, if nothing is.
pub(super) fn add<S: SqlStore>(db: &S, answer: &mut Value) -> Result<()> {
    if let Ok(account) = get(db, "account")
        && account.get("region").is_some()
    {
        answer["region"] = account["region"].clone();
    }
    let held = cells(db);
    if !held.is_empty() {
        answer["cells"] = json!(held);
    }
    Ok(())
}

/// `account_place`: for a reader with no credentials of this account, such as a profile page.
pub(super) fn read<S: SqlStore>(db: &S) -> Result<Value> {
    let region = get(db, "account")
        .ok()
        .and_then(|a| a["region"].as_str().map(str::to_owned));
    Ok(json!({"region": region.as_deref().unwrap_or(NO_REGION), "cells": cells(db)}))
}

/// `account_place_note {cell}`: a repository or a membership landed in `cell`. Repeating it
/// changes nothing; it is forgiven by reading one cell more, never by missing one.
pub(super) fn note<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let cell = string(c, "cell")?;
    if !ACCOUNT_REGIONS.contains(&cell.as_str()) {
        return Err(bad("cell must be a region code"));
    }
    let mut held = cells(db);
    if !held.contains(&cell) {
        held.push(cell);
        held.sort();
        put(db, CELLS, &json!(held))?;
    }
    Ok(json!({ "cells": held }))
}
