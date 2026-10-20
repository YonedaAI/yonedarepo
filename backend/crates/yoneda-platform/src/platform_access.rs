//! Compute for symbol-level access: the symbols a commit's modifications touched (its
//! derived write set) and work plans over the reference graph at one revision. Every
//! blob is verified against its id; anything unparsed stays at path level.
use crate::platform_derived::verified_blob;
use crate::platform_graph::{FileSymbols, file_symbols, graph, touched};
use crate::platform_symbols::language;
use crate::repo_store::grants;
use crate::storage::{bad, string};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use yoneda_core::{
    Error, Result,
    git_object::ObjectId,
    txlog::{Access, WorkItem, plan},
};

/// Files parsed for one plan; larger repositories plan the rest at path level.
const MAX_GRAPH_FILES: usize = 400;
const MAX_GRAPH_BYTES: usize = 16 * 1024 * 1024;
const MAX_ITEMS: usize = 100;
const MAX_ENTRIES: usize = 5_000;
const MAX_CLOSURE_DEPTH: u64 = 3;

/// A supplied blob as text (`Some(None)`: not UTF-8); `None` when not supplied yet, in
/// which case it is added to `need`.
fn text(c: &Value, id: &ObjectId, need: &mut BTreeSet<ObjectId>) -> Result<Option<Option<String>>> {
    match verified_blob(c, id)? {
        Some(data) => Ok(Some(String::from_utf8(data).ok())),
        None => {
            need.insert(*id);
            Ok(None)
        }
    }
}

/// `{touches: [{path, symbols}]}` for each modified file whose change resolved to
/// symbols. Files left out (unsupported, unparsed, edits outside symbols) are whole.
pub fn symbol_touches(c: &Value) -> Result<Value> {
    let changes = c["changes"]
        .as_array()
        .ok_or_else(|| bad("changes must be a list"))?;
    let mut need = BTreeSet::new();
    let mut sides = Vec::new();
    for change in changes {
        let path = string(change, "path")?;
        let (Some(old), Some(new)) = (change["old"].as_str(), change["new"].as_str()) else {
            continue;
        };
        if language(&path).is_none() {
            continue;
        }
        let (old, new) = (ObjectId::parse(old)?, ObjectId::parse(new)?);
        let (old, new) = (text(c, &old, &mut need)?, text(c, &new, &mut need)?);
        if let (Some(Some(old)), Some(Some(new))) = (old, new) {
            sides.push((path, old, new));
        }
    }
    if !need.is_empty() {
        return Ok(json!({ "need_blobs": need }));
    }
    let touches: Vec<Value> = sides
        .iter()
        .filter_map(|(path, old, new)| {
            touched(path, old, new).map(|symbols| json!({ "path": path, "symbols": symbols }))
        })
        .collect();
    Ok(json!({ "touches": touches }))
}

fn items(c: &Value, grant: &grants::Grant) -> Result<Vec<WorkItem>> {
    let items: Vec<WorkItem> = serde_json::from_value(c["items"].clone())
        .map_err(|_| bad("items must be a list of {id, read_set, write_set}"))?;
    if items.is_empty() || items.len() > MAX_ITEMS {
        return Err(bad("Plan 1-100 work items"));
    }
    let mut ids = BTreeSet::new();
    let mut entries = 0;
    for item in &items {
        if item.id.trim().is_empty() || item.id.len() > 200 || !ids.insert(&item.id) {
            return Err(bad("Work item ids must be unique and 1-200 characters"));
        }
        for entry in item.read_set.iter().chain(&item.write_set) {
            entries += 1;
            let path = Access::parse(entry).path().to_owned();
            if path.is_empty() || path.starts_with('/') || path.contains("..") {
                return Err(bad(
                    "Entries must be relative paths, dir/ prefixes or path#symbol",
                ));
            }
            // Planning over hidden paths would reveal their symbols and references.
            grants::require(grant, &path)?;
        }
    }
    if entries > MAX_ENTRIES {
        return Err(bad("Plan at most 5000 read and write entries"));
    }
    Ok(items)
}

/// Plans work items at one revision. `files` lists the revision's files the caller may
/// see (`{path, id}`); the adapter supplies their blobs on request.
pub fn work_plan(c: &Value) -> Result<Value> {
    let grant = grants::parse(&c["grant"])?;
    let items = items(c, &grant)?;
    let depth = c["closure_depth"].as_u64().unwrap_or(1);
    if depth > MAX_CLOSURE_DEPTH {
        return Err(bad("closure_depth is 0 to 3"));
    }
    let listed: Vec<(String, ObjectId)> = c["files"]
        .as_array()
        .ok_or_else(|| bad("files must be a list"))?
        .iter()
        .filter_map(|f| Some((f["path"].as_str()?.to_owned(), f["id"].as_str()?.to_owned())))
        .filter(|(path, _)| language(path).is_some() && grants::allows(&grant, path))
        .map(|(path, id)| Ok((path, ObjectId::parse(&id)?)))
        .collect::<Result<_>>()?;
    let named: BTreeSet<String> = items
        .iter()
        .flat_map(|i| i.read_set.iter().chain(&i.write_set))
        .map(|e| Access::parse(e).path().to_owned())
        .collect();
    // Files the items name first, so a cap never drops what the plan is about.
    let mut chosen: Vec<&(String, ObjectId)> =
        listed.iter().filter(|(p, _)| named.contains(p)).collect();
    chosen.extend(listed.iter().filter(|(p, _)| !named.contains(p)));
    let complete = chosen.len() <= MAX_GRAPH_FILES;
    chosen.truncate(MAX_GRAPH_FILES);
    let mut need = BTreeSet::new();
    let mut sources = Vec::new();
    let mut bytes = 0usize;
    for (path, id) in chosen {
        if let Some(source) = text(c, id, &mut need)? {
            bytes += source.as_ref().map_or(0, String::len);
            if bytes > MAX_GRAPH_BYTES {
                return Err(Error::new("TOO_LARGE", "Plan sources exceed 16 MiB"));
            }
            sources.push((path.clone(), source));
        }
    }
    if !need.is_empty() {
        return Ok(json!({ "need_blobs": need }));
    }
    let mut parsed: Vec<FileSymbols> = Vec::new();
    let mut unparsed = Vec::new();
    for (path, source) in &sources {
        match source.as_deref().map(|s| file_symbols(path, s)) {
            Some(Ok(file)) => parsed.push(file),
            _ => unparsed.push(path.clone()),
        }
    }
    // Symbol entries on files without parsed symbols (unparsed, unsupported, missing or
    // beyond the cap) are planned at path level.
    let in_graph: BTreeSet<&str> = parsed.iter().map(|f| f.path.as_str()).collect();
    let coarse: BTreeSet<String> = named
        .iter()
        .filter(|p| !in_graph.contains(p.as_str()))
        .cloned()
        .collect();
    let symbol_graph = graph(&parsed, coarse);
    let edges: usize = symbol_graph.edges.iter().map(Vec::len).sum();
    let planned = plan(&items, &symbol_graph, depth as usize);
    let mut by_id: BTreeMap<&str, usize> = BTreeMap::new();
    for (k, item) in planned.items.iter().enumerate() {
        for member in &item.members {
            by_id.insert(member, k);
        }
    }
    Ok(json!({
        "closure_depth": depth,
        "items": planned.items, "stages": planned.stages, "cycles": planned.cycles,
        "item_of": by_id,
        "graph": {
            "files": parsed.len(), "symbols": symbol_graph.nodes.len(), "edges": edges,
            "complete": complete, "unparsed": unparsed, "coarse": symbol_graph.coarse,
        },
    }))
}
