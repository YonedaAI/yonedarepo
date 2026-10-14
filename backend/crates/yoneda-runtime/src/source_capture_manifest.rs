//! Compact registered context and bounded, immutable manifest assembly.
use serde_json::Value;
use yoneda_core::{
    Result,
    source_changeset::SourceChangeset,
    source_workspace::{MAX_FILES, SourceBinding, invalid},
};
pub(crate) const MANIFEST_METADATA_LIMIT: usize = 64 * 1024 * 1024;
pub(crate) fn assemble_manifest(
    binding: &SourceBinding,
    header: &Value,
    changes: Vec<Value>,
    overrides: Vec<Value>,
    digest: &str,
) -> Result<SourceChangeset> {
    if changes.len() > MAX_FILES || overrides.len() > MAX_FILES {
        return Err(invalid("Sealed manifest exceeds source row capability"));
    }
    let mut value = header.clone();
    let object = value
        .as_object_mut()
        .ok_or_else(|| invalid("Registered manifest header missing"))?;
    if object.contains_key("changes") || object.contains_key("baseline_overrides") {
        return Err(invalid("Capture header must not contain full manifests"));
    }
    object.insert("changes".into(), Value::Array(changes));
    object.insert("baseline_overrides".into(), Value::Array(overrides));
    if serde_json::to_vec(&value)
        .map_err(|_| invalid("Manifest encoding failed"))?
        .len()
        > MANIFEST_METADATA_LIMIT
    {
        return Err(invalid("Sealed metadata exceeds bounded native assembly"));
    }
    let manifest: SourceChangeset = serde_json::from_value(value)
        .map_err(|_| invalid("Sealed manifest violates closed source contract"))?;
    manifest.validate(binding)?;
    if manifest.digest()? != digest {
        return Err(invalid(
            "Paged manifest differs from registered seal digest",
        ));
    }
    Ok(manifest)
}
pub(crate) fn page_items(page: &Value, digest: &str, after: Option<&str>) -> Result<Vec<Value>> {
    if page["changeset_digest"].as_str() != Some(digest) {
        return Err(invalid("Manifest page seal changed"));
    }
    let items = page["items"]
        .as_array()
        .filter(|items| items.len() <= 200)
        .ok_or_else(|| invalid("Manifest page exceeds row bound"))?;
    let mut previous = after.unwrap_or("");
    for item in items {
        let path = item["path"]
            .as_str()
            .ok_or_else(|| invalid("Manifest item has no source path"))?;
        yoneda_core::validate_path(path)?;
        if path <= previous {
            return Err(invalid("Manifest page paths repeated or out of order"));
        }
        previous = path;
    }
    match page.get("next_cursor") {
        Some(Value::Null) => {}
        Some(Value::String(cursor)) if !items.is_empty() && cursor == previous => {}
        _ => {
            return Err(invalid(
                "Manifest cursor does not advance along exact sealed rows",
            ));
        }
    }
    Ok(items.clone())
}
