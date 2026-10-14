//! Immutable path manifests keep API metadata below SQLite and supervisor limits.
use crate::storage::{SqlStore, bad, create, get, hash, string};
use serde_json::{Value, json};
use yoneda_core::{Error, Result};
pub(crate) mod access;
pub(crate) mod integrity;
#[cfg(test)]
mod tests;
pub(crate) const MAX_PATHS: usize = 2 * yoneda_core::source_workspace::MAX_FILES;
fn paths(value: &Value) -> Result<Vec<String>> {
    let values = value.as_array().ok_or_else(|| bad("Missing path array"))?;
    if values.len() > MAX_PATHS {
        return Err(Error::new(
            "SOURCE_LIMIT",
            "Path manifest exceeds two source trees",
        ));
    }
    let mut result = Vec::with_capacity(values.len());
    for v in values {
        let path = v.as_str().ok_or_else(|| bad("Invalid path entry"))?;
        yoneda_core::validate_path(path.trim_end_matches('/'))?;
        result.push(path.to_owned());
    }
    Ok(result)
}
pub(crate) fn persist<S: SqlStore>(db: &S, value: &Value) -> Result<Value> {
    let mut items = paths(value)?;
    items.sort();
    items.dedup();
    let digest = yoneda_core::fingerprint(&json!(items))?;
    let id = format!("paths:{digest}");
    let reference = json!({"version":1,"id":id,"digest":digest,"count":items.len()});
    match get(db, "source_path_lists", &id) {
        Ok(old) if old == reference => {
            load_ref(db, &reference)?;
            return Ok(reference);
        }
        Ok(_) => return Err(Error::new("DATABASE", "Path manifest identity collision")),
        Err(e) if e.code == "NOT_FOUND" => {}
        Err(e) => return Err(e),
    }
    create(db, "source_path_lists", &id, &reference)?;
    for path in items {
        db.query(
            "INSERT INTO source_path_entries(list_id,path) VALUES(?,?)",
            &[json!(id), json!(path)],
        )?;
    }
    Ok(reference)
}
fn load_ref<S: SqlStore>(db: &S, reference: &Value) -> Result<Vec<String>> {
    if reference.as_object().is_none_or(|o| o.len() != 4) || reference["version"] != 1 {
        return Err(bad("Invalid path reference"));
    }
    let id = string(reference, "id")?;
    let digest = hash(reference, "digest", &[64])?;
    let count = reference["count"]
        .as_u64()
        .filter(|n| *n <= MAX_PATHS as u64)
        .ok_or_else(|| bad("Invalid path count"))?;
    if id != format!("paths:{digest}") || get(db, "source_path_lists", &id)? != *reference {
        return Err(Error::new(
            "FENCED",
            "Path reference differs from stored manifest",
        ));
    }
    let mut result = Vec::new();
    let mut after = String::new();
    loop {
        let rows=db.query("SELECT path FROM source_path_entries WHERE list_id=? AND path>? ORDER BY path LIMIT 200", &[json!(id),json!(after)])?;
        if rows.is_empty() {
            break;
        }
        for row in rows {
            let path = string(&row, "path")?;
            yoneda_core::validate_path(path.trim_end_matches('/'))?;
            after = path.clone();
            result.push(path);
        }
        if result.len() > MAX_PATHS {
            return Err(Error::new("DATABASE", "Path manifest overflow"));
        }
    }
    if result.len() as u64 != count || yoneda_core::fingerprint(&json!(result))? != digest {
        return Err(Error::new(
            "DATABASE",
            "Path manifest rows differ from frozen digest",
        ));
    }
    Ok(result)
}
pub(crate) fn load<S: SqlStore>(db: &S, record: &Value, key: &str) -> Result<Vec<String>> {
    if let Some(reference) = record.get(format!("{key}_ref")).filter(|v| !v.is_null()) {
        load_ref(db, reference)
    } else if record.get(key).is_none() {
        Ok(vec![])
    } else {
        paths(&record[key])
    }
}
pub(crate) fn compact<S: SqlStore>(db: &S, record: &mut Value, key: &str) -> Result<()> {
    let reference = persist(db, &record[key])?;
    record[format!("{key}_count")] = reference["count"].clone();
    record[format!("{key}_ref")] = reference;
    record
        .as_object_mut()
        .ok_or_else(|| bad("Invalid path record"))?
        .remove(key);
    Ok(())
}
pub(crate) fn page<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let id = string(c, "candidate_id")?;
    let record = get(db, "candidates", &id)?;
    let mut result = page_record(db, c, &record)?;
    result["candidate_id"] = json!(id);
    Ok(result)
}
pub(crate) fn page_record<S: SqlStore>(db: &S, c: &Value, record: &Value) -> Result<Value> {
    let limit = c
        .get("limit")
        .map_or(Some(100), Value::as_u64)
        .filter(|n| (1..=200).contains(n))
        .ok_or_else(|| bad("Invalid path page limit"))?;
    let after = c
        .get("after")
        .filter(|v| !v.is_null())
        .map(|v| v.as_str().ok_or_else(|| bad("Invalid path cursor")))
        .transpose()?
        .unwrap_or("");
    if !after.is_empty() {
        yoneda_core::validate_path(after.trim_end_matches('/'))?;
    }
    let (digest, total, selected) = if !record["paths_ref"].is_null() {
        let reference = &record["paths_ref"];
        let list_id = string(reference, "id")?;
        let digest = hash(reference, "digest", &[64])?;
        if reference.as_object().is_none_or(|o| o.len() != 4)
            || reference["version"] != 1
            || list_id != format!("paths:{digest}")
            || get(db, "source_path_lists", &list_id)? != *reference
        {
            return Err(Error::new("FENCED", "Invalid path manifest reference"));
        }
        let total = reference["count"]
            .as_u64()
            .filter(|n| *n <= MAX_PATHS as u64)
            .ok_or_else(|| bad("Invalid path count"))?;
        let rows = db.query(
            "SELECT path FROM source_path_entries WHERE list_id=? AND path>? ORDER BY path LIMIT ?",
            &[json!(list_id), json!(after), json!(limit + 1)],
        )?;
        (
            digest,
            total,
            rows.iter()
                .map(|r| string(r, "path"))
                .collect::<Result<Vec<_>>>()?,
        )
    } else {
        let mut items = load(db, record, "paths")?;
        items.sort();
        items.dedup();
        (
            yoneda_core::fingerprint(&json!(items))?,
            items.len() as u64,
            items
                .into_iter()
                .filter(|p| p.as_str() > after)
                .take(limit as usize + 1)
                .collect(),
        )
    };
    if let Some(expected) = c.get("expected_digest").filter(|v| !v.is_null())
        && *expected != digest
    {
        return Err(Error::new(
            "VERSION_CONFLICT",
            "Candidate path manifest changed",
        ));
    }
    let has_more = selected.len() > limit as usize;
    let page: Vec<_> = selected.into_iter().take(limit as usize).collect();
    Ok(
        json!({"version":1,"items":page,"next_cursor":if has_more{page.last().cloned()}else{None},"has_more":has_more,"total":total,"digest":digest,"paths_ref":record["paths_ref"]}),
    )
}
