//! Typed access to platform tables.
pub use super::checkpoints::{checkpoint_at_or_before, maybe_checkpoint};
pub use super::policy::{Policy, Runner, check_name};
use crate::storage::{SqlStore, bad, string};
use serde_json::{Value, json};
use yoneda_core::{
    Error, Result,
    git_object::{CommitGraph, ObjectId},
    txlog::{PathTouch, TxEntry},
};

pub struct Settings {
    pub name: String,
    pub workspace: String,
    pub owner: String,
    pub object_store: String,
    pub policy: Policy,
    pub policy_digest: String,
}

pub struct CommitRow {
    pub id: ObjectId,
    pub tree: ObjectId,
    pub parents: Vec<ObjectId>,
    pub generation: u64,
    pub base_version: u64,
    pub principal: String,
    pub message: String,
    pub read_set: Vec<String>,
}

pub fn init<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let session = c.get("_session").filter(|s| s.is_object()).ok_or_else(|| {
        Error::new(
            "FORBIDDEN",
            "Only a workspace session can create a repository",
        )
    })?;
    let principal = string(session, "principal")?;
    let workspace = string(session, "workspace")?;
    if !db.query("SELECT id FROM repo_settings", &[])?.is_empty() {
        return Err(Error::new(
            "ALREADY_EXISTS",
            "Repository is already initialized",
        ));
    }
    let object_store = string(c, "object_store")?;
    let (_, policy_json, digest) = Policy::parse(&c["policy"])?;
    let name = string(c, "name")?;
    let valid = name.len() <= 100
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    if !valid || name.starts_with('.') {
        return Err(bad(
            "Repository names are 1-100 characters of [A-Za-z0-9._-]",
        ));
    }
    db.query(
        "INSERT INTO repo_settings(id,name,workspace,owner,object_store,policy,policy_digest,created_at) VALUES('repository',?,?,?,?,?,?,?)",
        &[json!(name), json!(workspace), json!(principal), json!(object_store), json!(policy_json.to_string()), json!(digest), c["now"].clone()],
    )?;
    Ok(json!({ "initialized": true, "policy_digest": digest }))
}

pub fn settings<S: SqlStore>(db: &S) -> Result<Settings> {
    let row = db
        .query("SELECT * FROM repo_settings WHERE id='repository'", &[])?
        .into_iter()
        .next()
        .ok_or_else(|| Error::new("NOT_FOUND", "Repository is not initialized"))?;
    let text = |key: &str| {
        row[key]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| corrupt(key))
    };
    Ok(Settings {
        name: text("name")?,
        workspace: text("workspace")?,
        owner: text("owner")?,
        object_store: text("object_store")?,
        policy: serde_json::from_str(&text("policy")?).map_err(|_| corrupt("policy"))?,
        policy_digest: text("policy_digest")?,
    })
}

pub fn corrupt(what: &str) -> Error {
    Error::new("DATABASE", format!("Corrupt repository {what}"))
}

pub fn object_id(v: &Value, key: &str) -> Result<ObjectId> {
    ObjectId::parse(&string(v, key)?)
}

fn ids(text: &str) -> Result<Vec<ObjectId>> {
    let raw: Vec<String> = serde_json::from_str(text).map_err(|_| corrupt("parents"))?;
    raw.iter().map(|id| ObjectId::parse(id)).collect()
}

pub fn commit_row<S: SqlStore>(db: &S, id: &ObjectId) -> Result<Option<CommitRow>> {
    let Some(row) = db
        .query("SELECT * FROM commits WHERE id=?", &[json!(id.hex())])?
        .into_iter()
        .next()
    else {
        return Ok(None);
    };
    let text = |key: &str| row[key].as_str().ok_or_else(|| corrupt(key));
    let int = |key: &str| row[key].as_u64().ok_or_else(|| corrupt(key));
    Ok(Some(CommitRow {
        id: *id,
        tree: ObjectId::parse(text("tree")?)?,
        parents: ids(text("parents")?)?,
        generation: int("generation")?,
        base_version: int("base_version")?,
        principal: text("principal")?.to_owned(),
        message: text("message")?.to_owned(),
        read_set: serde_json::from_str(text("read_set")?).map_err(|_| corrupt("read set"))?,
    }))
}

pub fn recorded<S: SqlStore>(db: &S, id: &ObjectId) -> Result<CommitRow> {
    commit_row(db, id)?
        .ok_or_else(|| Error::new("NOT_FOUND", format!("Commit {id} is not recorded")))
}

pub fn touches<S: SqlStore>(db: &S, id: &ObjectId) -> Result<Vec<PathTouch>> {
    db.query(
        "SELECT path,op,old_blob,new_blob FROM commit_paths WHERE commit_id=? ORDER BY path",
        &[json!(id.hex())],
    )?
    .into_iter()
    .map(|row| serde_json::from_value(row).map_err(|_| corrupt("path touch")))
    .collect()
}

pub fn current_version<S: SqlStore>(db: &S) -> Result<u64> {
    Ok(
        db.query("SELECT COALESCE(MAX(version),0) AS v FROM txlog", &[])?[0]["v"]
            .as_u64()
            .unwrap_or_default(),
    )
}

/// A branch head at the latest log version. Fails closed while landed changesets on it
/// are not projected to Git yet (the adapter projects them and retries).
pub fn ref_value<S: SqlStore>(db: &S, name: &str) -> Result<Option<ObjectId>> {
    if super::changesets::unprojected(db, name)? {
        return Err(projection_pending(name));
    }
    projected_ref(db, name)
}

pub fn projection_pending(name: &str) -> Error {
    Error::new(
        "PROJECTION_PENDING",
        format!("{name} has landed changesets not yet projected to Git"),
    )
}

/// The ref's last projected Git commit (behind any unprojected changesets).
pub fn projected_ref<S: SqlStore>(db: &S, name: &str) -> Result<Option<ObjectId>> {
    db.query("SELECT commit_id FROM refs WHERE name=?", &[json!(name)])?
        .first()
        .map(|row| ObjectId::parse(row["commit_id"].as_str().unwrap_or_default()))
        .transpose()
}

/// Log entries with `after < version <= until`, optionally for one ref, in order.
pub fn entries<S: SqlStore>(
    db: &S,
    after: u64,
    until: u64,
    refname: Option<&str>,
) -> Result<Vec<TxEntry>> {
    let rows = match refname {
        Some(name) => db.query(
            "SELECT entry FROM txlog WHERE version>? AND version<=? AND refname=? ORDER BY version",
            &[json!(after), json!(until), json!(name)],
        )?,
        None => db.query(
            "SELECT entry FROM txlog WHERE version>? AND version<=? ORDER BY version",
            &[json!(after), json!(until)],
        )?,
    };
    rows.iter()
        .map(|row| {
            serde_json::from_str(row["entry"].as_str().unwrap_or_default())
                .map_err(|_| corrupt("log entry"))
        })
        .collect()
}

/// Protected refs (Scion: refs only for main and releases) move only by landing an
/// approved, checked commit (or the human break-glass path), never by a working-branch
/// compare-and-swap; they are also the refs projected to the Git object store.
pub fn protected(refname: &str) -> bool {
    refname == "refs/heads/main"
        || refname == "refs/heads/release"
        || refname.starts_with("refs/heads/release/")
}

/// Accepts `main` or `refs/heads/main`; only branch refs are writable through the API.
pub fn branch_ref(c: &Value) -> Result<String> {
    let name = string(c, "ref")?;
    let full = if name.starts_with("refs/") {
        name
    } else {
        format!("refs/heads/{name}")
    };
    let branch = full.strip_prefix("refs/heads/").unwrap_or_default();
    if branch.is_empty()
        || branch.len() > 200
        || branch
            .split('/')
            .any(|p| p.is_empty() || p.starts_with('.') || p.ends_with(".lock"))
        || branch.contains(|ch: char| ch.is_ascii_control() || " ~^:?*[\\".contains(ch))
        || branch.contains("..")
        || branch.contains("@{")
    {
        return Err(bad("Invalid branch name"));
    }
    Ok(full)
}

/// The recorded commit graph (parents and generations stored at record time). Parents
/// beyond a truncated import are not recorded and end the walk there.
pub struct RecordedGraph<'a, S>(pub &'a S);
impl<S: SqlStore> CommitGraph for RecordedGraph<'_, S> {
    fn parents(&self, id: &ObjectId) -> Result<Vec<ObjectId>> {
        let mut parents = Vec::new();
        for parent in recorded(self.0, id)?.parents {
            if commit_row(self.0, &parent)?.is_some() {
                parents.push(parent);
            }
        }
        Ok(parents)
    }
    fn generation(&self, id: &ObjectId) -> Result<u64> {
        Ok(recorded(self.0, id)?.generation)
    }
}
