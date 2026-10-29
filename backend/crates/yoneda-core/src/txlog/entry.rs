use super::invalid;
use crate::{
    Result,
    git_object::{FileMode, ObjectId},
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TxKind {
    Commit,
    Merge,
    Revert,
    Import,
    /// A ref moved to an existing commit (branch create, reset by owner) without new content.
    RefMove,
    RefDelete,
    /// A path-disjoint landing appended as its changeset (Scion): `new` is the landed
    /// commit whose changes it carries, `old` is unset, and the branch's Git commit at this
    /// version is built later by the deterministic projector.
    Changeset,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PathOp {
    Add,
    Modify,
    Delete,
}

/// One path changed relative to the entry's first parent (Scion's changeset shape).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PathTouch {
    pub path: String,
    pub op: PathOp,
    #[schemars(with = "Option<String>")]
    pub old_blob: Option<ObjectId>,
    #[schemars(with = "Option<String>")]
    pub new_blob: Option<ObjectId>,
    /// The new file's mode (`blob`, `exec` or `symlink`), so the change applies without
    /// reading its commit's tree. Absent on deletions and on entries written before it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<FileMode>,
}

impl PathTouch {
    fn validate(&self) -> Result<()> {
        let consistent = match self.op {
            PathOp::Add => self.old_blob.is_none() && self.new_blob.is_some(),
            PathOp::Modify => self.old_blob.is_some() && self.new_blob.is_some(),
            PathOp::Delete => self.old_blob.is_some() && self.new_blob.is_none(),
        } && match self.mode {
            None => true,
            Some(FileMode::Blob | FileMode::Executable | FileMode::Symlink) => {
                self.new_blob.is_some()
            }
            Some(_) => false,
        };
        if !consistent
            || self.path.is_empty()
            || self.path.starts_with('/')
            || self.path.ends_with('/')
        {
            return Err(invalid(format!("Inconsistent path touch {:?}", self.path)));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TxEntry {
    pub version: u64,
    /// The snapshot version the writer read from; `version - 1` for a fast-forward.
    pub base_version: u64,
    pub kind: TxKind,
    pub refname: String,
    #[schemars(with = "Option<String>")]
    pub old: Option<ObjectId>,
    #[schemars(with = "Option<String>")]
    pub new: Option<ObjectId>,
    pub paths: Vec<PathTouch>,
    /// Declared read set (paths or `dir/` prefixes) used for independence checks.
    pub read_set: Vec<String>,
    pub actor: String,
    pub intent_digest: String,
    pub committed_at_ms: i64,
    /// The ref-map digest of the checkpoint written at `version - 1`, when one was: the
    /// chain then binds that checkpoint's refs, not only its position (Delta's version
    /// checksum). Absent otherwise and on entries written before it, so their digests hold.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_refs: Option<String>,
    /// Hash of the previous entry's chain digest and this entry; makes the log tamper-evident.
    pub chain: String,
}

impl TxEntry {
    pub fn validate(&self, previous_chain: &str) -> Result<()> {
        if self.base_version >= self.version {
            return Err(invalid("Base version must precede the entry version"));
        }
        if !self.refname.starts_with("refs/") || self.refname.contains("..") {
            return Err(invalid("Ref names must be fully qualified"));
        }
        if (self.kind == TxKind::RefDelete) != self.new.is_none() {
            return Err(invalid("Only ref deletion has no new commit"));
        }
        if self.kind == TxKind::Changeset && self.old.is_some() {
            return Err(invalid("A changeset names no old commit"));
        }
        let mut seen = std::collections::BTreeSet::new();
        for touch in &self.paths {
            touch.validate()?;
            if !seen.insert(touch.path.as_str()) {
                return Err(invalid("A path appears twice in one entry"));
            }
        }
        if self.chain != chain_digest(previous_chain, self)? {
            return Err(invalid(format!(
                "Chain digest mismatch at version {}",
                self.version
            )));
        }
        Ok(())
    }
}

/// `sha256(previous chain ‖ entry without its own chain)`: the `fingerprint` of
/// `{"entry": <entry without chain>, "previous": <previous chain>}`, hashed as it is
/// written, a path at a time. Built as one JSON value (twice: the canonical copy), a
/// fast-forward of 200 pushed commits (40,000 paths) held about 75 MiB in a 128 MB isolate.
pub fn chain_digest(previous_chain: &str, entry: &TxEntry) -> Result<String> {
    use sha2::{Digest, Sha256};
    let encode = |e: serde_json::Error| invalid(e.to_string());
    let canonical = |v: &serde_json::Value| crate::canonical(v);
    // The entry without its paths: a small value, its keys in order.
    let light = TxEntry {
        paths: Vec::new(),
        read_set: entry.read_set.clone(),
        refname: entry.refname.clone(),
        actor: entry.actor.clone(),
        intent_digest: entry.intent_digest.clone(),
        checkpoint_refs: entry.checkpoint_refs.clone(),
        chain: String::new(),
        ..*entry
    };
    let body = canonical(&serde_json::to_value(&light).map_err(encode)?)?;
    let serde_json::Value::Object(fields) = body else {
        return Err(invalid("An entry is an object"));
    };
    let mut hasher = Sha256::new();
    hasher.update(crate::FINGERPRINT_PREFIX);
    hasher.update(b"{\"entry\":{");
    let mut first = true;
    for (key, value) in fields.iter().filter(|(key, _)| key.as_str() != "chain") {
        if !first {
            hasher.update(b",");
        }
        first = false;
        hasher.update(serde_json::to_vec(key).map_err(encode)?);
        hasher.update(b":");
        if key == "paths" {
            hasher.update(b"[");
            for (i, touch) in entry.paths.iter().enumerate() {
                if i > 0 {
                    hasher.update(b",");
                }
                let touch = canonical(&serde_json::to_value(touch).map_err(encode)?)?;
                hasher.update(serde_json::to_vec(&touch).map_err(encode)?);
            }
            hasher.update(b"]");
        } else {
            hasher.update(serde_json::to_vec(value).map_err(encode)?);
        }
    }
    hasher.update(b"},\"previous\":");
    hasher.update(serde_json::to_vec(previous_chain).map_err(encode)?);
    hasher.update(b"}");
    Ok(crate::hex(&hasher.finalize()))
}
