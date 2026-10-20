//! Projecting changeset versions to Git (stateless compute). Each version's commit is the
//! previous version's commit with the landed commit's changed paths applied (file modes
//! and blobs read from the landed commit's own tree), with parents [previous, landed],
//! the platform as author and the landing time as its timestamp. Nothing else enters the
//! commit, so the same versions always produce the same ids, wherever they are projected.
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

struct Item {
    version: u64,
    at: i64,
    landed: Parent,
    /// Changed paths with their new blob (`None`: deleted).
    paths: Vec<(String, Option<ObjectId>)>,
}

fn items(c: &Value) -> Result<Vec<Item>> {
    c["items"]
        .as_array()
        .ok_or_else(|| bad("Missing items"))?
        .iter()
        .map(|item| {
            let paths = item["paths"]
                .as_array()
                .ok_or_else(|| bad("Missing paths"))?
                .iter()
                .map(|p| {
                    let blob = match p.get("blob").filter(|b| !b.is_null()) {
                        Some(_) => Some(ObjectId::parse(&string(p, "blob")?)?),
                        None => None,
                    };
                    Ok((string(p, "path")?, blob))
                })
                .collect::<Result<_>>()?;
            Ok(Item {
                version: item["version"]
                    .as_u64()
                    .ok_or_else(|| bad("Missing version"))?,
                at: number(item, "at")?,
                landed: parent(&item["commit"])?,
                paths,
            })
        })
        .collect()
}

/// The landed commit's changes as they apply to the previous head: its blob and mode at
/// every path it wrote, or a deletion.
fn changes(item: &Item, trees: &Trees) -> Result<Vec<Change>> {
    item.paths
        .iter()
        .map(|(path, blob)| {
            let target = match blob {
                None => None,
                Some(blob) => {
                    let entry = existing(Some(item.landed.tree), path, trees)
                        .filter(|e| e.id == *blob && !e.mode.is_tree())
                        .ok_or_else(|| {
                            Error::new(
                                "INVALID_INPUT",
                                format!("{path} in {} is not blob {blob}", item.landed.id),
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
    let items = items(c)?;
    let mut trees = Trees(supplied_trees(c)?);
    // Every directory on a changed path, in the head and in each landed commit, up front.
    let all: Vec<&str> = items
        .iter()
        .flat_map(|i| i.paths.iter().map(|(p, _)| p.as_str()))
        .collect();
    let mut missing: BTreeSet<ObjectId> = frontier(Some(head.tree), &all, &trees);
    for item in &items {
        let paths: Vec<&str> = item.paths.iter().map(|(p, _)| p.as_str()).collect();
        missing.extend(frontier(Some(item.landed.tree), &paths, &trees));
    }
    if !missing.is_empty() {
        return Ok(json!({ "need_trees": missing.iter().map(ObjectId::hex).collect::<Vec<_>>() }));
    }
    let (mut projected, mut raw, mut cached) = (Vec::new(), Vec::new(), Vec::new());
    for item in &items {
        let changes = changes(item, &trees)?;
        let describe = json!({
            "message": format!("Land {} at version {}", item.landed.id, item.version),
            "author": { "name": AUTHOR.0, "email": AUTHOR.1 },
        });
        let built = build(
            &describe,
            Some(&head),
            std::slice::from_ref(&item.landed),
            &changes,
            &trees,
            item.at,
            &|_| Ok(()),
        )?;
        for (id, bytes) in &built.trees {
            trees.0.insert(*id, decode_tree(bytes)?);
        }
        let mut objects = Vec::new();
        for (id, kind, data) in &built.objects {
            objects.push(json!({ "id": id, "kind": kind.name() }));
            raw.push(json!({ "id": id, "kind": kind.name(), "data_b64": STANDARD.encode(data) }));
            cached.push(object_json(*id, *kind, data)?);
        }
        projected.push(json!({
            "version": item.version, "commit": built.id, "tree": built.root,
            "parents": built.parents, "generation": built.generation,
            "touches": built.touches, "message": built.message, "objects": objects,
        }));
        head = Parent {
            id: built.id,
            tree: built.root,
            generation: built.generation,
        };
    }
    Ok(json!({ "projected": projected, "raw": raw, "objects": cached }))
}
