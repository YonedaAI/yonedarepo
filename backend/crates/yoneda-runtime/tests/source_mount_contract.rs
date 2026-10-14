#![allow(dead_code)]
#[path = "../src/source_client.rs"]
mod source_client;
#[path = "../src/source_workspace_job.rs"]
mod source_workspace_job;
use serde_json::{Value, json};
fn job() -> Value {
    json!({"kind":"agent","payload":{"workspace_transport":"api-source-v1","execution":{"team_role":"builder"}},"source_mounts":[{"path":"repo","workspace_id":format!("source-workspace:{}","a".repeat(64)),"base":{"repository":"repo","commit":"1".repeat(40),"tree":"2".repeat(40)},"view_digest":"b".repeat(64),"access":"read_write"}]})
}
fn review(indices: &[usize]) -> Value {
    let mut job = job();
    job["payload"]["comparison_review"] = json!(true);
    job["payload"]["review_only"] = json!(true);
    job["payload"]["execution"]["comparison_role"] = json!("reviewer");
    job["payload"]["execution"]["comparison_approval_id"] = json!("approval");
    job["payload"]["run"]["comparison"]["approval"]["id"] = json!("approval");
    let alternatives: Vec<_> = (0..2).map(|index| {
        if indices.contains(&index) {
            json!({"agent_index":index,"candidate_id":format!("candidate-{index}"),"revision":{"repository":format!("repo-{index}"),"commit":"1".repeat(40)}})
        } else { json!({"agent_index":index,"candidate_id":null,"status":"failed"}) }
    }).collect();
    let manifest = json!({"version":1,"alternatives":alternatives});
    job["payload"]["comparison_manifest"] = json!({"version":1,"approval_id":"approval","manifest_digest":yoneda_core::fingerprint(&manifest).unwrap(),"manifest":manifest});
    let mounts: Vec<_> = indices.iter().enumerate().map(|(ordinal,index)| {
        json!({"path":format!("candidate-{ordinal}"),"workspace_id":format!("source-workspace:{}", char::from(b'a'+ordinal as u8).to_string().repeat(64)),"base":{"repository":format!("repo-{index}"),"commit":"1".repeat(40),"tree":"2".repeat(40)},"view_digest":"b".repeat(64),"access":"read_only","scratch_paths":[]})
    }).collect();
    job["source_mounts"] = json!(mounts);
    job
}
#[test]
fn zero_captured_alternatives_allow_only_authenticated_empty_review_not_normal_agent() {
    assert!(
        source_workspace_job::mounts(&review(&[]))
            .unwrap()
            .is_empty()
    );
    let mut normal = job();
    normal["source_mounts"] = json!([]);
    assert_eq!(
        source_workspace_job::mounts(&normal).unwrap_err().code,
        "SOURCE_INDEX_PENDING"
    );
    let mut forged = review(&[]);
    forged["payload"]["review_only"] = json!(false);
    assert!(source_workspace_job::mounts(&forged).is_err());
    forged = review(&[]);
    forged["payload"]["comparison_manifest"]["manifest_digest"] = json!("f".repeat(64));
    assert!(source_workspace_job::mounts(&forged).is_err());
}
#[test]
fn one_capture_from_second_builder_uses_dense_candidate_zero_readonly() {
    let job = review(&[1]);
    let mounts = source_workspace_job::mounts(&job).unwrap();
    assert_eq!(mounts.len(), 1);
    assert_eq!(mounts[0].path, "candidate-0");
    assert_eq!(mounts[0].base.repository, "repo-1");
}
#[test]
fn captured_manifest_denies_missing_extra_foreign_and_mutable_mounts() {
    let valid = review(&[0, 1]);
    assert_eq!(source_workspace_job::mounts(&valid).unwrap().len(), 2);
    for (key, value) in [
        ("path", json!("repo")),
        ("access", json!("read_write")),
        ("scratch_paths", json!(["target/"])),
    ] {
        let mut bad = valid.clone();
        bad["source_mounts"][0][key] = value;
        assert!(source_workspace_job::mounts(&bad).is_err());
    }
    let mut bad = valid.clone();
    bad["source_mounts"][0]["base"]["repository"] = json!("foreign");
    assert!(source_workspace_job::mounts(&bad).is_err());
    bad = valid.clone();
    bad["source_mounts"].as_array_mut().unwrap().pop();
    assert!(source_workspace_job::mounts(&bad).is_err());
    bad = review(&[1]);
    bad["source_mounts"][0]["path"] = json!("candidate-1");
    assert!(source_workspace_job::mounts(&bad).is_err());
    bad = review(&[]);
    bad["source_mounts"] = valid["source_mounts"].clone();
    assert!(source_workspace_job::mounts(&bad).is_err());
}
#[test]
fn old_transport_missing_index_and_model_selected_identity_fail_before_launch() {
    let mut old = job();
    old["payload"]["workspace_transport"] = json!("git-native-v1");
    assert!(!source_workspace_job::enabled(&old));
    assert_eq!(
        source_workspace_job::mounts(&old).unwrap_err().code,
        "SOURCE_TRANSPORT"
    );
    let mut pending = job();
    pending["source_mounts"] = Value::Null;
    assert_eq!(
        source_workspace_job::mounts(&pending).unwrap_err().code,
        "SOURCE_INDEX_PENDING"
    );
    let mut forged = job();
    forged["source_mounts"][0]["path"] = json!("../outside");
    assert_eq!(
        source_workspace_job::mounts(&forged).unwrap_err().code,
        "SOURCE_SCOPE"
    );
    assert_eq!(source_workspace_job::mounts(&job()).unwrap().len(), 1);
}
#[test]
fn reviewer_requires_two_separate_readonly_authorized_candidate_descriptors() {
    let mut reviewer = review(&[0, 1]);
    reviewer["source_mounts"][0]["access"] = json!("read_write");
    assert_eq!(
        source_workspace_job::mounts(&reviewer).unwrap_err().code,
        "SOURCE_SCOPE"
    );
    reviewer["source_mounts"][0]["access"] = json!("read_only");
    assert_eq!(source_workspace_job::mounts(&reviewer).unwrap().len(), 2);
    reviewer["source_mounts"][1]["access"] = json!("read_write");
    assert_eq!(
        source_workspace_job::mounts(&reviewer).unwrap_err().code,
        "SOURCE_SCOPE"
    );
}
#[test]
fn evaluation_requires_exact_capture_readonly_and_cannot_use_agent_entry() {
    let mut evaluate = job();
    evaluate["kind"] = json!("evaluate");
    evaluate["source_mounts"][0]["access"] = json!("read_only");
    evaluate["payload"]["candidate"]["revision"] =
        json!({"repository":"repo","commit":"1".repeat(40)});
    assert_eq!(
        source_workspace_job::mounts(&evaluate).unwrap_err().code,
        "SOURCE_SCOPE"
    );
    assert!(source_workspace_job::evaluation_mounts(&evaluate).is_ok());
    evaluate["source_mounts"][0]["base"]["commit"] = json!("3".repeat(40));
    assert_eq!(
        source_workspace_job::evaluation_mounts(&evaluate)
            .unwrap_err()
            .code,
        "SOURCE_FENCED"
    );
}
