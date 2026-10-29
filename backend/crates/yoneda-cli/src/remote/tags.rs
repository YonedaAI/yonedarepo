//! Tags in `list` and `push`: created once at the pushed commit (`POST /tags`), never
//! moved or deleted. An annotated tag travels as its tag object, byte for byte: a push
//! sends the local object with the tag, and `list` writes the platform's object locally
//! (fetched from `GET /tags/<name>`) and names it, as a stock Git remote does.
use super::Session;
use super::fetch::Fetcher;
use super::upload::Uploaded;
use crate::error::{Error, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use yoneda_core::git_object::{AnnotatedTag, ObjectKind, hash_object};

pub const TAGS: &str = "refs/tags/";

/// The annotated tag object `src` names (`None`: a lightweight tag).
pub fn tag_object(session: &Session, src: &str) -> Option<Vec<u8>> {
    if session.git.run(&["cat-file", "-t", src]).ok().as_deref() != Some("tag") {
        return None;
    }
    session
        .git
        .output(&["cat-file", "tag", src], None, &[])
        .ok()
}

/// A tag is created once: an existing tag is up to date (nothing to do) only when it
/// already names `local`, as the same tag object when `src` is annotated (`annotated`:
/// the platform's tag object for this tag, if any).
pub fn tag_refusal(
    session: &Session,
    src: &str,
    local: &str,
    current: Option<&str>,
    annotated: Option<&str>,
) -> Option<String> {
    let current = current?;
    let object = tag_object(session, src).map(|data| hash_object(ObjectKind::Tag, &data).hex());
    let same = session.held(current).as_deref() == Some(local) && object.as_deref() == annotated;
    (!same).then(|| "tags are immutable: this tag already exists".into())
}

/// The batch update creating tag `dst` from `src` at the uploaded tip.
pub fn tag_update(session: &Session, src: &str, dst: &str, done: &Uploaded) -> Result<Value> {
    let mut update = json!({ "ref": dst, "commit": done.tip, "expected": null });
    if let Some(data) = annotated_at(session, src, done)? {
        update["tag"] = json!({ "data_b64": STANDARD.encode(data) });
    }
    Ok(update)
}

/// `src`'s tag object, when annotated, checked to tag the uploaded tip (a commit the
/// platform rebuilt under another id cannot keep a tag object that names the local one).
fn annotated_at(session: &Session, src: &str, done: &Uploaded) -> Result<Option<Vec<u8>>> {
    let Some(data) = tag_object(session, src) else {
        return Ok(None);
    };
    let tag = AnnotatedTag::decode(&data).map_err(|e| Error::new(e.message))?;
    if tag.object.hex() != done.tip {
        return Err(Error::new(format!(
            "the tagged commit is {} on the platform; tag that commit to push an annotated tag",
            done.tip
        )));
    }
    Ok(Some(data))
}

pub async fn create_tag(
    session: &Session,
    src: &str,
    dst: &str,
    done: &Uploaded,
) -> std::result::Result<(), String> {
    let mut body = json!({ "name": dst, "commit": done.tip });
    match annotated_at(session, src, done) {
        Ok(Some(data)) => body["object_b64"] = json!(STANDARD.encode(data)),
        Ok(None) => {}
        Err(e) => return Err(e.message),
    }
    match session.api.post("/tags", &body).await {
        Ok(_) => Ok(()),
        Err(f) if f.code == "ALREADY_EXISTS" => {
            Err("tags are immutable: this tag already exists".into())
        }
        Err(f) => Err(f.to_string()),
    }
}

/// What `list` names for annotated tag `name` (platform commit `commit`, tag object
/// `tag`): the tag object, written locally with its commit's history. A commit this clone
/// holds under a converted id keeps the tag lightweight (the object names the other id).
pub async fn listed(session: &mut Session, name: &str, commit: &str, tag: &str) -> Result<String> {
    let local = Fetcher::new(
        &session.api,
        &session.git,
        &mut session.map,
        &session.filter,
    )
    .local(commit, None)
    .await?;
    if local != commit {
        return Ok(local);
    }
    if session.git.missing(&[tag.to_owned()])?.is_empty() {
        return Ok(tag.to_owned());
    }
    let short = name.strip_prefix(TAGS).unwrap_or(name);
    let path = format!("/tags/{}", crate::api::encode(short).replace('/', "%2F"));
    let shown = session.api.get(&path).await?;
    let data = STANDARD
        .decode(shown["data_b64"].as_str().unwrap_or_default())
        .map_err(|_| Error::new(format!("tag {short}: the platform sent no tag object")))?;
    let decoded = AnnotatedTag::decode(&data).map_err(|e| Error::new(e.message))?;
    if hash_object(ObjectKind::Tag, &data).hex() != tag || decoded.object.hex() != commit {
        return Err(Error::new(format!(
            "tag {short}: the platform's tag object does not match {tag}"
        )));
    }
    crate::snapshot::write_objects(&session.git, vec![(ObjectKind::Tag, data)], &session.filter)?;
    Ok(tag.to_owned())
}
