//! Builds a commit on the server. The adapter supplies existing trees by id; this module
//! asks for exactly the directories on changed paths (one round per depth), verifies every
//! supplied tree against its id, and returns the pack to push before the commit is recorded.
use super::rows::{self, branch_ref, current_version, object_id};
use super::tree_cache;
use crate::platform_objects;
use crate::storage::{SqlStore, bad, number, string};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap};
use yoneda_core::{
    Error, Result,
    git_object::*,
    txlog::{PathOp, PathTouch},
};

const MAX_CHANGES: usize = 10_000;
const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 100 * 1024 * 1024;
const PREPARED_TTL_MS: i64 = 60 * 60 * 1000;
const COMMITTER: (&str, &str) = ("YonedaRepo", "commits@yonedarepo.invalid");

enum Content {
    Bytes(Vec<u8>),
    /// A blob already in the object store (revert, cherry-pick): referenced, not re-sent.
    Known(ObjectId),
}

struct Change {
    path: String,
    target: Option<(FileMode, Content)>,
    /// Precondition on the parent: the path's current blob (`None`: absent).
    expect: Option<Option<ObjectId>>,
}

fn expectation(change: &Value) -> Result<Option<Option<ObjectId>>> {
    match change.get("expect") {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(_) => Ok(Some(Some(object_id(change, "expect")?))),
    }
}

fn file_mode(change: &Value) -> Result<FileMode> {
    Ok(match change["type"].as_str() {
        Some("symlink") => FileMode::Symlink,
        Some("exec") => FileMode::Executable,
        Some("blob") | None if change["executable"] == true => FileMode::Executable,
        Some("blob") | None => FileMode::Blob,
        Some(_) => return Err(bad("Change type must be blob, exec or symlink")),
    })
}

struct Trees(HashMap<ObjectId, Vec<TreeEntry>>);
impl TreeSource for Trees {
    fn tree(&self, id: &ObjectId) -> Result<Vec<TreeEntry>> {
        self.0
            .get(id)
            .cloned()
            .ok_or_else(|| Error::new("TREE_MISSING", format!("Tree {id} was not supplied")))
    }
}

/// Supplied trees are untrusted: each must hash to the id it is filed under.
fn supplied_trees(c: &Value) -> Result<Trees> {
    platform_objects::supplied_trees(c).map(Trees)
}

fn changes(c: &Value) -> Result<Vec<Change>> {
    let list = c["changes"]
        .as_array()
        .filter(|l| l.len() <= MAX_CHANGES)
        .filter(|l| {
            !l.is_empty()
                || c.get("merge_parent").is_some_and(|p| !p.is_null())
                || c["merge_parents"].as_array().is_some_and(|p| !p.is_empty())
        });
    let mut total = 0usize;
    list.ok_or_else(|| bad("Provide 1 to 10000 changes"))?
        .iter()
        .map(|change| {
            let path = string(change, "path")?;
            let expect = expectation(change)?;
            if change["delete"] == true {
                return Ok(Change {
                    path,
                    target: None,
                    expect,
                });
            }
            if change.get("blob").is_some() {
                let blob = Content::Known(object_id(change, "blob")?);
                return Ok(Change {
                    path,
                    target: Some((file_mode(change)?, blob)),
                    expect,
                });
            }
            // File content is bounded by the size limits below, not the short-field cap of
            // `string` (which also rejects the empty base64 of an empty file).
            let encoded = change["content_b64"]
                .as_str()
                .ok_or_else(|| bad("Missing content_b64"))?;
            if encoded.len() > MAX_FILE_BYTES / 3 * 4 + 4 {
                return Err(Error::new(
                    "TOO_LARGE",
                    "Change exceeds file or total size limit",
                ));
            }
            let content = STANDARD
                .decode(encoded)
                .map_err(|_| bad("content_b64 is not base64"))?;
            total += content.len();
            if content.len() > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES {
                return Err(Error::new(
                    "TOO_LARGE",
                    "Change exceeds file or total size limit",
                ));
            }
            Ok(Change {
                path,
                target: Some((file_mode(change)?, Content::Bytes(content))),
                expect,
            })
        })
        .collect()
}

/// A referenced blob must already be in this repository's object store: it was written
/// by a recorded commit (or removed by one, so it existed in that commit's parent).
fn known_blob<S: SqlStore>(db: &S, id: &ObjectId) -> Result<()> {
    let found = db.query(
        "SELECT 1 AS found FROM commit_paths WHERE new_blob=? OR old_blob=? LIMIT 1",
        &[json!(id.hex()), json!(id.hex())],
    )?;
    if found.is_empty() {
        return Err(Error::new(
            "NOT_FOUND",
            format!("Blob {id} is not in this repository"),
        ));
    }
    Ok(())
}

/// Directories on changed paths that are not yet supplied (the next walk frontier).
fn frontier(root: Option<ObjectId>, paths: &[&str], trees: &Trees) -> BTreeSet<ObjectId> {
    let mut missing = BTreeSet::new();
    for path in paths {
        let parts: Vec<&str> = path.split('/').collect();
        let mut dir = root;
        for (depth, part) in parts.iter().enumerate() {
            let Some(id) = dir else { break };
            let Some(entries) = trees.0.get(&id) else {
                missing.insert(id);
                break;
            };
            if depth + 1 == parts.len() {
                break;
            }
            dir = entries
                .iter()
                .find(|e| e.name == *part && e.mode.is_tree())
                .map(|e| e.id);
        }
    }
    missing
}

fn existing(root: Option<ObjectId>, path: &str, trees: &Trees) -> Option<TreeEntry> {
    let mut dir = root?;
    let parts: Vec<&str> = path.split('/').collect();
    for (depth, part) in parts.iter().enumerate() {
        let entry = trees.0.get(&dir)?.iter().find(|e| e.name == *part)?.clone();
        if depth + 1 == parts.len() {
            return Some(entry);
        }
        dir = entry.id;
    }
    None
}

/// The parent and base version: given, or a branch's head at the current version (saving
/// the caller a snapshot round trip). Callers pin what the first round returns.
fn base<S: SqlStore>(db: &S, c: &Value) -> Result<(Option<ObjectId>, u64)> {
    if c.get("parent").is_none_or(Value::is_null) && c["ref"].is_string() {
        let refname = branch_ref(c)?;
        let head = rows::ref_value(db, &refname)?
            .ok_or_else(|| Error::new("NOT_FOUND", format!("{refname} does not exist")))?;
        return Ok((Some(head), current_version(db)?));
    }
    let base_version = c["base_version"]
        .as_u64()
        .ok_or_else(|| bad("Missing base_version"))?;
    if base_version > current_version(db)? {
        return Err(Error::new(
            "STALE_INPUT",
            "Base version is newer than the log",
        ));
    }
    match c.get("parent").filter(|p| !p.is_null()) {
        Some(_) => Ok((Some(object_id(c, "parent")?), base_version)),
        None => Ok((None, base_version)),
    }
}

pub fn prepare<S: SqlStore>(db: &S, c: &Value, principal: &str) -> Result<Value> {
    let now = number(c, "now")?;
    let (parent, base_version) = base(db, c)?;
    let parent = parent.map(|id| rows::recorded(db, &id)).transpose()?;
    let root = parent.as_ref().map(|p| p.tree);
    let changes = changes(c)?;
    let mut trees = supplied_trees(c)?;
    let supplied = trees
        .0
        .iter()
        .map(|(id, entries)| Ok((*id, encode_tree(entries)?)))
        .collect::<Result<Vec<_>>>()?;
    tree_cache::keep(db, &supplied)?;
    let paths: Vec<&str> = changes.iter().map(|ch| ch.path.as_str()).collect();
    // Walk as deep as remembered trees reach; ask the adapter only for the rest.
    let missing = loop {
        let missing = frontier(root, &paths, &trees);
        if missing.is_empty() || !tree_cache::fill(db, &mut trees.0, &missing)? {
            break missing;
        }
    };
    if !missing.is_empty() {
        return Ok(json!({
            "need_trees": missing.iter().map(ObjectId::hex).collect::<Vec<_>>(),
            "parent": parent.as_ref().map(|p| p.id), "base_version": base_version,
        }));
    }
    let message = string(c, "message")?;
    let author = Signature {
        name: string(&c["author"], "name")?,
        email: string(&c["author"], "email")?,
        seconds: now / 1000,
        offset: "+0000".into(),
    };
    let committer = Signature {
        name: COMMITTER.0.into(),
        email: COMMITTER.1.into(),
        ..author.clone()
    };
    let read_set: Vec<String> =
        serde_json::from_value(c.get("read_set").cloned().unwrap_or(json!([])))
            .map_err(|_| bad("read_set must be a list of paths or path#symbol entries"))?;
    if read_set.len() > 1000
        || read_set
            .iter()
            .any(|p| p.is_empty() || p.starts_with('/') || p.contains(".."))
    {
        return Err(bad(
            "read_set entries must be relative paths, dir/ prefixes or path#symbol",
        ));
    }

    let mut blobs: Vec<(ObjectId, &[u8])> = Vec::new();
    let mut path_changes = Vec::new();
    let mut touches = Vec::new();
    let mut conflicts = Vec::new();
    for change in &changes {
        let old = existing(root, &change.path, &trees).filter(|e| !e.mode.is_tree());
        if let Some(expected) = change.expect
            && old.as_ref().map(|o| o.id) != expected
        {
            conflicts.push(change.path.clone());
            continue;
        }
        let new = match &change.target {
            None => None,
            Some((m, Content::Bytes(data))) => Some((*m, hash_object(ObjectKind::Blob, data))),
            Some((m, Content::Known(id))) => {
                known_blob(db, id)?;
                Some((*m, *id))
            }
        };
        if matches!((&old, new), (Some(o), Some((m, id))) if o.mode == m && o.id == id) {
            continue;
        }
        if let Some((_, Content::Bytes(data))) = &change.target
            && let Some((_, id)) = new
            && !blobs.iter().any(|(b, _)| *b == id)
        {
            blobs.push((id, data));
        }
        let op = match (&old, new) {
            (None, Some(_)) => PathOp::Add,
            (Some(_), Some(_)) => PathOp::Modify,
            (Some(_), None) => PathOp::Delete,
            (None, None) => {
                return Err(Error::new(
                    "NOT_FOUND",
                    format!("Cannot delete missing {}", change.path),
                ));
            }
        };
        touches.push(PathTouch {
            path: change.path.clone(),
            op,
            old_blob: old.map(|o| o.id),
            new_blob: new.map(|n| n.1),
        });
        path_changes.push(PathChange {
            path: change.path.clone(),
            target: new,
        });
    }
    if !conflicts.is_empty() {
        return Err(Error::new(
            "CONFLICT",
            format!(
                "The parent changed on {}; these paths need a three-way merge",
                conflicts.join(", ")
            ),
        ));
    }
    let merging = c.get("merge_parent").is_some_and(|p| !p.is_null())
        || c["merge_parents"].as_array().is_some_and(|p| !p.is_empty());
    if touches.is_empty() && !merging {
        return Err(Error::new(
            "NO_CHANGES",
            "Every change matches the parent commit",
        ));
    }
    let rewrite = rewrite_tree(root, &path_changes, &trees)?;
    tree_cache::keep(db, &rewrite.trees)?;
    // A merge commit's second parent is the merged work; its tree is `changes` applied to
    // the first parent, so the commit's changeset stays relative to the first parent.
    // `merge_parents` (octopus, used for group landings) or a single `merge_parent`.
    let mut merge_parent = Vec::new();
    if let Some(one) = c.get("merge_parent").filter(|p| !p.is_null()) {
        merge_parent.push(ObjectId::parse(one.as_str().unwrap_or_default())?);
    }
    for extra in c["merge_parents"].as_array().into_iter().flatten() {
        merge_parent.push(ObjectId::parse(extra.as_str().unwrap_or_default())?);
    }
    if !merge_parent.is_empty() && parent.is_none() {
        return Err(bad("A merge needs a first parent"));
    }
    if merge_parent.len() > 64 {
        return Err(bad("A merge has at most 64 merged parents"));
    }
    let merge_parent = merge_parent
        .iter()
        .map(|id| rows::recorded(db, id))
        .collect::<Result<Vec<_>>>()?;
    let parents: Vec<ObjectId> = parent.iter().chain(&merge_parent).map(|p| p.id).collect();
    let commit = Commit::new(rewrite.root, &parents, &author, &committer, &message)?;
    let commit_bytes = commit.encode();
    let id = commit.id();

    let mut objects: Vec<(ObjectId, ObjectKind, &[u8])> =
        vec![(id, ObjectKind::Commit, &commit_bytes)];
    objects.extend(
        rewrite
            .trees
            .iter()
            .map(|(t, bytes)| (*t, ObjectKind::Tree, bytes.as_slice())),
    );
    objects.extend(blobs.iter().map(|(b, data)| (*b, ObjectKind::Blob, *data)));
    let hidden = hidden_ref(&id);
    let generation = parent
        .iter()
        .chain(&merge_parent)
        .map(|p| p.generation + 1)
        .max()
        .unwrap_or(1);
    let prepared = json!({
        "tree": rewrite.root, "parents": parents, "generation": generation,
        "base_version": base_version, "touches": touches, "read_set": read_set, "message": message,
    });
    db.query(
        "INSERT INTO prepared_commits(commit_id,principal,payload,expires_at) VALUES(?,?,?,?) \
         ON CONFLICT(commit_id) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at WHERE principal=excluded.principal",
        &[json!(id.hex()), json!(principal), json!(prepared.to_string()), json!(now + PREPARED_TTL_MS)],
    )?;
    super::staging::expire(db, now)?;
    let mut result = json!({
        "commit": id, "tree": rewrite.root, "parents": parents, "touches": touches,
        "hidden_ref": hidden, "base_version": base_version,
        // Structured copies for the adapter's write-through object cache (tier 2), so it
        // never parses Git formats itself.
        "objects": objects.iter().map(|(oid, kind, data)| platform_objects::object_json(*oid, *kind, data)).collect::<Result<Vec<_>>>()?,
    });
    // A caller that can defer the push asks to stage; larger commits are still pushed.
    if c["stage"] == true && super::staging::stage(db, &id, &objects)? {
        result["staged"] = json!(true);
    } else {
        let pack = write_pack(&objects.iter().map(|(_, k, d)| (*k, *d)).collect::<Vec<_>>())?;
        result["push_b64"] =
            json!(STANDARD.encode(receive_pack_request(&hidden, None, id, &pack)?));
    }
    Ok(result)
}
