//! Recording a filled history's commits: the head, then batches below it.
use super::{HistoryFill, MAIN, filling};
use crate::repo_store::history_import::IMPORT_PRINCIPAL;
use crate::repo_store::rows::{self, object_id};
use crate::storage::{SqlStore, bad, number};
use serde_json::{Value, json};
use yoneda_core::{Error, Result, git_object::ObjectId, txlog::PathTouch};

/// Commits one batch, so one transaction, records at most.
const BATCH_COMMITS: usize = 250;
/// A bound parameter at most this long: a Durable Object's SQLite takes 2 MB.
const PARAMETER_BYTES: usize = 1024 * 1024;

/// One commit of a batch, parsed and checked as `repo_record_imported` checks its own.
pub(crate) struct Imported {
    id: ObjectId,
    tree: ObjectId,
    parents: Vec<ObjectId>,
    generation: u64,
    message: String,
    touches: Vec<PathTouch>,
}

impl Imported {
    pub(crate) fn parse(item: &Value) -> Result<Self> {
        let parents: Vec<ObjectId> = item["parents"]
            .as_array()
            .ok_or_else(|| bad("parents must be a list"))?
            .iter()
            .map(|p| ObjectId::parse(p.as_str().unwrap_or_default()))
            .collect::<Result<_>>()?;
        let touches: Vec<PathTouch> = serde_json::from_value(item["touches"].clone())
            .map_err(|e| bad(&format!("Invalid touches: {e}")))?;
        if touches.len() > 100_000 {
            return Err(bad("Too many changed paths in one imported commit"));
        }
        for touch in &touches {
            yoneda_core::validate_path(&touch.path)?;
        }
        let generation = number(item, "generation")?;
        if generation < 1 || (parents.is_empty() && generation != 1) {
            return Err(bad("A commit's generation counts its first parents"));
        }
        Ok(Self {
            id: object_id(item, "commit")?,
            tree: object_id(item, "tree")?,
            parents,
            generation: generation as u64,
            message: item["message"]
                .as_str()
                .unwrap_or_default()
                .chars()
                .take(16_384)
                .collect(),
            touches,
        })
    }
}

/// Where generation 0 would sit: each commit's rowid and time follow from its generation, so
/// that what orders commits (search's newest first) reads them as if recorded oldest first.
/// Changed paths keep their arrival order: `repo_storage` estimates rows from the top rowid,
/// and a path search past its candidate limit reads the last arrived, here the oldest.
#[derive(Clone, Copy)]
struct Origin {
    rowid: i64,
    recorded_at: i64,
}

fn write<S: SqlStore>(db: &S, commits: &[Imported], origin: Origin) -> Result<()> {
    let mut rows = Vec::with_capacity(commits.len());
    let mut paths = Vec::new();
    for commit in commits {
        let id = commit.id.hex();
        rows.push(json!([
            origin.rowid + commit.generation as i64,
            id,
            commit.tree.hex(),
            json!(commit.parents).to_string(),
            commit.generation,
            commit.message,
            origin.recorded_at + commit.generation as i64,
        ]));
        for touch in &commit.touches {
            let t = serde_json::to_value(touch).map_err(|e| bad(&e.to_string()))?;
            paths.push(json!([
                id,
                t["path"],
                t["op"],
                t["old_blob"],
                t["new_blob"],
                t["mode"],
            ]));
        }
    }
    for part in chunks(&rows) {
        db.query(
            // Imported history was read from Artifacts, which holds it.
            "INSERT INTO commits(rowid,id,tree,parents,generation,base_version,principal,message,read_set,recorded_at,origin,artifacts_at) \
             SELECT value->>0,value->>1,value->>2,value->>3,value->>4,0,?,value->>5,'[]',value->>6,'import',value->>6 \
             FROM json_each(?)",
            &[json!(IMPORT_PRINCIPAL), json!(part)],
        )?;
    }
    for part in chunks(&paths) {
        db.query(
            "INSERT INTO commit_paths(commit_id,path,op,old_blob,new_blob,mode) \
             SELECT value->>0,value->>1,value->>2,value->>3,value->>4,value->>5 \
             FROM json_each(?)",
            &[json!(part)],
        )?;
    }
    Ok(())
}

/// `rows` as JSON lists of at most `PARAMETER_BYTES` (a longer single row goes alone).
pub(crate) fn chunks(rows: &[Value]) -> Vec<String> {
    let mut out = Vec::new();
    let mut part = String::from("[");
    for row in rows {
        let text = row.to_string();
        if part.len() > 1 && part.len() + text.len() + 2 > PARAMETER_BYTES {
            part.push(']');
            out.push(std::mem::replace(&mut part, String::from("[")));
        }
        if part.len() > 1 {
            part.push(',');
        }
        part.push_str(&text);
    }
    if part.len() > 1 {
        part.push(']');
        out.push(part);
    }
    out
}

/// `repo_record_imported` with a `generation`: the head of a history that follows it. Its
/// rowid leaves room below it for every ancestor.
pub(crate) fn record_head<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let head = Imported::parse(c)?;
    let top = db.query("SELECT COALESCE(MAX(rowid),0) AS top FROM commits", &[])?;
    let origin = Origin {
        rowid: top
            .first()
            .and_then(|row| row["top"].as_i64())
            .unwrap_or_default(),
        recorded_at: number(c, "now")? - head.generation as i64,
    };
    write(db, std::slice::from_ref(&head), origin)?;
    Ok(json!({ "commit": head.id, "recorded": true, "generation": head.generation }))
}

/// `repo_record_imported_batch {commits}`: the next commits below the chain, newest first,
/// each `{commit, tree, parents, message, generation, touches}`. Those already recorded
/// are skipped, so a retried or overlapping batch is harmless, and any other commit is
/// refused: only the first parent of the oldest commit recorded can come next. After the
/// last, a repeat changes nothing.
pub(crate) fn record_batch<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let items = c["commits"]
        .as_array()
        .filter(|list| list.len() <= BATCH_COMMITS)
        .ok_or_else(|| {
            bad(&format!(
                "commits must list at most {BATCH_COMMITS} commits"
            ))
        })?;
    let Some(fill): Option<HistoryFill> = filling(db)? else {
        rows::projected_ref(db, MAIN)?
            .ok_or_else(|| Error::new("NOT_FOUND", "The imported head has not landed"))?;
        return Ok(json!({ "recorded": 0, "history_import": null }));
    };
    let oldest = fill.oldest();
    let bottom = db.query(
        "SELECT c.rowid AS row,c.parents,c.recorded_at FROM ref_chain r JOIN commits c ON c.id=r.commit_id \
         WHERE r.ref=? AND r.depth=?",
        &[json!(MAIN), json!(oldest)],
    )?;
    let bottom = bottom.first().ok_or_else(|| rows::corrupt("ref_chain"))?;
    let parents: Vec<ObjectId> = serde_json::from_str(bottom["parents"].as_str().unwrap_or("[]"))
        .map_err(|_| rows::corrupt("parents"))?;
    let origin = Origin {
        rowid: bottom["row"].as_i64().unwrap_or_default() - oldest as i64,
        recorded_at: bottom["recorded_at"].as_i64().unwrap_or_default() - oldest as i64,
    };
    let mut next = parents.first().copied();
    let mut generation = oldest - 1;
    let mut commits = Vec::with_capacity(items.len());
    for item in items {
        let commit = Imported::parse(item)?;
        if commit.generation > generation {
            continue;
        }
        if commit.generation != generation || Some(commit.id) != next {
            return Err(Error::new(
                "CONFLICT",
                format!(
                    "Commit {} is not the next of this history (generation {generation})",
                    commit.id
                ),
            ));
        }
        next = commit.parents.first().copied();
        generation -= 1;
        commits.push(commit);
    }
    write(db, &commits, origin)?;
    let chain: Vec<Value> = commits
        .iter()
        .map(|commit| json!([commit.generation, commit.id.hex()]))
        .collect();
    for part in chunks(&chain) {
        db.query(
            "INSERT INTO ref_chain(ref,depth,commit_id) \
             SELECT ?,value->>0,value->>1 FROM json_each(?)",
            &[json!(MAIN), json!(part)],
        )?;
    }
    Ok(json!({ "recorded": commits.len(), "history_import": filling(db)? }))
}
