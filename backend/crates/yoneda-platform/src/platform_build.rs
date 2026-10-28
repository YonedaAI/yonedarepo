//! Stateless commit creation (Scion: commits touch no refs and need no authority): the
//! adapter supplies the parent and merged parents it read, the trees along the changed
//! paths and the blob ids it vouches for; the commit is built exactly as the authority's
//! prepare builds it, and recorded wherever its writer's commits live.
use crate::platform_objects::supplied_trees;
use crate::repo_store::prepare::build::{Parent, Trees, build, frontier, objects_json};
use crate::repo_store::prepare::changes::{changes, unread_symlinks};
use crate::storage::{bad, number, string};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use yoneda_core::{Error, Result, git_object::ObjectId};

fn parent(v: &Value) -> Result<Parent> {
    Ok(Parent {
        id: ObjectId::parse(&string(v, "id")?)?,
        tree: ObjectId::parse(&string(v, "tree")?)?,
        generation: v["generation"]
            .as_u64()
            .ok_or_else(|| bad("Parent generation is missing"))?,
    })
}

pub fn build_commit(c: &Value) -> Result<Value> {
    let first = c
        .get("parent")
        .filter(|p| !p.is_null())
        .map(parent)
        .transpose()?;
    let merges = c["merge_parents"]
        .as_array()
        .into_iter()
        .flatten()
        .map(parent)
        .collect::<Result<Vec<_>>>()?;
    let changes = changes(c, &[])?;
    let need_blobs = unread_symlinks(&changes, c)?;
    if !need_blobs.is_empty() {
        return Ok(json!({ "need_blobs": need_blobs }));
    }
    let trees = Trees(supplied_trees(c)?);
    let paths: Vec<&str> = changes.iter().map(|ch| ch.path.as_str()).collect();
    let missing = frontier(first.as_ref().map(|p| p.tree), &paths, &trees);
    if !missing.is_empty() {
        return Ok(json!({ "need_trees": missing.iter().map(ObjectId::hex).collect::<Vec<_>>() }));
    }
    let known: Vec<ObjectId> = c["known_blobs"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|id| ObjectId::parse(id.as_str().unwrap_or_default()))
        .collect::<Result<_>>()?;
    let built = build(
        c,
        first.as_ref(),
        &merges,
        &changes,
        &trees,
        number(c, "now")?,
        &|id| {
            if known.contains(id) {
                Ok(())
            } else {
                Err(Error::new(
                    "NOT_FOUND",
                    format!("Blob {id} is not vouched for"),
                ))
            }
        },
    )?;
    Ok(json!({
        "commit": built.id, "tree": built.root, "parents": built.parents,
        "generation": built.generation, "touches": built.touches, "read_set": built.read_set,
        "objects": objects_json(&built)?,
        "raw": built.objects.iter().map(|(id, kind, data)| json!({ "id": id, "kind": kind.name(), "data_b64": STANDARD.encode(data) })).collect::<Vec<_>>(),
    }))
}
