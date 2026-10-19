//! Code-aware compute: symbols, symbol edits (stale handles rejected), review classes and
//! literal codemods. Every blob is verified against its id before use.
use crate::platform_derived::verified_blob;
use crate::platform_review::{ReviewClass, classify};
use crate::platform_symbols::{EXTRACTOR_VERSION, Symbol, extract};
use crate::storage::{bad, string};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use yoneda_core::{Error, Result, git_object::ObjectId};

fn text_blob(c: &Value, key: &str) -> Result<(ObjectId, String)> {
    let id = ObjectId::parse(&string(c, key)?)?;
    let data = verified_blob(c, &id)?.ok_or_else(|| Error::new("NEED_BLOB", id.hex()))?;
    let text = String::from_utf8(data).map_err(|_| bad("Not a UTF-8 text file"))?;
    Ok((id, text))
}

fn with_digest(source: &str, symbol: &Symbol) -> Value {
    let mut value = json!(symbol);
    value["digest"] = json!(yoneda_core::digest(
        &source.as_bytes()[symbol.start..symbol.end]
    ));
    value
}

pub fn symbols(c: &Value) -> Result<Value> {
    let path = string(c, "path")?;
    let (id, source) = match text_blob(c, "id") {
        Err(e) if e.code == "NEED_BLOB" => return Ok(json!({ "need_blobs": [e.message] })),
        other => other?,
    };
    let supported = crate::platform_symbols::language(&path).is_some();
    Ok(match extract(&path, &source) {
        Ok(list) => json!({
            "path": path, "id": id, "supported": supported, "extractor": EXTRACTOR_VERSION,
            "symbols": list.iter().map(|s| with_digest(&source, s)).collect::<Vec<_>>(),
        }),
        Err(error) => {
            json!({ "path": path, "id": id, "supported": supported, "extractor": EXTRACTOR_VERSION,
            "parse_error": error, "symbols": [] })
        }
    })
}

/// Replaces one symbol's text. The handle's digest must match the symbol as it is in the
/// current file (found by its qualified path), or the edit is rejected as stale. The
/// result must still parse.
pub fn symbol_edit(c: &Value) -> Result<Value> {
    let path = string(c, "path")?;
    let (id, source) = match text_blob(c, "id") {
        Err(e) if e.code == "NEED_BLOB" => return Ok(json!({ "need_blobs": [e.message] })),
        other => other?,
    };
    let handle = &c["handle"];
    let symbol_path = string(handle, "symbol_path")?;
    let digest = string(handle, "digest")?;
    let current = extract(&path, &source).map_err(|e| Error::new("PARSE_FAILED", e))?;
    let symbol = current
        .iter()
        .find(|s| s.symbol_path == symbol_path)
        .ok_or_else(|| {
            Error::new(
                "STALE_HANDLE",
                format!("{symbol_path} no longer exists in {path}"),
            )
        })?;
    if yoneda_core::digest(&source.as_bytes()[symbol.start..symbol.end]) != digest {
        return Err(Error::new(
            "STALE_HANDLE",
            format!("{symbol_path} changed since the handle was issued"),
        ));
    }
    let replacement = String::from_utf8(
        STANDARD
            .decode(string(c, "replacement_b64")?)
            .map_err(|_| bad("replacement is not base64"))?,
    )
    .map_err(|_| bad("replacement is not UTF-8"))?;
    let updated = format!(
        "{}{}{}",
        &source[..symbol.start],
        replacement,
        &source[symbol.end..]
    );
    extract(&path, &updated).map_err(|e| {
        Error::new(
            "INVALID_EDIT",
            format!("The edited file no longer parses: {e}"),
        )
    })?;
    Ok(json!({ "path": path, "expect": id, "content_b64": STANDARD.encode(updated) }))
}

/// Classes for a set of changed files (`old`/`new` blob ids, null when absent).
pub fn review_classes(c: &Value) -> Result<Value> {
    let changes = c["changes"]
        .as_array()
        .ok_or_else(|| bad("changes must be a list"))?;
    let mut need = BTreeSet::new();
    let mut files = Vec::new();
    for change in changes {
        let path = string(change, "path")?;
        let mut side = |key: &str| -> Result<Option<Option<Vec<u8>>>> {
            match change.get(key).filter(|v| !v.is_null()) {
                None => Ok(Some(None)),
                Some(_) => {
                    let id = ObjectId::parse(&string(change, key)?)?;
                    Ok(verified_blob(c, &id)?.map(Some).or_else(|| {
                        need.insert(id);
                        None
                    }))
                }
            }
        };
        let (old, new) = (side("old")?, side("new")?);
        if let (Some(old), Some(new)) = (old, new) {
            let class = classify(&path, old.as_deref(), new.as_deref());
            files.push(json!({ "path": path, "class": class }));
        }
    }
    if !need.is_empty() {
        return Ok(json!({ "need_blobs": need }));
    }
    let overall = files
        .iter()
        .filter_map(|f| serde_json::from_value::<String>(f["class"].clone()).ok())
        .map(|name| match name.as_str() {
            "docs" => ReviewClass::Docs,
            "formatting" => ReviewClass::Formatting,
            "comment_only" => ReviewClass::CommentOnly,
            "logic" => ReviewClass::Logic,
            _ => ReviewClass::Unknown,
        })
        .max()
        .unwrap_or(ReviewClass::Unknown);
    Ok(json!({ "files": files, "overall": overall }))
}

/// Literal find/replace in one file; `changed: false` when the text does not occur.
pub fn replace_literal(c: &Value) -> Result<Value> {
    let find = string(c, "find")?;
    let replace = c["replace"]
        .as_str()
        .ok_or_else(|| bad("Missing replace"))?;
    let (id, source) = match text_blob(c, "id") {
        Err(e) if e.code == "NEED_BLOB" => return Ok(json!({ "need_blobs": [e.message] })),
        Err(e) if e.code == "INVALID_INPUT" => {
            return Ok(json!({ "changed": false, "binary": true }));
        }
        other => other?,
    };
    let count = source.matches(&find).count();
    if count == 0 {
        return Ok(json!({ "changed": false }));
    }
    Ok(json!({ "changed": true, "expect": id, "occurrences": count,
        "content_b64": STANDARD.encode(source.replace(&find, replace)) }))
}
