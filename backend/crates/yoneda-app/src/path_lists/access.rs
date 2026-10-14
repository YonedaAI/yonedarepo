//! Indexed exact-file or frozen directory-prefix membership for root capture.
use super::*;
pub(crate) fn membership<S: SqlStore>(db: &S, c: &Value, record: &Value) -> Result<Value> {
    let path = string(c, "path")?;
    yoneda_core::validate_path(&path)?;
    let r = &record["paths_ref"];
    let id = string(r, "id")?;
    let digest = hash(r, "digest", &[64])?;
    if r.as_object().is_none_or(|o| o.len() != 4)
        || r["version"] != 1
        || id != format!("paths:{digest}")
        || get(db, "source_path_lists", &id)? != *r
        || r["count"].as_u64().is_none_or(|n| n > MAX_PATHS as u64)
    {
        return Err(Error::new("FENCED", "Invalid path manifest reference"));
    }
    if string(c, "expected_digest")? != digest {
        return Err(Error::new(
            "VERSION_CONFLICT",
            "Refresh path manifest changed",
        ));
    }
    let mut params = vec![json!(id), json!(path)];
    for (index, _) in path.match_indices('/') {
        params.push(json!(&path[..=index]));
    }
    let placeholders = std::iter::repeat_n("?", params.len() - 1)
        .collect::<Vec<_>>()
        .join(",");
    let rows=db.query(&format!("SELECT path FROM source_path_entries WHERE list_id=? AND path IN ({placeholders}) LIMIT 1"),&params)?;
    Ok(
        json!({"version":1,"allowed":!rows.is_empty(),"digest":digest,"total":r["count"],"paths_ref":r}),
    )
}
