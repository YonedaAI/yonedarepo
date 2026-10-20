//! Compact API conflict metadata; hydrate only for trusted internal validation.
use super::*;
const EVIDENCE_PATHS: [&str; 4] = [
    "declared_paths",
    "captured_paths",
    "intervening_paths",
    "overlapping_paths",
];
pub(super) fn hydrate<S: SqlStore>(db: &S, record: &Value) -> Result<Value> {
    let mut value = record.clone();
    for key in ["declared_paths", "conflict_paths"] {
        if !value[format!("{key}_ref")].is_null() {
            value[key] = json!(crate::path_lists::load(db, record, key)?);
        }
    }
    for key in EVIDENCE_PATHS {
        if !record["evidence"][format!("{key}_ref")].is_null() {
            value["evidence"][key] = json!(crate::path_lists::load(db, &record["evidence"], key)?);
            // Typed evidence rejects unknown fields; `compact` restores the reference on save.
            if let Some(evidence) = value["evidence"].as_object_mut() {
                evidence.remove(&format!("{key}_ref"));
                evidence.remove(&format!("{key}_count"));
            }
        }
    }
    Ok(value)
}
pub(super) fn compact<S: SqlStore>(db: &S, record: &mut Value) -> Result<()> {
    let run = get(db, "runs", &string(&record["candidate"], "run_id")?)?;
    if run["workspace_transport"] != "api-source-v1" {
        return Ok(());
    }
    for key in ["declared_paths", "conflict_paths", "merged_paths"] {
        if record[key].is_array() {
            crate::path_lists::compact(db, record, key)?;
        }
    }
    for key in EVIDENCE_PATHS {
        if record["evidence"][key].is_array() {
            crate::path_lists::compact(db, &mut record["evidence"], key)?;
        }
        if record["trusted_record"]["evidence"][key].is_array() {
            crate::path_lists::compact(db, &mut record["trusted_record"]["evidence"], key)?;
        }
    }
    if record["trusted_record"]["conflict_paths"].is_array() {
        crate::path_lists::compact(db, &mut record["trusted_record"], "conflict_paths")?;
    }
    if record["request"]["declared_paths"].is_array() {
        crate::path_lists::compact(db, &mut record["request"], "declared_paths")?;
    }
    Ok(())
}
pub(super) fn validate_capture<S: SqlStore>(
    db: &S,
    job: &Value,
    result: &Value,
    now: i64,
) -> Result<()> {
    super::super::capture_source::validate(db, job, result, now)?;
    // The enclosing finish already checks the active lease; this path validates SDK readback.
    let readback = &result["readback"];
    let expected = json!([
        job["payload"]["expected_head"],
        job["payload"]["candidate"]["revision"]["commit"]
    ]);
    if readback["parents"] != expected
        || result["parents"] != expected
        || readback["observed_head"] != job["payload"]["expected_head"]
        || readback["version"] != job["payload"]["expected_version"]
        || readback["candidate_commit"] != result["revision"]["commit"]
        || readback["captured_paths"] != result["paths"]
        || readback["resolver_delta_paths"] != result["resolver_delta_paths"]
    {
        return Err(Error::new(
            "INVALID_CONFLICT_RESULT",
            "API resolver differs from trusted Git readback",
        ));
    }
    Ok(())
}
pub(super) fn paths<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    super::support::owner(c)?;
    let id = string(c, "conflict_id")?;
    let section = string(c, "section")?;
    let record = get(db, "conflicts", &id)?;
    let source = match section.as_str() {
        "conflict_paths" | "declared_paths" | "merged_paths" => &record,
        "captured_paths" | "intervening_paths" | "overlapping_paths" => &record["evidence"],
        _ => return Err(bad("Unknown conflict path section")),
    };
    let reference = source
        .get(format!("{section}_ref"))
        .cloned()
        .unwrap_or(Value::Null);
    if !reference.is_object() && !source[&section].is_array() {
        return Err(Error::new(
            "SOURCE_PATHS_UNAVAILABLE",
            "Conflict path evidence is not yet available",
        ));
    }
    let input = json!({"paths":source[&section],"paths_ref":reference});
    let mut page = crate::path_lists::page_record(db, c, &input)?;
    page["conflict_id"] = json!(id);
    page["section"] = json!(section);
    Ok(page)
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::recovery::source_tests as f;
    #[test]
    fn owner_conflict_pages_preserve_refs_and_missing_sections_are_not_empty() {
        let db = f::fixture();
        let reference = crate::path_lists::persist(&db, &json!(["src/a.rs", "src/z.rs"])).unwrap();
        save(&db,"conflicts","conflict",&json!({"id":"conflict","conflict_paths_ref":reference,"evidence":{"overlapping_paths_ref":reference}})).unwrap();
        let request = json!({"op":"conflict_paths","conflict_id":"conflict","section":"conflict_paths","limit":1,"expected_digest":reference["digest"]});
        let first = f::call(&db, request.clone(), 1000).unwrap();
        assert_eq!(first["items"], json!(["src/a.rs"]));
        assert_eq!(first["total"], 2);
        let mut second = request.clone();
        second["after"] = first["next_cursor"].clone();
        assert_eq!(
            f::call(&db, second, 1000).unwrap()["items"],
            json!(["src/z.rs"])
        );
        let mut missing = request.clone();
        missing["section"] = json!("merged_paths");
        assert_eq!(
            f::call(&db, missing, 1000).unwrap_err().code,
            "SOURCE_PATHS_UNAVAILABLE"
        );
        let mut wrong = request.clone();
        wrong["expected_digest"] = json!("0".repeat(64));
        assert_eq!(
            f::call(&db, wrong, 1000).unwrap_err().code,
            "VERSION_CONFLICT"
        );
        let mut agent = request;
        agent["job_id"] = json!("job:execution");
        agent["epoch"] = json!(0);
        assert_eq!(f::call(&db, agent, 1000).unwrap_err().code, "FORBIDDEN");
        let overlap = f::call(
            &db,
            json!({"op":"conflict_paths","conflict_id":"conflict","section":"overlapping_paths"}),
            1000,
        )
        .unwrap();
        assert_eq!(overlap["items"], json!(["src/a.rs", "src/z.rs"]));
    }
}
