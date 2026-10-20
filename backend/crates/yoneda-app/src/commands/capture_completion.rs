//! Trusted capture creates final candidates or intermediate team handoffs.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_agents_core::Result;
pub(super) fn complete<S: SqlStore>(db: &S, j: &Value, result: &Value, now: i64) -> Result<()> {
    let source_lineage = super::capture_source::validate(db, j, result, now)?;
    super::comparison::validate_capture(db, j, result)?;
    let cid = string(result, "id")?;
    let execution = &j["payload"]["execution"];
    let eid = string(execution, "id")?;
    let run_id = string(execution, "run_id")?;
    hash(&result["revision"], "commit", &[40, 64])?;
    string(&result["revision"], "repository")?;
    hash(result, "tree", &[40, 64])?;
    let paths = result["paths"]
        .as_array()
        .ok_or_else(|| bad("Capture must enumerate changed paths"))?;
    for path in paths {
        yoneda_agents_core::validate_path(
            path.as_str().ok_or_else(|| bad("Invalid changed path"))?,
        )?;
    }
    if result.get("file_provenance").is_some() {
        super::history::capture_file_provenance(db, j, result, now)?;
    }
    if super::team::captured(db, j, result, now)? {
        return Ok(());
    }
    let mut candidate = json!({"id":cid,"execution":eid,"run_id":run_id,"base":j["payload"]["base"],"revision":result["revision"],"tree":result["tree"],"paths":paths,"summary":result["summary"],"status":"evaluating","capture_job":j["id"]});
    if let Some(lineage) = source_lineage {
        candidate["source_lineage"] = lineage;
    }
    // Hosted capture stores the diff in R2 before submitting this digest. Legacy
    // native completion fixtures may omit it; inline source never enters the candidate/job.
    if result.get("diff_digest").is_some() {
        candidate["diff_digest"] = json!(hash(result, "diff_digest", &[64])?.to_ascii_lowercase());
    }
    if let Some(manifest) = j["payload"].get("integration_manifest") {
        candidate["integration_manifest"] = manifest.clone();
        candidate["integration_digest"] = j["payload"]["integration_digest"].clone();
    }
    if j["payload"]["workspace_transport"] == "api-source-v1" {
        crate::path_lists::compact(db, &mut candidate, "paths")?;
    }
    create(db, "candidates", &cid, &candidate)?;
    node(
        db,
        &cid,
        "candidate",
        result["summary"].as_str().unwrap_or("Candidate"),
        "platform_capture",
        now,
        candidate.clone(),
    )?;
    edge(db, &eid, &cid, "produced_by", "independent source capture")?;
    let mut e = get(db, "executions", &eid)?;
    e["status"] = json!("evaluating");
    save_execution(db, &e, now)?;
    // Coding keeps its approved brief, while eligibility must use current
    // owner policy even if that policy changed before capture existed.
    let policy = repo(db)?["policy"].clone();
    let mut payload = json!({"candidate":candidate,"run_id":run_id,"policy":policy});
    if j["payload"]["workspace_transport"] == "api-source-v1" {
        payload["source_integrity"] =
            crate::path_lists::integrity::fields(db, &candidate, &policy)?;
    }
    job(db, &format!("evaluate:{cid}"), "evaluate", now, payload)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::NativeStore;

    #[test]
    fn megabyte_capture_diff_does_not_expand_evaluator_job_or_candidate_ledger() {
        let db = NativeStore::memory().unwrap();
        crate::execute(
            &db,
            json!({"op":"init","now":1000,"id":"transport","name":"Transport fixture",
            "remote":{"namespace":"test","name":"transport"},"commit":"a".repeat(40),
            "policy":yoneda_agents_core::Policy::default()}),
        )
        .unwrap();
        let execution = json!({"id":"execution","run_id":"run","status":"capturing"});
        create(&db, "executions", "execution", &execution).unwrap();
        let job = json!({"id":"capture","payload":{"execution":execution,"base":{"repository":"test/transport","commit":"a".repeat(40)}}});
        let diff = "x".repeat(1024 * 1024 + 1);
        let digest = yoneda_agents_core::digest(diff.as_bytes());
        let result = json!({"id":"candidate","revision":{"repository":"test/fork","commit":"b".repeat(40)},
            "tree":"c".repeat(40),"paths":["large.txt"],"diff":diff,"diff_digest":digest,"summary":"Large candidate"});
        complete(&db, &job, &result, 1000).unwrap();
        let candidate = get(&db, "candidates", "candidate").unwrap();
        let evaluator = get(&db, "jobs", "evaluate:candidate").unwrap();
        assert!(
            evaluator.to_string().len() < 1024 * 1024,
            "Evaluator job exceeds supervisor 1 MiB body limit"
        );
        assert!(
            candidate.get("diff").is_none(),
            "Candidate ledger must contain only the immutable pointer"
        );
        assert_eq!(candidate["diff_digest"], digest);
        assert_eq!(
            evaluator["payload"]["candidate"]["revision"],
            result["revision"]
        );
    }
}

#[test]
fn api_large_capture_keeps_candidate_and_evaluator_small_and_checks_protected_ancestors() {
    let db = crate::commands::recovery::source_tests::fixture();
    let paths = json!(
        (0..10000)
            .map(|i| format!("{i:04}/{}/{}", "x".repeat(240), "y".repeat(240)))
            .chain(["tests".to_owned()])
            .collect::<Vec<_>>()
    );
    let mut policy = crate::storage::repo(&db).unwrap()["policy"].clone();
    policy["build"] = json!({"test_bundle":{"protected_paths":["tests/immutable.rs"]}});
    let mut repo = crate::storage::repo(&db).unwrap();
    repo["policy"] = policy.clone();
    crate::storage::save(&db, "repository", "repo", &repo).unwrap();
    let job = json!({"id":"capture","payload":{"workspace_transport":"api-source-v1","execution":{"id":"execution","run_id":"run"},"base":{"repository":"test/source","commit":"a".repeat(40)}}});
    let result = json!({"id":"large","revision":{"repository":"test/captured","commit":"c".repeat(40)},"tree":"d".repeat(40),"paths":paths,"summary":"Large delta"});
    crate::commands::capture_completion::complete(&db, &job, &result, 1000).unwrap();
    let candidate = crate::storage::get(&db, "candidates", "large").unwrap();
    let evaluator = crate::storage::get(&db, "jobs", "evaluate:large").unwrap();
    assert!(
        candidate.to_string().len() < 2048,
        "candidate must not store a multimegabyte path array"
    );
    assert!(
        evaluator.to_string().len() < 1024 * 1024,
        "job exceeds supervisor payload cap"
    );
    assert_eq!(
        crate::path_lists::load(&db, &candidate, "paths")
            .unwrap()
            .len(),
        10001
    );
    assert_eq!(
        evaluator["payload"]["source_integrity"]["protected_changes"],
        json!(["tests/immutable.rs"])
    );
    assert_eq!(
        evaluator["payload"]["source_integrity"]["paths_digest"],
        candidate["paths_ref"]["digest"]
    );
}
