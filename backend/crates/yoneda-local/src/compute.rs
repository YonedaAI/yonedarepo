//! The engine's stateless compute (`platform_compute`) and the prepare loop, answered from
//! the store: they ask for trees and files by id, as they ask the Worker's object tiers.
use crate::layout::local_error;
use crate::store::Store;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Map, Value, json};
use yoneda_core::{
    Result,
    git_object::{ObjectId, decode_tree},
};

/// Rounds a compute or prepare loop may take (one per directory depth, then files).
const ROUNDS: usize = 256;

fn ids(list: &Value) -> Result<Vec<ObjectId>> {
    list.as_array()
        .into_iter()
        .flatten()
        .map(|id| ObjectId::parse(id.as_str().unwrap_or_default()))
        .collect()
}

/// `{id: [{name, type, id}]}` for the trees `need` names.
fn listings(store: &Store, need: &Value, into: &mut Map<String, Value>) -> Result<()> {
    let wanted = ids(need)?;
    let found = store.read(&wanted)?;
    for id in wanted {
        let (_, data) = found
            .get(&id)
            .ok_or_else(|| local_error(format!("Tree {id} is not in the store")))?;
        let entries: Vec<Value> = decode_tree(data)?
            .iter()
            .map(|e| json!({ "name": e.name, "id": e.id, "type": e.mode.as_str() }))
            .collect();
        into.insert(id.hex(), json!(entries));
    }
    Ok(())
}

/// `{id: base64}` for the files `need` names.
fn contents(store: &Store, need: &Value, into: &mut Map<String, Value>) -> Result<()> {
    let wanted = ids(need)?;
    let found = store.read(&wanted)?;
    for id in wanted {
        let (_, data) = found
            .get(&id)
            .ok_or_else(|| local_error(format!("File {id} is not in the store")))?;
        into.insert(id.hex(), json!(STANDARD.encode(data)));
    }
    Ok(())
}

/// Repeats `step` with the trees and files it asks for until it answers something else.
pub fn supplied(
    store: &Store,
    mut step: impl FnMut(&Value, &Value) -> Result<Value>,
) -> Result<Value> {
    let (mut trees, mut blobs) = (Map::new(), Map::new());
    for _ in 0..ROUNDS {
        let answer = step(&json!(trees), &json!(blobs))?;
        if let Some(need) = answer.get("need_trees").filter(|n| n.is_array()) {
            listings(store, need, &mut trees)?;
        } else if let Some(need) = answer.get("need_blobs").filter(|n| n.is_array()) {
            contents(store, need, &mut blobs)?;
        } else {
            return Ok(answer);
        }
    }
    Err(local_error("Directories are nested too deeply"))
}

/// Runs compute `command` (e.g. `merge_trees`) to its answer.
pub fn run(store: &Store, command: Value) -> Result<Value> {
    supplied(store, |trees, blobs| {
        let mut asked = command.clone();
        asked["trees"] = trees.clone();
        asked["blobs"] = blobs.clone();
        yoneda_platform::platform_compute(asked)
    })
}
