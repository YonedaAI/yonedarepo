//! Releases: a title, notes and downloadable assets attached to one existing tag (at most
//! one release per tag). Asset bytes live in R2 under `release/<repo>/<tag>/<name>`; the
//! adapter writes them (after a `dry_run` of the same call refused nothing) and then
//! records the asset's size and sha256 here. Assets are immutable: a name is used once per
//! release until the release is deleted. Publishing and deleting are `release` webhook
//! events. A release describes the whole repository, so path-restricted credentials can
//! neither read nor write one.
use super::auth::Actor;
use super::hook_events::{Event, enqueue};
use super::{annotated, changes, hooks, rows};
use crate::storage::{SqlStore, bad, number, string};
use serde_json::{Map, Value, json};
use yoneda_core::{Error, Result};

pub const MAX_TITLE: usize = 200;
pub const MAX_NOTES: usize = 16_000;
/// Largest asset: the adapter holds an upload whole to hash it before writing R2.
pub const MAX_ASSET_BYTES: i64 = 25 * 1024 * 1024;
pub const MAX_ASSETS: i64 = 20;
const MAX_LIST: i64 = 100;
const MAX_MESSAGE: usize = 4096;

const RELEASE: &str = "SELECT r.tag,r.title,r.notes,r.created_by,r.created_at,\
     (SELECT commit_id FROM refs WHERE name='refs/tags/'||r.tag) AS commit_id,\
     (SELECT COUNT(*) FROM release_assets a WHERE a.tag=r.tag) AS asset_count \
     FROM releases r";

/// The short name of an existing tag (`v1` or `refs/tags/v1`).
fn existing_tag<S: SqlStore>(db: &S, c: &Value) -> Result<(String, String)> {
    let refname = rows::tag_ref(&string(c, "tag")?)?;
    let commit = rows::ref_value(db, &refname)?
        .ok_or_else(|| Error::new("NOT_FOUND", format!("No tag {refname}; push it first")))?;
    Ok((refname["refs/tags/".len()..].to_owned(), commit.hex()))
}

fn get<S: SqlStore>(db: &S, tag: &str) -> Result<Value> {
    db.query(&format!("{RELEASE} WHERE r.tag=?"), &[json!(tag)])?
        .into_iter()
        .next()
        .ok_or_else(|| Error::new("NOT_FOUND", format!("No release for tag {tag}")))
}

fn assets<S: SqlStore>(db: &S, tag: &str) -> Result<Vec<Value>> {
    db.query(
        "SELECT name,size,sha256,content_type,uploaded_by,uploaded_at FROM release_assets WHERE tag=? ORDER BY name",
        &[json!(tag)],
    )
}

/// `repo_release_create {tag, title, notes?}`.
pub fn create<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    changes::whole_repository(actor)?;
    let (tag, _) = existing_tag(db, c)?;
    let title =
        changes::text(c, "title", MAX_TITLE)?.ok_or_else(|| bad("A release needs a title"))?;
    if title.chars().any(char::is_control) {
        return Err(bad("title must be one line"));
    }
    let notes = changes::text(c, "notes", MAX_NOTES)?.unwrap_or_default();
    if get(db, &tag).is_ok() {
        return Err(Error::new(
            "ALREADY_EXISTS",
            format!("Tag {tag} already has a release"),
        ));
    }
    let now = number(c, "now")?;
    db.query(
        "INSERT INTO releases(tag,title,notes,created_by,created_at) VALUES(?,?,?,?,?)",
        &[
            json!(tag),
            json!(title),
            json!(notes),
            json!(actor.principal),
            json!(now),
        ],
    )?;
    let release = get(db, &tag)?;
    notify(db, "release.published", &release, &actor.principal, now)?;
    Ok(release)
}

/// `repo_releases {limit?}`: newest first.
pub fn list<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    changes::whole_repository(actor)?;
    let limit = c["limit"].as_i64().unwrap_or(50).clamp(1, MAX_LIST);
    let releases = db.query(
        &format!("{RELEASE} ORDER BY r.created_at DESC, r.tag LIMIT ?"),
        &[json!(limit)],
    )?;
    Ok(json!({ "releases": releases }))
}

/// `repo_release_show {tag}`: the release, its assets, and its tag object when annotated.
pub fn show<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    changes::whole_repository(actor)?;
    let (tag, _) = existing_tag(db, c)?;
    let mut release = get(db, &tag)?;
    release["assets"] = json!(assets(db, &tag)?);
    release["annotated"] = annotated::show(db, &format!("refs/tags/{tag}"))?;
    Ok(release)
}

/// `repo_release_delete {tag}`: the release and its asset rows; answers the asset names
/// so the adapter deletes their bytes. The tag stays (tags never disappear).
pub fn delete<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    changes::whole_repository(actor)?;
    let (tag, _) = existing_tag(db, c)?;
    let release = get(db, &tag)?;
    let names: Vec<Value> = assets(db, &tag)?
        .into_iter()
        .map(|a| a["name"].clone())
        .collect();
    db.query("DELETE FROM release_assets WHERE tag=?", &[json!(tag)])?;
    db.query("DELETE FROM releases WHERE tag=?", &[json!(tag)])?;
    notify(
        db,
        "release.deleted",
        &release,
        &actor.principal,
        number(c, "now")?,
    )?;
    Ok(json!({ "tag": tag, "deleted": true, "assets": names }))
}

/// A file name for an asset: one path segment of safe characters.
fn asset_name(c: &Value) -> Result<String> {
    let name = string(c, "name")?;
    let safe = name.len() <= 200
        && !name.starts_with('.')
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || "._-+".contains(ch));
    if !safe {
        return Err(bad(
            "Asset names are up to 200 letters, digits, '.', '_', '-' or '+', not starting with '.'",
        ));
    }
    Ok(name)
}

/// `repo_release_asset_put {tag, name, size, sha256, content_type, dry_run?}`: records an
/// asset the adapter wrote to R2 (with `dry_run`, only checks it may).
pub fn asset_put<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    changes::whole_repository(actor)?;
    let (tag, _) = existing_tag(db, c)?;
    get(db, &tag)?;
    let name = asset_name(c)?;
    let size = number(c, "size")?;
    if !(0..=MAX_ASSET_BYTES).contains(&size) {
        return Err(Error::new(
            "TOO_LARGE",
            format!("A release asset is at most {MAX_ASSET_BYTES} bytes"),
        ));
    }
    let sha256 = string(c, "sha256")?;
    if sha256.len() != 64
        || !sha256
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(bad("sha256 must be 64 lowercase hex digits"));
    }
    let content_type = c["content_type"]
        .as_str()
        .filter(|t| !t.is_empty() && t.len() <= 200 && !t.contains(char::is_control))
        .unwrap_or("application/octet-stream");
    let held = assets(db, &tag)?;
    if held.iter().any(|a| a["name"] == name.as_str()) {
        return Err(Error::new(
            "ALREADY_EXISTS",
            format!("Release {tag} already has an asset {name}"),
        ));
    }
    if held.len() as i64 >= MAX_ASSETS {
        return Err(Error::new(
            "TOO_LARGE",
            format!("A release holds at most {MAX_ASSETS} assets"),
        ));
    }
    let asset = json!({ "tag": tag, "name": name, "size": size, "sha256": sha256, "content_type": content_type });
    if c["dry_run"] == true {
        return Ok(asset);
    }
    db.query(
        "INSERT INTO release_assets(tag,name,size,sha256,content_type,uploaded_by,uploaded_at) VALUES(?,?,?,?,?,?,?)",
        &[json!(tag), json!(name), json!(size), json!(sha256), json!(content_type), json!(actor.principal), json!(number(c, "now")?)],
    )?;
    Ok(asset)
}

/// `repo_release_asset {tag, name}`: one recorded asset, for a download.
pub fn asset<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    changes::whole_repository(actor)?;
    let (tag, _) = existing_tag(db, c)?;
    let name = asset_name(c)?;
    assets(db, &tag)?
        .into_iter()
        .find(|a| a["name"] == name.as_str())
        .map(|mut a| {
            a["tag"] = json!(tag);
            a
        })
        .ok_or_else(|| Error::new("NOT_FOUND", format!("Release {tag} has no asset {name}")))
}

fn notify<S: SqlStore>(
    db: &S,
    name: &'static str,
    release: &Value,
    actor: &str,
    at_ms: i64,
) -> Result<()> {
    let subscribed: Vec<_> = hooks::active(db)?
        .into_iter()
        .filter(|h| h.wants(name))
        .collect();
    if subscribed.is_empty() {
        return Ok(());
    }
    let tag = release["tag"].as_str().unwrap_or_default();
    let mut fields = Map::new();
    fields.insert("ref".into(), json!(format!("refs/tags/{tag}")));
    fields.insert("commit".into(), release["commit_id"].clone());
    fields.insert("actor".into(), json!(actor));
    fields.insert("action".into(), json!(name.trim_start_matches("release.")));
    fields.insert(
        "release".into(),
        json!({ "tag": tag, "title": release["title"] }),
    );
    let mut notes = release["notes"].as_str().unwrap_or_default();
    let mut end = notes.len().min(MAX_MESSAGE);
    while !notes.is_char_boundary(end) {
        end -= 1;
    }
    notes = &notes[..end];
    let event = Event {
        name,
        version: None,
        at_ms,
        fields,
        // Release notes never reach a path-restricted hook: no grant covers this path.
        paths: vec![String::new()],
        message: (!notes.is_empty()).then(|| notes.to_owned()),
    };
    for hook in &subscribed {
        enqueue(db, hook, &event)?;
    }
    Ok(())
}
