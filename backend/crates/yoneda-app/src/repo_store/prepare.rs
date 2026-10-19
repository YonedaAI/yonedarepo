//! Builds a commit on the server. The adapter supplies existing trees by id; this module
//! asks for exactly the directories on changed paths (one round per depth), verifies every
//! supplied tree against its id, and returns the pack to push before the commit is recorded.
use super::rows::{self, current_version, object_id};
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

struct Change {
    path: String,
    target: Option<(FileMode, Vec<u8>)>,
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

fn mode(kind: &str) -> Result<FileMode> {
    Ok(match kind {
        "tree" => FileMode::Tree,
        "blob" => FileMode::Blob,
        "exec" => FileMode::Executable,
        "symlink" => FileMode::Symlink,
        "gitlink" => FileMode::Gitlink,
        _ => return Err(bad("Unknown tree entry type")),
    })
}

/// Supplied trees are untrusted: each must hash to the id it is filed under.
fn supplied_trees(c: &Value) -> Result<Trees> {
    let mut trees = HashMap::new();
    for (id, entries) in c["trees"].as_object().into_iter().flatten() {
        let id = ObjectId::parse(id)?;
        let entries = entries
            .as_array()
            .ok_or_else(|| bad("Tree entries must be an array"))?
            .iter()
            .map(|e| {
                Ok(TreeEntry {
                    name: string(e, "name")?,
                    mode: mode(&string(e, "type")?)?,
                    id: object_id(e, "id")?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        if hash_object(ObjectKind::Tree, &encode_tree(&entries)?) != id {
            return Err(Error::new(
                "TREE_INVALID",
                format!("Supplied tree does not match {id}"),
            ));
        }
        trees.insert(id, entries);
    }
    Ok(Trees(trees))
}

fn changes(c: &Value) -> Result<Vec<Change>> {
    let list = c["changes"]
        .as_array()
        .filter(|l| !l.is_empty() && l.len() <= MAX_CHANGES);
    let mut total = 0usize;
    list.ok_or_else(|| bad("Provide 1 to 10000 changes"))?
        .iter()
        .map(|change| {
            let path = string(change, "path")?;
            if change["delete"] == true {
                return Ok(Change { path, target: None });
            }
            let content = STANDARD
                .decode(string(change, "content_b64").or_else(|_| {
                    // An empty file has empty base64, which `string` rejects as blank.
                    (change["content_b64"] == "")
                        .then(String::new)
                        .ok_or_else(|| bad("Missing content_b64"))
                })?)
                .map_err(|_| bad("content_b64 is not base64"))?;
            total += content.len();
            if content.len() > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES {
                return Err(Error::new(
                    "TOO_LARGE",
                    "Change exceeds file or total size limit",
                ));
            }
            let file_mode = if change["executable"] == true {
                FileMode::Executable
            } else {
                FileMode::Blob
            };
            Ok(Change {
                path,
                target: Some((file_mode, content)),
            })
        })
        .collect()
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

fn entry_type(mode: FileMode) -> &'static str {
    match mode {
        FileMode::Tree => "tree",
        FileMode::Blob => "blob",
        FileMode::Executable => "exec",
        FileMode::Symlink => "symlink",
        FileMode::Gitlink => "gitlink",
    }
}

fn cache_entry(id: ObjectId, kind: ObjectKind, data: &[u8]) -> Result<Value> {
    Ok(match kind {
        ObjectKind::Tree => {
            json!({"id": id, "kind": "tree", "entries": decode_tree(data)?.iter().map(|e| json!({
            "name": e.name, "type": entry_type(e.mode), "id": e.id,
        })).collect::<Vec<_>>()})
        }
        ObjectKind::Commit => {
            let commit = Commit::decode(data)?;
            json!({"id": id, "kind": "commit", "tree": commit.tree()?, "parents": commit.parents()?})
        }
        _ => json!({"id": id, "kind": kind.name(), "data_b64": STANDARD.encode(data)}),
    })
}

pub fn prepare<S: SqlStore>(db: &S, c: &Value, principal: &str) -> Result<Value> {
    let now = number(c, "now")?;
    let base_version = c["base_version"]
        .as_u64()
        .ok_or_else(|| bad("Missing base_version"))?;
    if base_version > current_version(db)? {
        return Err(Error::new(
            "STALE_INPUT",
            "Base version is newer than the log",
        ));
    }
    let parent = match c.get("parent").filter(|p| !p.is_null()) {
        Some(_) => Some(rows::recorded(db, &object_id(c, "parent")?)?),
        None => None,
    };
    let root = parent.as_ref().map(|p| p.tree);
    let changes = changes(c)?;
    let trees = supplied_trees(c)?;
    let paths: Vec<&str> = changes.iter().map(|ch| ch.path.as_str()).collect();
    let missing = frontier(root, &paths, &trees);
    if !missing.is_empty() {
        return Ok(json!({ "need_trees": missing.iter().map(ObjectId::hex).collect::<Vec<_>>() }));
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
            .map_err(|_| bad("read_set must be a list of paths"))?;
    if read_set.len() > 1000
        || read_set
            .iter()
            .any(|p| p.is_empty() || p.starts_with('/') || p.contains(".."))
    {
        return Err(bad(
            "read_set entries must be relative paths or dir/ prefixes",
        ));
    }

    let mut blobs: Vec<(ObjectId, &[u8])> = Vec::new();
    let mut path_changes = Vec::new();
    let mut touches = Vec::new();
    for change in &changes {
        let old = existing(root, &change.path, &trees).filter(|e| !e.mode.is_tree());
        let new = change
            .target
            .as_ref()
            .map(|(m, data)| (*m, hash_object(ObjectKind::Blob, data)));
        if matches!((&old, new), (Some(o), Some((m, id))) if o.mode == m && o.id == id) {
            continue;
        }
        if let Some((_, data)) = &change.target
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
    if touches.is_empty() {
        return Err(Error::new(
            "NO_CHANGES",
            "Every change matches the parent commit",
        ));
    }
    let rewrite = rewrite_tree(root, &path_changes, &trees)?;
    let parents: Vec<ObjectId> = parent.iter().map(|p| p.id).collect();
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
    let pack = write_pack(&objects.iter().map(|(_, k, d)| (*k, *d)).collect::<Vec<_>>())?;
    let hidden = hidden_ref(&id);
    let generation = parent.as_ref().map_or(1, |p| p.generation + 1);
    let prepared = json!({
        "tree": rewrite.root, "parents": parents, "generation": generation,
        "base_version": base_version, "touches": touches, "read_set": read_set, "message": message,
    });
    db.query(
        "INSERT INTO prepared_commits(commit_id,principal,payload,expires_at) VALUES(?,?,?,?) \
         ON CONFLICT(commit_id) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at WHERE principal=excluded.principal",
        &[json!(id.hex()), json!(principal), json!(prepared.to_string()), json!(now + PREPARED_TTL_MS)],
    )?;
    db.query(
        "DELETE FROM prepared_commits WHERE expires_at<?",
        &[json!(now)],
    )?;
    Ok(json!({
        "commit": id, "tree": rewrite.root, "parents": parents, "touches": touches,
        "hidden_ref": hidden,
        "push_b64": STANDARD.encode(receive_pack_request(&hidden, None, id, &pack)?),
        // Structured copies for the adapter's write-through object cache (tier 2), so it
        // never parses Git formats itself.
        "objects": objects.iter().map(|(oid, kind, data)| cache_entry(*oid, *kind, data)).collect::<Result<Vec<_>>>()?,
    }))
}
