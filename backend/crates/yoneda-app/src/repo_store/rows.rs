//! Typed access to platform tables.
use crate::storage::{SqlStore, bad, string};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use yoneda_core::{
    Error, Result,
    git_object::ObjectId,
    txlog::{PathTouch, TxEntry},
};

/// Landing policy: which checks must pass and how many independent approvals are needed.
/// `runners` are owner-defined commands the platform executes itself; definitions come
/// from policy, never from the commit under test, so a change cannot weaken its own check.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub required_checks: Vec<String>,
    pub approvals: u32,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub runners: BTreeMap<String, Runner>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Runner {
    /// argv, executed without a shell unless the owner writes `["sh", "-c", ...]`.
    pub command: Vec<String>,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u32,
}
fn default_timeout() -> u32 {
    600
}

impl Policy {
    pub fn parse(value: &Value) -> Result<(Self, Value, String)> {
        let policy: Policy = serde_json::from_value(value.clone())
            .map_err(|e| bad(&format!("Invalid policy: {e}")))?;
        policy
            .required_checks
            .iter()
            .chain(policy.runners.keys())
            .try_for_each(|name| check_name(name))?;
        if policy.runners.len() > 32
            || policy.runners.values().any(|r| {
                r.command.is_empty()
                    || r.command.len() > 64
                    || r.command.iter().any(|a| a.len() > 4096 || a.contains('\0'))
                    || !(1..=3600).contains(&r.timeout_seconds)
            })
        {
            return Err(bad(
                "Runners need 1-64 argv entries and a 1-3600 second timeout (at most 32 runners)",
            ));
        }
        let json = serde_json::to_value(&policy).map_err(|e| bad(&e.to_string()))?;
        let digest = yoneda_core::fingerprint(&json)?;
        Ok((policy, json, digest))
    }
}

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

pub fn check_name(name: &str) -> Result<()> {
    let valid = !name.is_empty()
        && name.len() <= 64
        && name.bytes().enumerate().all(|(i, b)| {
            b.is_ascii_lowercase()
                || b.is_ascii_digit()
                || (i > 0 && matches!(b, b'.' | b'_' | b'-'))
        });
    if valid {
        Ok(())
    } else {
        Err(bad(
            "Check names are lowercase [a-z0-9._-], up to 64 characters",
        ))
    }
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

pub fn ref_value<S: SqlStore>(db: &S, name: &str) -> Result<Option<ObjectId>> {
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
