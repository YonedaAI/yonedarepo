//! The published head of a branch: everything a commit needs to begin and a read needs to
//! serve the latest version, so neither asks the authority. The last projected Git head
//! and the version it reflects (the base new work builds on), the changesets landed since
//! (the overlay: path → blob, with the landed commit's tree), and the access snapshot (workspace, visibility, live
//! token digests and grants, members, automation pause). Caches may serve it stale: landing re-checks access and
//! validates the base against the log.
use super::changesets::settled_head;
use super::rows::{self, Settings, branch_ref, current_version};
use crate::storage::SqlStore;
use serde_json::{Value, json};
use yoneda_core::{Error, Result, txlog::TxEntry};

pub fn head<S: SqlStore>(db: &S, c: &Value, settings: &Settings) -> Result<Value> {
    let refname = branch_ref(c)?;
    let (head, base_version) = settled_head(db, &refname)?;
    let head = head.ok_or_else(|| Error::new("NOT_FOUND", format!("{refname} does not exist")))?;
    let row = rows::recorded(db, &head)?;
    let projected_version =
        db.query("SELECT version FROM refs WHERE name=?", &[json!(refname)])?[0]["version"].clone();
    let mut overlay = Vec::new();
    for pending in db.query(
        "SELECT t.entry,c.commit_id,c.tree FROM changesets c JOIN txlog t ON t.version=c.version \
         WHERE c.refname=? AND c.projected IS NULL ORDER BY c.version",
        &[json!(refname)],
    )? {
        let entry: TxEntry = serde_json::from_str(pending["entry"].as_str().unwrap_or_default())
            .map_err(|_| rows::corrupt("log entry"))?;
        let paths: Vec<Value> = entry
            .paths
            .iter()
            .map(|t| json!({ "path": t.path, "blob": t.new_blob, "mode": t.mode }))
            .collect();
        // The landed commit's tree gives a read the file's mode as well as its blob.
        let tree = match pending["tree"].as_str() {
            Some(tree) => json!(tree),
            None => json!(rows::recorded(db, &rows::object_id(&pending, "commit_id")?)?.tree),
        };
        overlay.push(json!({
            "version": entry.version, "commit": pending["commit_id"], "tree": tree, "paths": paths,
        }));
    }
    let paused = !super::break_glass::state(db)?["paused"].is_null();
    let tokens = super::auth::live_tokens(db)?;
    let members = super::members::live(db)?;
    // Changes only when access does, so caches keep the access snapshot across landings.
    let visibility = settings.visibility.as_str();
    let quarantined = super::quarantine::withheld(db)?;
    let quarantine_epoch = super::quarantine::epoch(db)?;
    let access_version = yoneda_core::fingerprint(&json!({
        "tokens": tokens, "members": members, "paused": paused, "workspace": settings.workspace,
        "visibility": visibility, "quarantine_epoch": quarantine_epoch,
    }))?;
    Ok(json!({
        "ref": refname, "version": current_version(db)?, "base_version": base_version,
        "head": { "id": head, "tree": row.tree, "generation": row.generation },
        "projected_version": projected_version, "overlay": overlay,
        "object_store": settings.object_store, "runners": !settings.policy.runners.is_empty(),
        "workspace": settings.workspace, "owner": settings.owner,
        "paused": paused, "tokens": tokens, "members": members, "visibility": visibility,
        "access_version": access_version,
        "quarantined": quarantined, "quarantine_epoch": quarantine_epoch,
    }))
}
