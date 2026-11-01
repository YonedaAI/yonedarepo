//! Forking, step by step (see `forks`): the parent's refs and the commits they reach, a
//! page at a time, recorded by the new fork under their own ids, then its refs.
use super::rows::{self, Settings, corrupt, object_id};
use super::{land, reads};
use crate::storage::{SqlStore, bad, number, string};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use yoneda_core::{
    Error, Result,
    git_object::ObjectId,
    txlog::{PathTouch, TxKind},
};

/// Most commits a fork copies (everything the parent's refs reach).
const FORK_COMMITS: usize = 20_000;
/// Commits and changed paths per export page.
const PAGE_COMMITS: usize = 500;
const PAGE_TOUCHES: usize = 20_000;

/// `repo_fork_source`: the refs a fork copies, at the current version.
pub(super) fn source<S: SqlStore>(db: &S, settings: &Settings) -> Result<Value> {
    let version = rows::current_version(db)?;
    let refs = reads::refs_at(db, &json!({ "at": version }), version)?;
    Ok(json!({
        "version": version, "refs": refs, "name": settings.name,
        "object_store": settings.object_store,
    }))
}

/// `repo_fork_export {version, after?}`: the commits the refs at `version` reach, oldest
/// first (generation, then id), a page at a time after the cursor `after` ([generation,
/// id]); `next` is the cursor of the following page. Each carries its row, changed paths
/// and, when Artifacts does not hold it yet, the objects it introduced.
pub(super) fn export<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let version = number(c, "version")? as u64;
    if version > rows::current_version(db)? {
        return Err(bad("version is ahead of the log"));
    }
    let tips = reads::refs_at(db, &json!({ "at": version }), version)?;
    // One scan of the graph, then the walk in memory.
    let mut graph: HashMap<String, (u64, Vec<String>)> = HashMap::new();
    for row in db.query("SELECT id,parents,generation FROM commits", &[])? {
        let parents = serde_json::from_str(row["parents"].as_str().unwrap_or("[]"))
            .map_err(|_| corrupt("parents"))?;
        let id = row["id"].as_str().unwrap_or_default().to_owned();
        graph.insert(
            id,
            (row["generation"].as_u64().unwrap_or_default(), parents),
        );
    }
    let mut reached = HashSet::new();
    let mut stack: Vec<String> = tips.values().map(ObjectId::hex).collect();
    while let Some(id) = stack.pop() {
        // Parents beyond a truncated import are not recorded: the walk ends there.
        let Some((_, parents)) = graph.get(&id) else {
            continue;
        };
        if reached.insert(id) {
            stack.extend(parents.iter().cloned());
        }
        if reached.len() > FORK_COMMITS {
            return Err(Error::new(
                "TOO_LARGE",
                format!("A fork copies at most {FORK_COMMITS} commits"),
            ));
        }
    }
    let mut order: Vec<(u64, String)> = reached.into_iter().map(|id| (graph[&id].0, id)).collect();
    order.sort();
    let after: Option<(u64, String)> = match c.get("after").filter(|a| !a.is_null()) {
        Some(a) => Some(serde_json::from_value(a.clone()).map_err(|_| bad("Invalid cursor"))?),
        None => None,
    };
    let (mut commits, mut touches, mut next) = (Vec::new(), 0, Value::Null);
    let mut last = None;
    for key in order
        .into_iter()
        .filter(|k| after.as_ref().is_none_or(|a| k > a))
    {
        if commits.len() >= PAGE_COMMITS || touches >= PAGE_TOUCHES {
            next = json!(last);
            break;
        }
        commits.push(exported(db, &key.1, &mut touches)?);
        last = Some(key);
    }
    Ok(json!({ "commits": commits, "next": next }))
}

fn exported<S: SqlStore>(db: &S, id: &str, touches: &mut usize) -> Result<Value> {
    let row = db
        .query(
            "SELECT id,tree,parents,generation,principal,message,recorded_at FROM commits WHERE id=?",
            &[json!(id)],
        )?
        .into_iter()
        .next()
        .ok_or_else(|| corrupt("commit graph"))?;
    let paths = rows::touches(db, &ObjectId::parse(id)?)?;
    *touches += paths.len();
    let mut exported = row;
    exported["touches"] = json!(paths);
    Ok(exported)
}

fn no_refs_yet<S: SqlStore>(db: &S) -> Result<()> {
    if db.query("SELECT name FROM refs LIMIT 1", &[])?.is_empty() {
        Ok(())
    } else {
        Err(Error::new(
            "ALREADY_EXISTS",
            "A fork's history is copied before it has refs",
        ))
    }
}

/// `repo_fork_record {commits}`: one export page, recorded as it was in the parent (its
/// generation, author principal and message). A retried page is a no-op.
pub(super) fn record<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    no_refs_yet(db)?;
    let commits = c["commits"]
        .as_array()
        .filter(|list| list.len() <= PAGE_COMMITS)
        .ok_or_else(|| bad(&format!("commits must list at most {PAGE_COMMITS} commits")))?;
    let mut recorded = 0;
    for item in commits {
        let id = object_id(item, "id")?;
        if rows::commit_row(db, &id)?.is_some() {
            continue;
        }
        let parents: Vec<ObjectId> =
            serde_json::from_str(item["parents"].as_str().unwrap_or_default())
                .map_err(|_| bad("parents must be a JSON list of ids"))?;
        db.query(
            "INSERT INTO commits(id,tree,parents,generation,base_version,principal,message,read_set,recorded_at,origin,hidden_ref,artifacts_at) VALUES(?,?,?,?,0,?,?,'[]',?,'fork',0,?)",
            &[json!(id.hex()), json!(object_id(item, "tree")?.hex()), json!(json!(parents).to_string()),
              json!(number(item, "generation")?), json!(string(item, "principal")?),
              json!(item["message"].as_str().unwrap_or_default()), json!(number(item, "recorded_at")?),
              json!(number(item, "recorded_at")?)],
        )?;
        let touches: Vec<PathTouch> = serde_json::from_value(item["touches"].clone())
            .map_err(|e| bad(&format!("Invalid touches: {e}")))?;
        for touch in &touches {
            yoneda_core::validate_path(&touch.path)?;
            let t = serde_json::to_value(touch).map_err(|e| bad(&e.to_string()))?;
            db.query(
                "INSERT INTO commit_paths(commit_id,path,op,old_blob,new_blob,mode) VALUES(?,?,?,?,?,?)",
                &[json!(id.hex()), t["path"].clone(), t["op"].clone(), t["old_blob"].clone(), t["new_blob"].clone(), t["mode"].clone()],
            )?;
        }
        recorded += 1;
    }
    Ok(json!({ "recorded": recorded }))
}

/// `repo_fork_refs {refs}`: the fork's refs as copied, each logged as an import.
pub(super) fn refs<S: SqlStore>(db: &S, c: &Value, principal: &str) -> Result<Value> {
    no_refs_yet(db)?;
    let refs: BTreeMap<String, ObjectId> =
        serde_json::from_value(c["refs"].clone()).map_err(|_| bad("refs must map names to ids"))?;
    let mut version = rows::current_version(db)?;
    for (name, id) in &refs {
        if !(name.starts_with("refs/heads/") || rows::is_tag(name)) {
            return Err(bad("A fork copies branches and tags only"));
        }
        let commit = rows::recorded(db, id)?;
        let moved = land::append(db, c, TxKind::Import, name, None, &commit, principal)?;
        version = moved["version"].as_u64().unwrap_or(version);
        db.query(
            "INSERT INTO fork_origin(refname,commit_id) VALUES(?,?)",
            &[json!(name), json!(id.hex())],
        )?;
    }
    Ok(json!({ "refs": refs.len(), "version": version }))
}
