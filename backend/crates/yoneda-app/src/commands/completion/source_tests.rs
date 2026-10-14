use super::*;
use crate::commands::recovery::source_tests as f;
use crate::source_workspace;
use yoneda_core::source_workspace::{SourceRevision, SourceView};
pub(super) const KEY: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
pub(super) fn registered(db: &crate::native::NativeStore) -> Value {
    let base = SourceRevision {
        repository: "test/source".into(),
        commit: "a".repeat(40),
        tree: "b".repeat(40),
    };
    let view = SourceView {
        version: 1,
        base,
        files: vec![],
    };
    let bound=f::call(db,json!({"op":"source_bind","job_id":"job:execution","epoch":1,"_source_view":view,"_supervisor":true,"_source_signing_key":KEY}),1000).unwrap();
    let source = crate::native::NativeStore::memory().unwrap();
    let actor = bound["actor_grant"].clone();
    let call = |mut c: Value| {
        c["now"] = json!(1000);
        c["_source_signing_key"] = json!(KEY);
        c["_actor"] = actor.clone();
        source_workspace::execute_source_workspace(&source, c)
    };
    call(json!({"op":"source_init","request_id":"init","binding":bound["binding"],"view":view,"baseline_overrides":[]})).unwrap();
    let checkpoint = call(
        json!({"op":"source_checkpoint","request_id":"checkpoint","expected_workspace_version":0}),
    )
    .unwrap();
    let seal=call(json!({"op":"source_seal","request_id":"seal","expected_workspace_version":0,"checkpoint_id":checkpoint["checkpoint_id"],"expected_checkpoint_digest":checkpoint["changeset_digest"]})).unwrap();
    f::call(db,json!({"op":"source_register_changeset","job_id":"job:execution","epoch":1,"request_id":"register","view_digest":bound["binding"]["view_digest"],"_source_seal":seal,"_source_signing_key":KEY}),1000).unwrap()
}
pub(super) fn pointer(r: &Value) -> Value {
    json!({"producer_job_id":"job:execution","producer_epoch":1,"registration_id":r["registration_id"],"changeset_digest":r["changeset_digest"]})
}
#[test]
fn api_agent_completion_uses_registered_seal_compact_refs_and_rejects_forged_pointer() {
    let db = f::fixture();
    f::call(&db, json!({"op":"claim","job_id":"job:execution"}), 1000).unwrap();
    let reg = registered(&db);
    let mut input = json!({"op":"finish","job_id":"job:execution","epoch":1,"result":{"source_verified":true,"source_registered":pointer(&reg)}});
    input["result"]["source_registered"]["producer_epoch"] = json!(2);
    assert_eq!(
        f::call(&db, input.clone(), 1000).unwrap_err().code,
        "INVALID_CAPTURE"
    );
    assert!(get(&db, "jobs", "capture:execution").is_err());
    input["result"]["source_registered"] = pointer(&reg);
    input["result"]["source_workspace"] = json!({"ignored_raw_data":"x".repeat(2*1024*1024)});
    f::call(&db, input, 1000).unwrap();
    let capture = get(&db, "jobs", "capture:execution").unwrap();
    assert_eq!(capture["payload"]["capture_subtype"], "source_changeset");
    assert_eq!(capture["payload"]["source_registered"], pointer(&reg));
    assert!(capture["payload"].get("workspace").is_none());
    assert!(capture.to_string().len() < 1024 * 1024);
    let context = f::call(
        &db,
        json!({"op":"claim","job_id":"capture:execution"}),
        1000,
    )
    .unwrap();
    assert_eq!(context["kind"], "capture");
}
#[test]
fn api_capture_completion_checks_registered_lineage_and_propagates_readonly_evaluation() {
    let db = f::fixture();
    f::call(&db, json!({"op":"claim","job_id":"job:execution"}), 1000).unwrap();
    let reg = registered(&db);
    f::call(&db,json!({"op":"finish","job_id":"job:execution","epoch":1,"result":{"source_verified":true,"source_registered":pointer(&reg)}}),1000).unwrap();
    f::call(
        &db,
        json!({"op":"claim","job_id":"capture:execution"}),
        1000,
    )
    .unwrap();
    let b = &reg["binding"];
    let lineage = json!({"version":1,"authority":"registered_source_changeset","workspace_id":b["workspace_id"],"registration_id":reg["registration_id"],"producer_job_id":"job:execution","producer_epoch":1,"seal_id":reg["seal_id"],"checkpoint_id":reg["checkpoint_id"],"changeset_digest":reg["changeset_digest"],"view_digest":b["view_digest"],"baseline_overrides_digest":b["baseline_overrides_digest"]});
    let mut result = json!({"id":"candidate","revision":{"repository":"test/captured","commit":"c".repeat(40)},"tree":"d".repeat(40),"parents":b["parents"],"paths":[],"summary":"Checked source capture","source_verified":true,"source_lineage":lineage,"source_changeset_digest":reg["changeset_digest"],"source_manifest_digest":reg["changeset_digest"]});
    result["source_lineage"]["producer_epoch"] = json!(99);
    assert_eq!(
        f::call(
            &db,
            json!({"op":"finish","job_id":"capture:execution","epoch":1,"result":result}),
            1000
        )
        .err()
        .map(|e| e.code)
        .unwrap_or_default(),
        "INVALID_CAPTURE"
    );
    assert!(get(&db, "candidates", "candidate").is_err());
    result["source_lineage"]["producer_epoch"] = json!(1);
    f::call(
        &db,
        json!({"op":"finish","job_id":"capture:execution","epoch":1,"result":result}),
        1000,
    )
    .unwrap();
    let candidate = get(&db, "candidates", "candidate").unwrap();
    assert_eq!(candidate["source_lineage"], lineage);
    let evaluator = f::call(
        &db,
        json!({"op":"claim","job_id":"evaluate:candidate"}),
        1000,
    )
    .unwrap();
    assert_eq!(evaluator["payload"]["workspace_transport"], "api-source-v1");
    let context = f::call(
        &db,
        json!({"op":"source_read_context","job_id":"evaluate:candidate","epoch":1}),
        1000,
    )
    .unwrap();
    assert_eq!(context["role"], "evaluator");
    assert_eq!(context["access"], "read_only");
    assert_eq!(context["base"]["commit"], "c".repeat(40));
}
#[test]
fn api_resolver_completion_retains_source_changeset_and_resolution_route() {
    let db = f::fixture();
    let mut e = get(&db, "executions", "execution").unwrap();
    e["conflict_id"] = json!("conflict");
    e["conflict_paths"] = json!(["conflict.rs"]);
    save(&db, "executions", "execution", &e).unwrap();
    let candidate = json!({"id":"old","run_id":"run","base":e["base"],"revision":{"repository":"test/candidate","commit":"f".repeat(40)},"tree":"b".repeat(40)});
    let record = json!({"id":"conflict","status":"resolving","resolver_job_id":"job:execution","resolver_execution_id":"execution","target_revision":e["base"],"head_commit":e["base"]["commit"],"expected_version":0,"expected_head_tree":"b".repeat(40),"candidate":candidate,"candidate_revision":"f".repeat(40),"workspace_revision":{"repository":"test/merge","commit":"e".repeat(40)},"merge_workspace_commit":"e".repeat(40),"merge_tree":"b".repeat(40),"merged_paths":[],"conflict_paths":["conflict.rs"]});
    save(&db, "conflicts", "conflict", &record).unwrap();
    let mut j = get(&db, "jobs", "job:execution").unwrap();
    j["payload"]["execution"] = e;
    j["payload"]["conflict_resolver"] = json!({"conflict_id":"conflict","candidate":candidate,"expected_head":record["head_commit"],"expected_version":0,"merge_workspace_revision":record["workspace_revision"]});
    save(&db, "jobs", "job:execution", &j).unwrap();
    f::call(&db, json!({"op":"claim","job_id":"job:execution"}), 1000).unwrap();
    let reg = registered(&db);
    f::call(&db,json!({"op":"finish","job_id":"job:execution","epoch":1,"result":{"source_verified":true,"source_registered":pointer(&reg)}}),1000).unwrap();
    let capture = get(&db, "jobs", "capture:execution").unwrap();
    assert_eq!(capture["payload"]["capture_subtype"], "source_changeset");
    assert_eq!(capture["payload"]["source_resolution"], true);
    assert_eq!(capture["payload"]["source_registered"], pointer(&reg));
    let leased = f::call(
        &db,
        json!({"op":"claim","job_id":"capture:execution"}),
        1000,
    )
    .unwrap();
    let b = &reg["binding"];
    let lineage = json!({"version":1,"authority":"registered_source_changeset","workspace_id":b["workspace_id"],"registration_id":reg["registration_id"],"producer_job_id":"job:execution","producer_epoch":1,"seal_id":reg["seal_id"],"checkpoint_id":reg["checkpoint_id"],"changeset_digest":reg["changeset_digest"],"view_digest":b["view_digest"],"baseline_overrides_digest":b["baseline_overrides_digest"]});
    let mut result = json!({"id":"resolved","revision":{"repository":"test/resolved","commit":"c".repeat(40)},"tree":"d".repeat(40),"parents":b["parents"],"paths":["clean.rs","conflict.rs"],"resolver_delta_paths":["conflict.rs"],"summary":"Preserved clean merge","source_verified":true,"source_lineage":lineage,"source_changeset_digest":reg["changeset_digest"],"source_manifest_digest":reg["changeset_digest"],"readback":{"observed_head":record["head_commit"],"version":0,"parents":b["parents"],"candidate_commit":"c".repeat(40),"captured_paths":["clean.rs","conflict.rs"],"resolver_delta_paths":["conflict.rs"]}});
    result["readback"]["parents"] = json!([record["head_commit"]]);
    assert_eq!(
        f::call(
            &db,
            json!({"op":"finish","job_id":leased["id"],"epoch":leased["epoch"],"result":result}),
            1000
        )
        .unwrap_err()
        .code,
        "INVALID_CONFLICT_RESULT"
    );
    assert!(get(&db, "candidates", "resolved").is_err());
    result["readback"]["parents"] = b["parents"].clone();
    f::call(
        &db,
        json!({"op":"finish","job_id":leased["id"],"epoch":leased["epoch"],"result":result}),
        1000,
    )
    .unwrap();
    let selected = get(&db, "candidates", "resolved").unwrap();
    assert_eq!(selected["source_lineage"], lineage);
    assert_eq!(selected["conflict_expected_version"], 0);
    assert_eq!(
        crate::path_lists::load(&db, &selected, "paths").unwrap(),
        vec!["clean.rs", "conflict.rs"]
    );
    assert_eq!(
        get(&db, "conflicts", "conflict").unwrap()["status"],
        "evaluating"
    );
}
