//! Reading a cut-off `POST /objects` page: the objects that arrived whole, and where in the
//! request they reach, so the next request asks only for the rest.
use crate::error::{Error, Result};
use serde_json::Value;
use yoneda_core::git_object::ObjectKind;

/// The objects a page's body holds whole, from the start of a body cut off part way: the
/// platform writes `{"objects":[...` first, so each object that closed before the cut is
/// intact. Any other layout yields none (the page is asked again in full).
pub(super) fn whole_objects(body: &[u8]) -> Vec<Value> {
    let mut rest = body;
    let mut objects = Vec::new();
    if ![&b"{"[..], b"\"objects\"", b":", b"["]
        .iter()
        .all(|token| take(token, &mut rest))
    {
        return objects;
    }
    loop {
        let mut stream = serde_json::Deserializer::from_slice(rest).into_iter::<Value>();
        match stream.next() {
            Some(Ok(object)) if object.is_object() => {
                rest = &rest[stream.byte_offset()..];
                objects.push(object);
            }
            _ => return objects,
        }
        if !take(b",", &mut rest) {
            return objects;
        }
    }
}

/// Skips whitespace and then `token` at the start of `rest`, if it is there.
fn take(token: &[u8], rest: &mut &[u8]) -> bool {
    *rest = rest.trim_ascii_start();
    let found = rest.starts_with(token);
    if found {
        *rest = &rest[token.len()..];
    }
    found
}

/// How far into `part` the whole objects of a cut page reach (the positions after the last
/// one), and the ids before it that the platform skipped (it lacks them).
pub(super) fn aligned(
    part: &[(String, ObjectKind)],
    whole: &[Value],
) -> Result<(usize, Vec<String>)> {
    let mut at = 0;
    let mut skipped = Vec::new();
    for object in whole {
        let id = object["id"].as_str().unwrap_or_default();
        while part.get(at).is_some_and(|(wanted, _)| wanted != id) {
            skipped.push(part[at].0.clone());
            at += 1;
        }
        if at == part.len() {
            return Err(Error::new(format!("the platform sent {id}, not asked for")));
        }
        at += 1;
    }
    Ok((at, skipped))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keeps_the_objects_a_cut_page_holds_whole() {
        let body = br#"{"objects":[{"id":"a","n":1}, {"id":"b","s":"x,]}"},{"id":"c","s":"tru"#;
        let ids: Vec<Value> = whole_objects(body)
            .iter()
            .map(|o| o["id"].clone())
            .collect();
        assert_eq!(ids, vec![json!("a"), json!("b")]);
        assert!(whole_objects(br#"{"missing":[],"objects":[{"id":"a"}"#).is_empty());
        assert!(whole_objects(b"").is_empty());
    }

    #[test]
    fn a_cut_page_resumes_after_its_last_whole_object() -> Result<()> {
        let part: Vec<(String, ObjectKind)> = ["a", "x", "b", "c"]
            .iter()
            .map(|id| (id.to_string(), ObjectKind::Blob))
            .collect();
        let whole = vec![json!({ "id": "a" }), json!({ "id": "b" })];
        assert_eq!(aligned(&part, &whole)?, (3, vec!["x".to_owned()]));
        assert_eq!(aligned(&part, &[])?, (0, vec![]));
        assert!(aligned(&part, &[json!({ "id": "z" })]).is_err());
        Ok(())
    }
}
