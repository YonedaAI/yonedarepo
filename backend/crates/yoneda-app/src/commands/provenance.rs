use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

const MAX_FILE_PROVENANCE_RECEIPTS: usize = 10_000;

#[path = "provenance_refresh.rs"]
mod refresh;

/// Persist Worker-verified blob receipts tied to the live capture lease and revision.
#[allow(dead_code)] // Lead-owned capture_completion calls this after candidate creation.
pub(in crate::commands) fn capture_file_provenance<S: SqlStore>(
    db: &S,
    job: &Value,
    result: &Value,
    now: i64,
) -> Result<Vec<Value>> {
    if job["payload"]["capture_subtype"] == "refresh_candidate"
        || job["payload"]["subtype"] == "refresh_candidate"
    {
        return refresh::capture_file_provenance(db, job, result, now);
    }
    if job["kind"] != "capture" {
        return Err(Error::new(
            "FORBIDDEN",
            "File provenance requires a capture job",
        ));
    }
    let execution = &job["payload"]["execution"];
    let execution_id = string(execution, "id")?;
    let run_id = string(execution, "run_id")?;
    let live_execution = get(db, "executions", &execution_id)?;
    if live_execution["epoch"] != execution["epoch"]
        || live_execution["run_id"] != run_id
        || live_execution["status"] != "capturing"
    {
        return Err(Error::new("FENCED", "Capture execution identity changed"));
    }
    let capture_result_id = string(result, "id")?;
    let team_handoff = execution["team_task"].is_string() && execution["team_role"] != "integrator";
    let subject_id = if team_handoff {
        format!(
            "handoff:{}:{}",
            string(execution, "team_task")?,
            number(execution, "team_task_revision")?
        )
    } else {
        capture_result_id.clone()
    };
    let revision = result["revision"].clone();
    let commit = hash(&revision, "commit", &[40, 64])?;
    let base_commit = hash(&job["payload"]["base"], "commit", &[40, 64])?;
    let capture_epoch = number(job, "epoch")?;
    let execution_epoch = number(execution, "epoch")?;
    let declared: std::collections::BTreeSet<String> = result["paths"]
        .as_array()
        .ok_or_else(|| bad("Capture must enumerate changed paths"))?
        .iter()
        .map(|v| {
            let path = v.as_str().ok_or_else(|| bad("Invalid changed path"))?;
            yoneda_core::validate_path(path)?;
            Ok(path.to_owned())
        })
        .collect::<Result<_>>()?;
    let Some(entries) = result["file_provenance"].as_array() else {
        // Old captures remain inspectable but their per-file coverage is explicitly unknown.
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
        if !declared.contains(&path) && !old_path.as_ref().is_some_and(|old| declared.contains(old))
        {
            return Err(bad(
                "File receipt path is outside the trusted changed-path list",
            ));
        }
        let old_blob = optional_blob(entry.get("old_blob"))?;
        let new_blob = optional_blob(entry.get("new_blob"))?;
        if (change == "add" && (old_blob.is_some() || new_blob.is_none()))
            || (change == "delete" && (old_blob.is_none() || new_blob.is_some()))
            || (matches!(change.as_str(), "modify" | "rename")
                && (old_blob.is_none() || new_blob.is_none()))
            || (change == "rename" && old_path.is_none())
        {
            return Err(bad("File receipt blobs do not match the declared change"));
        }
        let receipt = json!({
            "id":format!("file-receipt:{subject_id}:{index}"),
            "candidate":if team_handoff { Value::Null } else { json!(capture_result_id) },
            "handoff_id":if team_handoff { json!(subject_id) } else { Value::Null },
            "subject_id":subject_id,
            "run_id":run_id, "task_id":execution["team_task"], "execution_id":execution_id,
            "execution_epoch":execution_epoch, "capture_epoch":capture_epoch,
            "task_revision":execution["team_task_revision"],
            "capture_kind":if team_handoff && execution["team_task_revision"].as_i64().is_some_and(|revision| revision > 1) { "repair" } else if team_handoff { "task_handoff" } else if execution["team_role"] == "integrator" { "team_integration" } else if execution["team_task_revision"].as_i64().is_some_and(|revision| revision > 1) { "repair" } else { "candidate" },
            "base_commit":base_commit, "commit":commit, "revision":revision,
            "path":path, "old_path":old_path, "change":change,
            "old_blob":old_blob, "new_blob":new_blob,
            "authority":"trusted_capture", "recorded_at":now
        });
        let id = string(&receipt, "id")?;
        create(
            db,
            "nodes",
            &id,
            &json!({"id":id,"kind":"file_provenance","label":format!("{} {}",change,path),"author":"platform_capture","recorded_at":now,"data":receipt}),
        )?;
        edge(
            db,
            &id,
            &subject_id,
            "describes_file_change",
            "Worker verified captured Git trees",
        )?;
        edge(
            db,
            &id,
            &execution_id,
            "captured_from",
            "execution and capture lease identity",
        )?;
        receipts.push(receipt);
    }
    Ok(receipts)
}

fn optional_blob(value: Option<&Value>) -> Result<Option<String>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(v) => Ok(Some(hash(&json!({"blob":v}), "blob", &[40, 64])?)),
    }
}

#[allow(dead_code)] // Called by the lead-owned acceptance command during integration.
pub(in crate::commands) fn link_file_provenance_to_decision<S: SqlStore>(
    db: &S,
    decision: &Value,
    _now: i64,
) -> Result<()> {
    let candidate = string(decision, "candidate")?;
    for row in db.query("SELECT id,payload FROM nodes WHERE json_extract(payload,'$.kind')='file_provenance' AND json_extract(payload,'$.data.candidate')=? ORDER BY id", &[json!(candidate)])? {
        let id = string(&row, "id")?;
        edge(db, &string(decision, "id")?, &id, "selected_file_provenance", "owner selected this captured revision")?;
    }
    Ok(())
}

#[allow(dead_code)] // Called from publication readback after canonical Git HEAD is verified.
pub(in crate::commands) fn link_file_provenance_to_publication<S: SqlStore>(
    db: &S,
    decision: &Value,
    observed_commit: &str,
) -> Result<()> {
    if observed_commit != decision["target"]["commit"].as_str().unwrap_or_default() {
        return Err(Error::new(
            "PUBLICATION_MISMATCH",
            "Published commit differs from the selected decision",
        ));
    }
    let candidate = string(decision, "candidate")?;
    for row in db.query("SELECT id,payload FROM nodes WHERE json_extract(payload,'$.kind')='file_provenance' AND json_extract(payload,'$.data.candidate')=? ORDER BY id", &[json!(candidate)])? {
        let id = string(&row, "id")?;
        edge(db, &string(decision, "id")?, &id, "published_file_provenance", "canonical Git HEAD independently read back")?;
    }
    Ok(())
}

pub(super) fn why<S: SqlStore>(
    db: &S,
    requested_commit: &str,
    requested_path: &str,
) -> Result<Value> {
    let candidates = all(db, "candidates")?;
    let receipt_rows = db.query("SELECT payload FROM nodes WHERE json_extract(payload,'$.kind')='file_provenance' ORDER BY id LIMIT 10001", &[])?;
    let receipt_scan_truncated = receipt_rows.len() > MAX_FILE_PROVENANCE_RECEIPTS;
    let receipts: Vec<Value> = receipt_rows
        .iter()
        .take(MAX_FILE_PROVENANCE_RECEIPTS)
        .map(|row| {
            serde_json::from_str(row["payload"].as_str().unwrap_or("{}"))
                .map_err(|e| Error::new("DATABASE", e.to_string()))
        })
        .collect::<Result<_>>()?;
    let mut commit = requested_commit.to_owned();
    let mut path = requested_path.to_owned();
    let mut seen = std::collections::BTreeSet::new();
    let mut lineage = Vec::new();
    let mut status = "unknown";
    for _ in 0..64 {
        if !seen.insert((commit.clone(), path.clone())) {
            break;
        }
        let mut matches: Vec<_> = candidates
            .iter()
            .filter(|c| c["revision"]["commit"] == commit)
            .collect();
        matches.sort_by_key(|c| c["recorded_at"].as_i64().unwrap_or_default());
        let Some(candidate) = matches.pop() else {
            break;
        };
        let candidate_id = string(candidate, "id")?;
        let receipt = receipts.iter().find(|r| {
            r["data"]["candidate"] == candidate_id
                && (r["data"]["path"] == path || r["data"]["old_path"] == path)
        });
        if let Some(row) = receipt {
            let mut item = row["data"].clone();
            item["candidate_summary"] = candidate["summary"].clone();
            if item["capture_kind"].is_null() {
                item["capture_kind"] = candidate["capture_kind"].clone();
            }
            lineage.push(item.clone());
            if let Some(inherited) = refresh::inherited_source_receipt(&receipts, &item)
                && !lineage.iter().any(|known| known["id"] == inherited["id"])
            {
                lineage.push(inherited);
            }
            // Attribute integrated bytes to specialist captures only when the trusted blob
            // identity and path match within this same run.
            let output_blob = item["new_blob"].as_str();
            for handoff in receipts.iter().filter(|r| {
                r["data"]["run_id"] == candidate["run_id"]
                    && r["data"]["handoff_id"].is_string()
                    && r["data"]["path"] == item["path"]
                    && output_blob.is_some_and(|blob| r["data"]["new_blob"] == blob)
            }) {
                if !lineage.iter().any(|known| known["id"] == handoff["id"]) {
                    lineage.push(handoff["data"].clone());
                }
            }
            status = if item["change"] == "delete" {
                "deleted"
            } else {
                "recorded"
            };
            if item["change"] == "add" || item["change"] == "delete" {
                break;
            }
            if item["change"] == "rename" {
                path = string(&item, "old_path")?;
            }
        }
        let base = candidate["base"]["commit"].as_str().unwrap_or_default();
        if base.is_empty() || base == commit {
            break;
        }
        commit = base.to_owned();
    }
    if lineage.is_empty() {
        return Ok(
            json!({"coverage":"unknown","status":"unknown","path":requested_path,"commit":requested_commit,"lineage":[],"decisions":[],"rejected_alternatives":[],"nodes":[],"edges":[],"bounded":true,"truncated":receipt_scan_truncated}),
        );
    }
    let candidate_ids: std::collections::BTreeSet<String> = lineage
        .iter()
        .filter_map(|r| r["candidate"].as_str().map(str::to_owned))
        .collect();
    let all_decisions = all(db, "decisions")?;
    let decisions: Vec<_> = all_decisions
        .iter()
        .filter(|d| candidate_ids.contains(d["candidate"].as_str().unwrap_or_default()))
        .cloned()
        .collect();
    let rejected: Vec<_> = decisions
        .iter()
        .flat_map(|decision| {
            decision["alternatives"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|alternative| {
                    json!({
                        "decision":decision["id"],
                        "candidate":alternative["candidate"],
                        "reason":alternative["reason"]
                    })
                })
        })
        .collect();
    let mut nodes = lineage.clone();
    nodes.extend(decisions.iter().cloned());
    Ok(
        json!({"coverage":"recorded","status":status,"path":requested_path,"commit":requested_commit,"lineage":lineage,"decisions":decisions,"rejected_alternatives":rejected,"nodes":nodes,"edges":[],"bounded":true,"truncated":receipt_scan_truncated}),
    )
}

#[cfg(test)]
#[path = "provenance_tests.rs"]
mod tests;
