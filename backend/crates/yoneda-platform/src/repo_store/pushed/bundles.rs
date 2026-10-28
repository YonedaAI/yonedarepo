//! Where a large push's objects live in the object store: the adapter writes each batch of
//! verified objects as one bundle (a run of frames: kind, id, length, content) and indexes
//! every object here, after the bundle is durable and before any commit naming the object
//! is recorded; reads look objects up by id. R2 serves a few operations at a time per
//! request, so one object per R2 key made a 12,000-file push or checkout take minutes.
//! Only the platform's own adapter writes or reads this index.
use super::super::auth::Actor;
use crate::storage::{SqlStore, bad, string};
use serde_json::{Value, json};
use yoneda_core::{Error, Result, git_object::ObjectId};

/// Objects one index call records, and ids one lookup resolves.
pub const INDEX_OBJECTS: usize = 5_000;
pub const LOCATE_IDS: usize = 2_000;
/// Durable Object SQL binds at most 100 parameters per statement.
const INSERT_ROWS: usize = 20;
const SELECT_IDS: usize = 100;

/// `repo_bundle_index` (`bundle`, `objects: [{id, kind, at, size}]`) and
/// `repo_bundle_locate` (`ids`, answering `located: [{id, bundle, at, size, kind}]`; the
/// adapter asks only where a repository is known to hold bundles, see `staged`).
pub fn op<S: SqlStore>(db: &S, c: &Value, op: &str, actor: &Actor) -> Result<Value> {
    if !actor.can("system") {
        return Err(Error::new(
            "FORBIDDEN",
            "Only the platform indexes stored objects",
        ));
    }
    match op {
        "repo_bundle_index" => index(db, c),
        _ => locate(db, c),
    }
}

fn index<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let bundle = string(c, "bundle")?;
    if bundle.len() != 64
        || !bundle
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(bad("bundle must be a lowercase SHA-256 hex digest"));
    }
    let objects = c["objects"]
        .as_array()
        .filter(|list| !list.is_empty() && list.len() <= INDEX_OBJECTS)
        .ok_or_else(|| bad(&format!("objects must list 1-{INDEX_OBJECTS} objects")))?;
    let mut rows = Vec::with_capacity(objects.len());
    for object in objects {
        let id = ObjectId::parse(object["id"].as_str().unwrap_or_default())?;
        let kind = match object["kind"].as_str() {
            Some(kind @ ("commit" | "tree" | "blob")) => kind,
            _ => return Err(bad("Object kind must be commit, tree or blob")),
        };
        let place = |key: &str| {
            object[key]
                .as_u64()
                .filter(|n| *n <= u32::MAX as u64)
                .ok_or_else(|| bad(&format!("{key} must be an offset within a bundle")))
        };
        rows.push([
            json!(id.hex()),
            json!(bundle),
            json!(place("at")?),
            json!(place("size")?),
            json!(kind),
        ]);
    }
    // The first location of an object wins: every copy holds the same bytes.
    for chunk in rows.chunks(INSERT_ROWS) {
        let values = vec!["(?,?,?,?,?)"; chunk.len()].join(",");
        db.query(
            &format!("INSERT INTO bundled_objects(id,bundle,at,size,kind) VALUES{values} ON CONFLICT DO NOTHING"),
            &chunk.iter().flatten().cloned().collect::<Vec<_>>(),
        )?;
    }
    Ok(json!({ "indexed": rows.len() }))
}

fn locate<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let ids = c["ids"]
        .as_array()
        .filter(|list| list.len() <= LOCATE_IDS)
        .ok_or_else(|| bad(&format!("ids must list at most {LOCATE_IDS} object ids")))?;
    Ok(json!({ "located": located(db, ids.iter())? }))
}

/// `repo_staged_objects`; with `locate: true`, also where bundles hold the ids it did not
/// find staged (`located`), so a read that missed R2 asks the authority once for both and a
/// repository without bundles costs nothing more.
pub fn staged<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let mut found = super::super::staging::read(db, c)?;
    if c["locate"] != true || c.get("commit").is_some_and(|v| !v.is_null()) {
        return Ok(found);
    }
    let held: Vec<Value> = found["objects"]
        .as_array()
        .map(|objects| objects.iter().map(|o| o["id"].clone()).collect())
        .unwrap_or_default();
    let ids = c["ids"].as_array().map(Vec::as_slice).unwrap_or_default();
    found["located"] = json!(located(db, ids.iter().filter(|id| !held.contains(id)))?);
    Ok(found)
}

/// Whether any object of this repository is in a bundle (rows outlive no repository).
pub fn any<S: SqlStore>(db: &S) -> Result<bool> {
    Ok(!db
        .query("SELECT 1 FROM bundled_objects LIMIT 1", &[])?
        .is_empty())
}

fn located<'a, S: SqlStore>(db: &S, ids: impl Iterator<Item = &'a Value>) -> Result<Vec<Value>> {
    let ids = ids
        .map(|v| ObjectId::parse(v.as_str().unwrap_or_default()).map(|id| json!(id.hex())))
        .collect::<Result<Vec<_>>>()?;
    let mut located = Vec::new();
    for chunk in ids.chunks(SELECT_IDS) {
        let marks = vec!["?"; chunk.len()].join(",");
        located.extend(db.query(
            &format!("SELECT id,bundle,at,size,kind FROM bundled_objects WHERE id IN ({marks})"),
            chunk,
        )?);
    }
    Ok(located)
}
