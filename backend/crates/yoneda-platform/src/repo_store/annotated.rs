//! Annotated tag objects. The tag's ref names its commit like a lightweight tag, so refs,
//! the log and every reader of commits are unchanged; the tag object is kept here byte for
//! byte (its id is the one Git computed). Ref listings name the tag object for its ref
//! (`annotated`), and a fetch that wants a tag object gets its commit's history plus the
//! object itself (`peel_wants`).
use crate::storage::{SqlStore, bad};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use yoneda_core::{
    Error, Result,
    git_object::{AnnotatedTag, ObjectId, ObjectKind, Signature, TzOffset, hash_object},
};

/// Longest message of a tag the platform builds (`git_tag` with `message`).
const MAX_MESSAGE: usize = 8000;
const TAGGER_EMAIL: &str = "tags@yonedarepo.invalid";
/// Ids bound per lookup (a Durable Object's SQLite allows 100 parameters).
const LOOKUP: usize = 100;

/// A checked tag object about to be stored.
pub(super) struct Annotation {
    pub id: ObjectId,
    data_b64: String,
}

impl Annotation {
    /// The tag object an update carries (`tag: {data_b64}`): a well-formed tag of `commit`.
    pub fn of(c: &Value, commit: &ObjectId) -> Result<Option<Self>> {
        let Some(tag) = c.get("tag").filter(|t| !t.is_null()) else {
            return Ok(None);
        };
        let data_b64 = tag["data_b64"]
            .as_str()
            .ok_or_else(|| bad("tag must be {data_b64}"))?;
        let data = STANDARD
            .decode(data_b64)
            .map_err(|_| bad("tag.data_b64 must be base64"))?;
        let decoded = AnnotatedTag::decode(&data)?;
        if decoded.object != *commit {
            return Err(bad(&format!(
                "The tag object names {}, not the tagged commit {commit}",
                decoded.object
            )));
        }
        Ok(Some(Self {
            id: hash_object(ObjectKind::Tag, &data),
            data_b64: data_b64.to_owned(),
        }))
    }

    pub fn store<S: SqlStore>(
        &self,
        db: &S,
        refname: &str,
        principal: &str,
        now: i64,
    ) -> Result<()> {
        let commit = super::rows::ref_value(db, refname)?
            .ok_or_else(|| super::rows::corrupt("annotated tag ref"))?;
        db.query(
            "INSERT INTO annotated_tags(refname,tag_id,commit_id,data_b64,created_by,created_at) VALUES(?,?,?,?,?,?)",
            &[json!(refname), json!(self.id), json!(commit), json!(self.data_b64), json!(principal), json!(now)],
        )?;
        Ok(())
    }
}

/// The tag object `refname` names, when it is an annotated tag.
pub(super) fn tag_id<S: SqlStore>(db: &S, refname: &str) -> Result<Option<ObjectId>> {
    match db
        .query(
            "SELECT tag_id FROM annotated_tags WHERE refname=?",
            &[json!(refname)],
        )?
        .first()
    {
        Some(row) => Ok(Some(ObjectId::parse(
            row["tag_id"].as_str().unwrap_or_default(),
        )?)),
        None => Ok(None),
    }
}

/// With `message`, the base64 bytes of an annotated tag of `c.commit` named after
/// `refname`, tagged by `tagger {name, email}` (default: the principal) at `now`.
pub(super) fn built(c: &Value, refname: &str, principal: &str) -> Result<Option<String>> {
    let Some(message) = super::changes::text(c, "message", MAX_MESSAGE)? else {
        return Ok(None);
    };
    let commit = super::rows::object_id(c, "commit")?;
    let seconds = crate::storage::number(c, "now")? / 1000;
    let field = |key: &str| c["tagger"][key].as_str().map(str::to_owned);
    let tagger = Signature {
        name: field("name").unwrap_or_else(|| principal.to_owned()),
        email: field("email").unwrap_or_else(|| TAGGER_EMAIL.to_owned()),
        seconds,
        offset: TzOffset::UTC,
    };
    let name = refname.strip_prefix("refs/tags/").unwrap_or(refname);
    let tag = AnnotatedTag::new(commit, name, tagger, &message)?;
    Ok(Some(STANDARD.encode(tag.encode()?)))
}

/// `refname → tag object id` for each listed tag that is annotated.
pub(super) fn listed<S: SqlStore>(
    db: &S,
    refs: &BTreeMap<String, ObjectId>,
) -> Result<Map<String, Value>> {
    let mut out = Map::new();
    if !refs.keys().any(|name| super::rows::is_tag(name)) {
        return Ok(out);
    }
    for row in db.query("SELECT refname,tag_id,commit_id FROM annotated_tags", &[])? {
        let name = row["refname"].as_str().unwrap_or_default();
        if refs.get(name).map(ObjectId::hex).as_deref() == row["commit_id"].as_str() {
            out.insert(name.to_owned(), row["tag_id"].clone());
        }
    }
    Ok(out)
}

/// `wants` with each annotated tag object replaced by its commit, and those tag objects
/// (`{id, data_b64}`) for the pack.
pub(super) fn peel_wants<S: SqlStore>(
    db: &S,
    wants: Vec<ObjectId>,
) -> Result<(Vec<ObjectId>, Vec<Value>)> {
    let mut tags: BTreeMap<ObjectId, (ObjectId, Value)> = BTreeMap::new();
    for chunk in wants.chunks(LOOKUP) {
        let marks = vec!["?"; chunk.len()].join(",");
        let params: Vec<Value> = chunk.iter().map(|id| json!(id.hex())).collect();
        for row in db.query(
            &format!(
                "SELECT tag_id,commit_id,data_b64 FROM annotated_tags WHERE tag_id IN ({marks})"
            ),
            &params,
        )? {
            let id = ObjectId::parse(row["tag_id"].as_str().unwrap_or_default())?;
            let commit = ObjectId::parse(row["commit_id"].as_str().unwrap_or_default())?;
            tags.insert(
                id,
                (commit, json!({ "id": id, "data_b64": row["data_b64"] })),
            );
        }
    }
    if tags.is_empty() {
        return Ok((wants, Vec::new()));
    }
    let mut peeled = Vec::with_capacity(wants.len());
    for want in wants {
        let commit = tags.get(&want).map_or(want, |(commit, _)| *commit);
        if !peeled.contains(&commit) {
            peeled.push(commit);
        }
    }
    let objects = tags.into_values().map(|(_, object)| object).collect();
    Ok((peeled, objects))
}

/// `repo_tag_show {name}`: the tag's commit and, when annotated, its tag object
/// (`tag`, `data_b64`), for clients that write it locally (`git-remote-yoneda`).
pub(super) fn tag_show<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let refname = super::rows::tag_ref(&crate::storage::string(c, "name")?)?;
    let commit = super::rows::ref_value(db, &refname)?
        .ok_or_else(|| Error::new("NOT_FOUND", format!("No tag {refname}")))?;
    let rows = db.query(
        "SELECT tag_id,data_b64 FROM annotated_tags WHERE refname=?",
        &[json!(refname)],
    )?;
    let row = rows.first();
    Ok(json!({
        "ref": refname, "commit": commit,
        "tag": row.map(|r| r["tag_id"].clone()), "data_b64": row.map(|r| r["data_b64"].clone()),
    }))
}

/// An annotated tag's id, message and tagger (null for a lightweight tag), for a release.
pub(super) fn show<S: SqlStore>(db: &S, refname: &str) -> Result<Value> {
    let rows = db.query(
        "SELECT tag_id,data_b64,created_by,created_at FROM annotated_tags WHERE refname=?",
        &[json!(refname)],
    )?;
    let Some(row) = rows.first() else {
        return Ok(Value::Null);
    };
    let data = STANDARD
        .decode(row["data_b64"].as_str().unwrap_or_default())
        .map_err(|_| super::rows::corrupt("annotated tag"))?;
    let tag = AnnotatedTag::decode(&data).map_err(|e| {
        Error::new(
            "DATABASE",
            format!("Corrupt stored tag object: {}", e.message),
        )
    })?;
    Ok(json!({
        "id": row["tag_id"], "message": tag.message,
        "tagger": tag.tagger.map(|t| json!({ "name": t.name, "email": t.email, "time": t.seconds })),
    }))
}
