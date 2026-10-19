use super::{TxEntry, TxKind, invalid};
use crate::{Result, git_object::ObjectId};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Ref state after `version`, written to R2 so a snapshot is checkpoint + log tail.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Checkpoint {
    pub version: u64,
    #[schemars(with = "BTreeMap<String, String>")]
    pub refs: BTreeMap<String, ObjectId>,
    /// Chain digest of the entry at `version` (empty for version 0).
    pub chain: String,
}

/// Applies `tail` to `from`, verifying contiguity, the hash chain and each ref's old value.
pub fn replay(from: &Checkpoint, tail: &[TxEntry]) -> Result<Checkpoint> {
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
