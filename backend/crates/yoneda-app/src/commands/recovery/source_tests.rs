use super::*;
use crate::native::NativeStore;
pub(in crate::commands) fn fixture() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    call(&db,json!({"op":"init","id":"repo","name":"Source integration","remote":{"namespace":"test","name":"source"},"commit":"a".repeat(40),"policy":yoneda_core::Policy::default()}),1000).unwrap();
    let base = json!({"repository":"test/source","commit":"a".repeat(40)});
    let policy = repo(&db).unwrap()["policy"].clone();
    let run = json!({"id":"run","intent":"Build safely","criteria":[],"context":[],"base":base,"source_base":{"repository":"test/source","commit":"a".repeat(40),"tree":"b".repeat(40)},"base_version":0,"status":"exploring","mode":"collaborate","policy":policy,"workspace_transport":"api-source-v1","model_requests":0});
    save(&db, "runs", "run", &run).unwrap();
    let execution = json!({"id":"execution","run_id":"run","harness":"codex","provider":"codex","model":"gpt-5.6-luna","connection":"codex","role":"coding","status":"queued","base":base,"depth":0});
    save(&db, "executions", "execution", &execution).unwrap();
    job(&db,"job:execution","agent",1000,json!({"execution":execution,"run":run,"policy":policy,"workspace_transport":"api-source-v1"})).unwrap();
    db
}
pub(in crate::commands) fn call(db: &NativeStore, mut c: Value, now: i64) -> Result<Value> {
    c["now"] = json!(now);
    crate::execute(db, c)
}
#[test]
fn source_preparation_defer_preserves_deadlines_charges_and_factual_history() {
    let db = fixture();
    let before = call(&db, json!({"op":"claim","job_id":"job:execution"}), 1000).unwrap();
    let run = get(&db, "runs", "run").unwrap();
    let request =
        json!({"op":"defer_job","job_id":"job:execution","epoch":1,"reason":"source_preparing"});
    let deferred = call(&db, request.clone(), 1000).unwrap();
    assert_eq!(deferred["attempt"], 0);
    assert_eq!(deferred["epoch"], 2);
    assert_eq!(deferred["deadline"], before["deadline"]);
    assert_eq!(deferred["dispatch_deadline"], before["dispatch_deadline"]);
    assert_eq!(get(&db, "runs", "run").unwrap(), run);
    assert_eq!(call(&db, request, 1000).unwrap_err().code, "FENCED");
    let detail = call(&db, json!({"op":"run_detail","run_id":"run"}), 1000).unwrap();
    assert_eq!(detail["source_preparation"][0]["status"], "pending");
    assert_eq!(detail["source_preparation"][0]["stage"], "source_preparing");
    let next = call(&db, json!({"op":"claim","job_id":"job:execution"}), 6000).unwrap();
    assert_eq!(next["attempt"], 1);
    call(&db,json!({"op":"progress","job_id":"job:execution","epoch":next["epoch"],"progress":{"stage":"container_ready"}}),6000).unwrap();
    let detail = call(&db, json!({"op":"run_detail","run_id":"run"}), 6000).unwrap();
    assert_eq!(detail["source_preparation"][0]["status"], "ready");
    assert_eq!(call(&db,json!({"op":"defer_job","job_id":"job:execution","epoch":next["epoch"],"reason":"source_preparing"}),6000).unwrap_err().code,"INVALID_STATE");
}
#[test]
fn source_preparation_cannot_refund_legacy_capture_or_model_used_attempt() {
    for mode in ["legacy", "capture", "model"] {
        let db = fixture();
        let mut current = get(&db, "jobs", "job:execution").unwrap();
        if mode == "legacy" {
            current["payload"]["workspace_transport"] = json!("git-native-v1");
        }
        if mode == "capture" {
            current["kind"] = json!("capture");
        }
        save(&db, "jobs", "job:execution", &current).unwrap();
        let mut claimed = call(&db, json!({"op":"claim","job_id":"job:execution"}), 1000).unwrap();
        if mode == "model" {
            claimed["model_requests"] = json!(1);
            save(&db, "jobs", "job:execution", &claimed).unwrap();
        }
        let error=call(&db,json!({"op":"defer_job","job_id":"job:execution","epoch":1,"reason":"source_preparing"}),1000).unwrap_err();
        assert!(matches!(error.code.as_str(), "FORBIDDEN" | "INVALID_STATE"));
        assert_eq!(get(&db, "jobs", "job:execution").unwrap()["attempt"], 1);
    }
}
#[test]
fn deferred_reclaim_uses_new_epoch_workspace_and_preserves_old_identity_refs() {
    let db = fixture();
    let mut claimed = call(&db, json!({"op":"claim","job_id":"job:execution"}), 1000).unwrap();
    claimed["source_bindings"] = json!({"digest":{"producer_epoch":1,"binding":{"workspace_id":"old-workspace","view_digest":"digest","epoch":1}}});
    save(&db, "jobs", "job:execution", &claimed).unwrap();
    call(
        &db,
        json!({"op":"defer_job","job_id":"job:execution","epoch":1,"reason":"source_preparing"}),
        1000,
    )
    .unwrap();
    let fresh = call(&db, json!({"op":"claim","job_id":"job:execution"}), 6000).unwrap();
    assert_eq!(fresh["source_bindings"], json!({}));
    assert_eq!(
        fresh["source_attempts"][0]["workspaces"][0]["workspace_id"],
        "old-workspace"
    );
    assert_eq!(fresh["source_attempts"][0]["workspaces"][0]["epoch"], 1);
    let detail = call(&db, json!({"op":"run_detail","run_id":"run"}), 6000).unwrap();
    assert!(!detail["source_preparation"].to_string().contains("binding"));
}
