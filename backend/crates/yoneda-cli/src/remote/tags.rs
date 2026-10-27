//! Lightweight tags in `push`: created once at the pushed commit (`POST /tags`), never
//! moved or deleted. Annotated tag objects are refused before anything is uploaded.
use super::Session;
use super::upload::Uploaded;
use serde_json::json;

pub const TAGS: &str = "refs/tags/";

/// A tag is created once: an annotated tag object is refused, and an existing tag is up
/// to date (nothing to do) only when it already names `local`.
pub fn tag_refusal(
    session: &Session,
    src: &str,
    local: &str,
    current: Option<&str>,
) -> Option<String> {
    if session.git.run(&["cat-file", "-t", src]).ok().as_deref() == Some("tag") {
        return Some(
            "annotated tags are not supported: push a lightweight tag (git tag <name>)".into(),
        );
    }
    let current = current?;
    (session.held(current).as_deref() != Some(local))
        .then(|| "tags are immutable: this tag already exists".into())
}

pub async fn create_tag(
    session: &Session,
    dst: &str,
    done: &Uploaded,
) -> std::result::Result<(), String> {
    let body = json!({ "name": dst, "commit": done.tip });
    match session.api.post("/tags", &body).await {
        Ok(_) => Ok(()),
        Err(f) if f.code == "ALREADY_EXISTS" => {
            Err("tags are immutable: this tag already exists".into())
        }
        Err(f) => Err(f.to_string()),
    }
}
