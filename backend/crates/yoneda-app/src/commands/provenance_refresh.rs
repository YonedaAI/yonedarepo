use super::*;

/// Record platform merge-refresh bytes. The caller must validate that this capture job still
/// owns the active lease before invoking this helper; its execution reference is historical.
pub(super) fn capture_file_provenance<S: SqlStore>(
    db: &S,
    job: &Value,
    result: &Value,
    now: i64,
) -> Result<Vec<Value>> {
    if job["kind"] != "capture" {
        return Err(Error::new(
            "FORBIDDEN",
            "File provenance requires a capture job",
        ));
    }
    let payload = &job["payload"];
    let frozen = &payload["candidate"];
    let original_id = string(frozen, "id")?;
    let run_id = string(payload, "run_id")?;
    if frozen["run_id"] != run_id {
        return Err(Error::new(
            "FENCED",
            "Refresh candidate does not match its frozen run",
        ));
    }
    let original = get(db, "candidates", &original_id)?;
    if original["run_id"] != run_id
        || original["execution"] != frozen["execution"]
        || original["revision"] != frozen["revision"]
        || original["base"] != frozen["base"]
    {
        return Err(Error::new("FENCED", "Refresh candidate identity changed"));
    }
    let execution_id = string(&original, "execution")?;
    let execution = get(db, "executions", &execution_id)?;
    if execution["run_id"] != run_id {
        return Err(Error::new(
            "FENCED",
            "Original execution belongs to another run",
        ));
    }
    let subject_id = string(result, "candidate_id")?;
    let revision = result["revision"].clone();
    let commit = hash(&revision, "commit", &[40, 64])?;
    let base_commit = hash(
        &json!({"commit":payload["expected_head"]}),
        "commit",
        &[40, 64],
    )?;
    let capture_epoch = number(job, "epoch")?;
    let declared: std::collections::BTreeSet<String> = result["paths"]
        .as_array()
        .ok_or_else(|| bad("Capture must enumerate changed paths"))?
        .iter()
        .map(|value| {
            let path = value.as_str().ok_or_else(|| bad("Invalid changed path"))?;
            yoneda_core::validate_path(path)?;
            Ok(path.to_owned())
        })
        .collect::<Result<_>>()?;
    let Some(entries) = result["file_provenance"].as_array() else {
        return Ok(Vec::new());
    };
    if entries.len() > MAX_FILE_PROVENANCE_RECEIPTS {
        return Err(Error::new(
            "RESOURCE_LIMIT",
            "File provenance exceeds capture limit",
        ));
    }
    let mut receipts = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        let path = string(entry, "path")?;
        yoneda_core::validate_path(&path)?;
        if !declared.contains(&path) {
            return Err(bad(
                "File receipt path is outside the trusted changed-path list",
            ));
        }
        let change = string(entry, "change")?;
        if !["add", "modify", "rename", "delete"].contains(&change.as_str()) {
            return Err(bad("Unknown file provenance change"));
        }
        let old_path = entry
            .get("old_path")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if let Some(old) = &old_path {
            yoneda_core::validate_path(old)?;
        }
        if change == "rename" && old_path.is_none() {
            return Err(bad("Rename receipt requires its previous path"));
        }
        let old_blob = optional_blob(entry.get("old_blob"))?;
        let new_blob = optional_blob(entry.get("new_blob"))?;
        if (change == "add" && (old_blob.is_some() || new_blob.is_none()))
            || (change == "delete" && (old_blob.is_none() || new_blob.is_some()))
            || (matches!(change.as_str(), "modify" | "rename")
                && (old_blob.is_none() || new_blob.is_none()))
        {
            return Err(bad("File receipt blobs do not match the declared change"));
        }
        let source = match &new_blob {
            Some(blob) => original_source(db, &original_id, &path, blob)?,
            None => None,
        };
        let id = format!("file-receipt:merge-refresh:{subject_id}:{index}");
        let receipt = json!({
            "id":id, "candidate":subject_id, "source_candidate":original_id,
            "subject_id":subject_id, "run_id":run_id, "execution_id":null,
            "execution_epoch":null, "source_execution_id":source.as_ref().map(|s| &s.0),
            "source_execution_epoch":source.as_ref().map(|s| s.1),
            "capture_epoch":capture_epoch, "capture_kind":"merge_refresh",
            "base_commit":base_commit, "commit":commit, "revision":revision,
            "path":path, "old_path":old_path, "change":change,
            "old_blob":old_blob, "new_blob":new_blob,
            "authority":"trusted_capture", "recorded_at":now
        });
        create(
            db,
            "nodes",
            &id,
            &json!({"id":id,"kind":"file_provenance","label":format!("{} {}",change,path),"author":"platform_merge_refresh","recorded_at":now,"data":receipt}),
        )?;
        edge(
            db,
            &id,
            &subject_id,
            "describes_file_change",
            "Worker verified merged Git trees",
        )?;
        if let Some((source_execution, _)) = source {
            edge(
                db,
                &id,
                &source_execution,
                "source_bytes_from",
                "merged blob matches original trusted capture",
            )?;
        }
        receipts.push(receipt);
    }
    Ok(receipts)
}

fn original_source<S: SqlStore>(
    db: &S,
    candidate: &str,
    path: &str,
    blob: &str,
) -> Result<Option<(String, i64)>> {
    for row in db.query("SELECT payload FROM nodes WHERE json_extract(payload,'$.kind')='file_provenance' AND json_extract(payload,'$.data.candidate')=? ORDER BY id", &[json!(candidate)])? {
        let node: Value = serde_json::from_str(row["payload"].as_str().unwrap_or("{}"))
            .map_err(|error| Error::new("DATABASE", error.to_string()))?;
        let data = &node["data"];
        if data["path"] == path && data["new_blob"] == blob {
            let execution = string(data, "execution_id")?;
            let epoch = number(data, "execution_epoch")?;
            return Ok(Some((execution, epoch)));
        }
    }
    Ok(None)
}

pub(super) fn inherited_source_receipt(receipts: &[Value], merged: &Value) -> Option<Value> {
    let candidate = merged["source_candidate"].as_str()?;
    let path = merged["path"].as_str()?;
    let blob = merged["new_blob"].as_str()?;
    let source = receipts.iter().find(|row| {
        row["data"]["candidate"] == candidate
            && row["data"]["path"] == path
            && row["data"]["new_blob"] == blob
    })?;
    let mut data = source["data"].clone();
    data["lineage_relation"] = json!("exact_blob_inherited_by_merge_refresh");
    Some(data)
}
