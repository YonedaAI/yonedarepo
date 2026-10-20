//! Projecting changesets to Git (stateless compute). Each step's commit is the previous
//! head with the step's changed paths applied (file modes and blobs read from the landed
//! commits' own trees): a landed batch has the previous head as its only parent, a lone
//! changeset also its landed commit. The platform is the author and the landing time the
//! timestamp; nothing else enters the commit, so the same steps always produce the same
//! ids, wherever they are projected.
use crate::platform_objects::{mode as file_mode, object_json, supplied_trees};
use crate::repo_store::prepare::build::{Parent, Trees, build, existing, frontier};
use crate::repo_store::prepare::changes::{Change, Content};
use crate::storage::{bad, number, string};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use yoneda_core::{
    Error, Result,
    git_object::{FileMode, ObjectId, decode_tree},
};

const AUTHOR: (&str, &str) = ("YonedaRepo", "commits@yonedarepo.invalid");

fn parent(v: &Value) -> Result<Parent> {
    Ok(Parent {
        id: ObjectId::parse(&string(v, "id")?)?,
        tree: ObjectId::parse(&string(v, "tree")?)?,
        generation: v["generation"]
            .as_u64()
            .ok_or_else(|| bad("Missing generation"))?,
    })
}

/// One projected commit: a landed batch, or a changeset landed on its own (`merge`).
struct Step {
    versions: Value,
    at: i64,
    message: String,
    merge: Option<Parent>,
    changes: Vec<Changed>,
}

/// A changed path: its new blob (`None`: deleted), the mode when the log recorded it, and
/// the landed commit that wrote it (whose tree gives the mode otherwise).
struct Changed {
    path: String,
    blob: Option<ObjectId>,
    mode: Option<FileMode>,
    source: Parent,
}

fn steps(c: &Value) -> Result<Vec<Step>> {
    c["items"]
        .as_array()
        .ok_or_else(|| bad("Missing steps"))?
        .iter()
        .map(|step| {
            let changes = step["changes"]
                .as_array()
                .ok_or_else(|| bad("Missing changes"))?
                .iter()
                .map(|ch| {
                    let blob = match ch.get("blob").filter(|b| !b.is_null()) {
                        Some(_) => Some(ObjectId::parse(&string(ch, "blob")?)?),
                        None => None,
                    };
                    let mode = match ch["mode"].as_str() {
                        Some(name) => Some(file_mode(name)?),
                        None => None,
                    };
                    Ok(Changed {
                        path: string(ch, "path")?,
                        blob,
                        mode,
                        source: parent(&ch["source"])?,
                    })
                })
                .collect::<Result<_>>()?;
            Ok(Step {
                versions: step["versions"].clone(),
                at: number(step, "at")?,
                message: step["message"]
                    .as_str()
                    .ok_or_else(|| bad("Missing message"))?
                    .to_owned(),
                merge: step
                    .get("merge")
                    .filter(|m| !m.is_null())
                    .map(parent)
                    .transpose()?,
                changes,
            })
        })
        .collect()
}

/// A step's changes as they apply to the previous head: each landed commit's blob and
/// mode at every path it wrote, or a deletion.
fn changes(step: &Step, trees: &Trees) -> Result<Vec<Change>> {
    step.changes
        .iter()
        .map(
            |Changed {
                 path,
                 blob,
                 mode,
                 source,
             }| {
                let target = match (blob, mode) {
                    (None, _) => None,
                    (Some(blob), Some(mode)) => Some((*mode, Content::Known(*blob))),
                    (Some(blob), None) => {
                        let entry = existing(Some(source.tree), path, trees)
                            .filter(|e| e.id == *blob && !e.mode.is_tree())
                            .ok_or_else(|| {
                                Error::new(
                                    "INVALID_INPUT",
                                    format!("{path} in {} is not blob {blob}", source.id),
                                )
                            })?;
                        Some((entry.mode, Content::Known(*blob)))
                    }
                };
                Ok(Change {
                    path: path.clone(),
                    target,
                    expect: None,
                })
            },
        )
        .collect()
}

pub fn project_changesets(c: &Value) -> Result<Value> {
    let mut head = parent(&c["head"])?;
    let steps = steps(c)?;
    let mut trees = Trees(supplied_trees(c)?);
    // Every directory on a changed path, in the head and in each landed commit, up front.
    let all: Vec<&str> = steps
        .iter()
        .flat_map(|s| s.changes.iter().map(|c| c.path.as_str()))
        .collect();
    let mut missing: BTreeSet<ObjectId> = frontier(Some(head.tree), &all, &trees);
    // A landed commit's tree is read only for a mode the log did not record.
    for c in steps.iter().flat_map(|s| &s.changes) {
        if c.blob.is_some() && c.mode.is_none() {
            missing.extend(frontier(Some(c.source.tree), &[c.path.as_str()], &trees));
        }
    }
    if !missing.is_empty() {
        return Ok(json!({ "need_trees": missing.iter().map(ObjectId::hex).collect::<Vec<_>>() }));
    }
    let (mut projected, mut cached) = (Vec::new(), Vec::new());
    for step in &steps {
        let changes = changes(step, &trees)?;
        let describe = json!({
            "message": step.message, "author": { "name": AUTHOR.0, "email": AUTHOR.1 },
        });
        let built = build(
            &describe,
            Some(&head),
            step.merge.as_slice(),
            &changes,
            &trees,
            step.at,
            &|_| Ok(()),
        )?;
        for (id, bytes) in &built.trees {
            trees.0.insert(*id, decode_tree(bytes)?);
        }
        let mut raw = Vec::new();
        for (id, kind, data) in &built.objects {
            raw.push(json!({ "id": id, "kind": kind.name(), "data_b64": STANDARD.encode(data) }));
            cached.push(object_json(*id, *kind, data)?);
        }
        projected.push(json!({
            "versions": step.versions, "commit": built.id, "tree": built.root,
            "parents": built.parents, "generation": built.generation,
            "touches": built.touches, "message": built.message, "raw": raw,
        }));
        head = Parent {
            id: built.id,
            tree: built.root,
            generation: built.generation,
        };
    }
    Ok(json!({ "projected": projected, "objects": cached }))
}
