use super::{TxEntry, TxKind, invalid};
use crate::{Result, git_object::ObjectId};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Ref state after `version`, stored so a snapshot is checkpoint + log tail.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Checkpoint {
    pub version: u64,
    #[schemars(with = "BTreeMap<String, String>")]
    pub refs: BTreeMap<String, ObjectId>,
    /// Chain digest of the entry at `version` (empty for version 0).
    pub chain: String,
}

impl Checkpoint {
    /// Digest of the full ref map (Delta's version checksum): the chain digest binds a
    /// checkpoint to its log position, this binds it to its refs.
    pub fn refs_digest(&self) -> Result<String> {
        crate::fingerprint(&serde_json::json!(self.refs))
    }

    /// Accepts a stored checkpoint only when its ref map still hashes to the digest stored
    /// with it and, once the log has moved past it, to the digest the next entry carries
    /// (checked against this checkpoint's chain so the entry cannot be swapped either).
    pub fn verify(&self, stored_digest: &str, next: Option<&TxEntry>) -> Result<()> {
        let refuse = |why: &str| {
            Err(invalid(format!(
                "Checkpoint at version {} {why}",
                self.version
            )))
        };
        if self.refs_digest()? != stored_digest {
            return refuse("has a ref map that disagrees with its digest");
        }
        let Some(next) = next else { return Ok(()) };
        if next.version != self.version + 1 {
            return refuse("is not followed by the next log version");
        }
        next.validate(&self.chain)?;
        if next.checkpoint_refs.as_deref() != Some(stored_digest) {
            return refuse("has a ref map digest that the next log entry does not record");
        }
        Ok(())
    }
}

/// Applies `tail` to `from`, verifying contiguity, the hash chain and each ref's old value.
pub fn replay(from: &Checkpoint, tail: &[TxEntry]) -> Result<Checkpoint> {
    replay_projected(from, tail, &BTreeMap::new())
}

/// `replay`, with the Git commit the projector built for each changeset version. A
/// changeset version not yet projected has no ref value to replay to.
pub fn replay_projected(
    from: &Checkpoint,
    tail: &[TxEntry],
    projected: &BTreeMap<u64, ObjectId>,
) -> Result<Checkpoint> {
    let mut state = from.clone();
    for entry in tail {
        if entry.version != state.version + 1 {
            return Err(invalid(format!(
                "Log gap: expected version {}, found {}",
                state.version + 1,
                entry.version
            )));
        }
        entry.validate(&state.chain)?;
        if entry.kind == TxKind::Changeset {
            let commit = projected.get(&entry.version).ok_or_else(|| {
                crate::Error::new(
                    "PROJECTION_PENDING",
                    format!("Version {} is not projected yet", entry.version),
                )
            })?;
            state.refs.insert(entry.refname.clone(), *commit);
            state.version = entry.version;
            state.chain = entry.chain.clone();
            continue;
        }
        if state.refs.get(&entry.refname) != entry.old.as_ref() {
            return Err(invalid(format!(
                "Version {} expected {} at a different value",
                entry.version, entry.refname
            )));
        }
        match (entry.kind, entry.new) {
            (TxKind::RefDelete, _) | (_, None) => state.refs.remove(&entry.refname),
            (_, Some(new)) => state.refs.insert(entry.refname.clone(), new),
        };
        state.version = entry.version;
        state.chain = entry.chain.clone();
    }
    Ok(state)
}
