//! Ref checkpoints: the refs after every `CHECKPOINT_EVERY`th log version, so a snapshot
//! at any version is the nearest checkpoint plus a short, verified replay.
use super::rows::corrupt;
use crate::storage::{SqlStore, bad};
use serde_json::json;
use yoneda_core::{Error, Result, git_object::ObjectId, txlog::Checkpoint};

/// Checkpoints are written every `CHECKPOINT_EVERY` log versions.
pub const CHECKPOINT_EVERY: u64 = 64;

/// The latest checkpoint at or before `version` (the empty state when none). A checkpoint
/// must agree with the log's chain digest at its version, or reads refuse to trust it.
pub fn checkpoint_at_or_before<S: SqlStore>(db: &S, version: u64) -> Result<Checkpoint> {
    let Some(row) = db
        .query(
            "SELECT c.checkpoint,t.chain FROM txlog_checkpoints c JOIN txlog t ON t.version=c.version WHERE c.version<=? ORDER BY c.version DESC LIMIT 1",
            &[json!(version)],
        )?
        .into_iter()
        .next()
    else {
        return Ok(Checkpoint::default());
    };
    let checkpoint: Checkpoint =
        serde_json::from_str(row["checkpoint"].as_str().unwrap_or_default())
            .map_err(|_| corrupt("checkpoint"))?;
    if row["chain"].as_str() != Some(checkpoint.chain.as_str()) {
        return Err(Error::new(
            "TXLOG_INVALID",
            "A checkpoint disagrees with the log",
        ));
    }
    Ok(checkpoint)
}

/// Records the refs after `version` when it is a checkpoint version.
pub fn maybe_checkpoint<S: SqlStore>(db: &S, version: u64, chain: &str) -> Result<()> {
    // While a changeset is unprojected the refs table lags the log; skip this checkpoint.
    if !version.is_multiple_of(CHECKPOINT_EVERY) || super::changesets::any_unprojected(db)? {
        return Ok(());
    }
    let refs = db
        .query("SELECT name,commit_id FROM refs", &[])?
        .into_iter()
        .map(|r| {
            Ok((
                r["name"].as_str().unwrap_or_default().to_owned(),
                ObjectId::parse(r["commit_id"].as_str().unwrap_or_default())?,
            ))
        })
        .collect::<Result<_>>()?;
    let checkpoint = Checkpoint {
        version,
        refs,
        chain: chain.into(),
    };
    db.query(
        "INSERT INTO txlog_checkpoints(version,checkpoint) VALUES(?,?) ON CONFLICT(version) DO NOTHING",
        &[json!(version), json!(serde_json::to_string(&checkpoint).map_err(|e| bad(&e.to_string()))?)],
    )?;
    Ok(())
}
