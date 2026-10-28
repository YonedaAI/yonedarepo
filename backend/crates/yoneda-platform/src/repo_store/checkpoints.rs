//! Ref checkpoints: the refs after every `CHECKPOINT_EVERY`th log version, so a snapshot
//! at any version is the nearest checkpoint plus a short, verified replay.
use super::rows::corrupt;
use crate::storage::{SqlStore, bad};
use serde_json::json;
use yoneda_core::{
    Error, Result,
    git_object::ObjectId,
    txlog::{Checkpoint, TxEntry},
};

/// Checkpoints are written every `CHECKPOINT_EVERY` log versions.
pub const CHECKPOINT_EVERY: u64 = 64;

/// The latest checkpoint at or before `version` (the empty state when none). A checkpoint
/// must agree with the log's chain digest at its version, its ref map with its stored
/// digest, and that digest with the next entry once there is one, or reads refuse it.
/// Checkpoints written before ref-map digests are skipped: replay starts further back.
/// Once the log is compacted, "further back" ends at the anchor (the state at the floor).
pub fn checkpoint_at_or_before<S: SqlStore>(db: &S, version: u64) -> Result<Checkpoint> {
    let Some(row) = db
        .query(
            "SELECT c.checkpoint,c.refs_digest,t.chain,n.entry AS next FROM txlog_checkpoints c JOIN txlog t ON t.version=c.version LEFT JOIN txlog n ON n.version=c.version+1 WHERE c.version<=? AND c.refs_digest IS NOT NULL ORDER BY c.version DESC LIMIT 1",
            &[json!(version)],
        )?
        .into_iter()
        .next()
    else {
        let anchor = super::maintenance::archive::anchor(db)?.filter(|a| a.version <= version);
        return Ok(anchor.unwrap_or_default());
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
    let next: Option<TxEntry> = row["next"]
        .as_str()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|_| corrupt("log entry"))?;
    let digest = row["refs_digest"].as_str().unwrap_or_default();
    checkpoint.verify(digest, next.as_ref())?;
    Ok(checkpoint)
}

/// The ref-map digest of the checkpoint at `version`, if one was written there: the entry
/// after it records this digest so the chain binds the checkpoint's refs.
pub fn refs_digest_at<S: SqlStore>(db: &S, version: u64) -> Result<Option<String>> {
    Ok(db
        .query(
            "SELECT refs_digest FROM txlog_checkpoints WHERE version=?",
            &[json!(version)],
        )?
        .first()
        .and_then(|row| row["refs_digest"].as_str().map(str::to_owned)))
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
        "INSERT INTO txlog_checkpoints(version,checkpoint,refs_digest) VALUES(?,?,?) ON CONFLICT(version) DO NOTHING",
        &[
            json!(version),
            json!(serde_json::to_string(&checkpoint).map_err(|e| bad(&e.to_string()))?),
            json!(checkpoint.refs_digest()?),
        ],
    )?;
    Ok(())
}
