//! Projecting changesets to Git (stateless compute). Each step's commit is the previous
//! head with the step's changed paths applied (file modes and blobs read from the landed
//! commits' own trees): a landed batch has the previous head as its only parent, a lone
//! changeset also its landed commit. The platform is the author and the landing time the
//! timestamp; nothing else enters the commit, so the same steps always produce the same
//! ids, wherever they are projected.
use crate::platform_objects::{object_json, supplied_trees};
use crate::repo_store::prepare::build::{Parent, Trees, build, existing, frontier};
use crate::repo_store::prepare::changes::{Change, Content};
use crate::storage::{bad, number, string};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use yoneda_core::{
    Error, Result,
    git_object::{ObjectId, decode_tree},
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
    /// Changed paths: new blob (`None`: deleted) and the landed commit that wrote it.
    changes: Vec<(String, Option<ObjectId>, Parent)>,
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
                    Ok((string(ch, "path")?, blob, parent(&ch["source"])?))
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
        .map(|(path, blob, source)| {
            let target = match blob {
                None => None,
                Some(blob) => {
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
        })
        .collect()
}

pub fn project_changesets(c: &Value) -> Result<Value> {
    let mut head = parent(&c["head"])?;
    let steps = steps(c)?;
    let mut trees = Trees(supplied_trees(c)?);
    // Every directory on a changed path, in the head and in each landed commit, up front.
    let all: Vec<&str> = steps
        .iter()
        .flat_map(|s| s.changes.iter().map(|(p, _, _)| p.as_str()))
        .collect();
    let mut missing: BTreeSet<ObjectId> = frontier(Some(head.tree), &all, &trees);
    for (path, _, source) in steps.iter().flat_map(|s| &s.changes) {
        missing.extend(frontier(Some(source.tree), &[path.as_str()], &trees));
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
