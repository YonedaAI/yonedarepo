use super::*;
use crate::native::NativeStore;

#[test]
fn captured_receipts_are_execution_epoch_bound() {
    let db = NativeStore::memory().unwrap();
    crate::execute(&db, json!({"op":"init","id":"prov","name":"Prov","remote":{"namespace":"test","name":"prov"},"commit":"a".repeat(40),"policy":yoneda_core::Policy::default()})).unwrap();
    create(
        &db,
        "executions",
        "exec",
        &json!({"id":"exec","run_id":"run","epoch":3,"status":"capturing"}),
    )
    .unwrap();
    let job = json!({"kind":"capture","epoch":4,"payload":{"execution":{"id":"exec","run_id":"run","epoch":3},"base":{"commit":"a".repeat(40)}}});
    let result = json!({"id":"candidate","revision":{"commit":"b".repeat(40)},"paths":["src/a.rs"],"file_provenance":[{"path":"src/a.rs","change":"modify","old_blob":"c".repeat(40),"new_blob":"d".repeat(40)}]});
    let receipts = capture_file_provenance(&db, &job, &result, 42).unwrap();
    assert_eq!(receipts[0]["capture_epoch"], 4);
    assert_eq!(receipts[0]["execution_epoch"], 3);
    assert_eq!(receipts[0]["authority"], "trusted_capture");
    let mut forged = result.clone();
    forged["file_provenance"][0]["new_blob"] = json!("e".repeat(40));
    assert_eq!(
        capture_file_provenance(&db, &job, &forged, 43)
            .unwrap_err()
            .code,
        "ALREADY_EXISTS"
    );
}

#[test]
fn provenance_rejects_receipts_for_unlisted_paths_and_invalid_blob_ids() {
    let db = NativeStore::memory().unwrap();
    crate::execute(&db, json!({"op":"init","id":"prov","name":"Prov","remote":{"namespace":"test","name":"prov"},"commit":"a".repeat(40),"policy":yoneda_core::Policy::default()})).unwrap();
    create(
        &db,
        "executions",
        "exec",
        &json!({"id":"exec","run_id":"run","epoch":1,"status":"capturing"}),
    )
    .unwrap();
    let job = json!({"kind":"capture","epoch":1,"payload":{"execution":{"id":"exec","run_id":"run","epoch":1},"base":{"commit":"a".repeat(40)}}});
    let result = json!({"id":"candidate","revision":{"commit":"b".repeat(40)},"paths":["src/a.rs"],"file_provenance":[{"path":"src/other.rs","change":"add","old_blob":null,"new_blob":"c".repeat(40)}]});
    assert_eq!(
        capture_file_provenance(&db, &job, &result, 1)
            .unwrap_err()
            .code,
        "INVALID_INPUT"
    );
    let invalid_blob = json!({"id":"candidate-b","revision":{"commit":"d".repeat(40)},"paths":["src/a.rs"],"file_provenance":[{"path":"src/a.rs","change":"add","old_blob":null,"new_blob":"not-a-git-object"}]});
    assert_eq!(
        capture_file_provenance(&db, &job, &invalid_blob, 1)
            .unwrap_err()
            .code,
        "INVALID_INPUT"
    );
}

#[test]
fn task_receipts_are_scoped_to_the_handoff_identity() {
    let db = NativeStore::memory().unwrap();
    crate::execute(&db, json!({"op":"init","id":"prov","name":"Prov","remote":{"namespace":"test","name":"prov"},"commit":"a".repeat(40),"policy":yoneda_core::Policy::default()})).unwrap();
    create(
        &db,
        "executions",
        "task-exec",
        &json!({"id":"task-exec","run_id":"run","epoch":2,"status":"capturing"}),
    )
    .unwrap();
    let job = json!({"kind":"capture","epoch":5,"payload":{"execution":{"id":"task-exec","run_id":"run","epoch":2,"team_task":"task-id","team_task_revision":3,"team_role":"worker"},"base":{"commit":"a".repeat(40)}}});
    let result = json!({"id":"untrusted-display-id","revision":{"commit":"b".repeat(40)},"paths":["src/task.rs"],"file_provenance":[{"path":"src/task.rs","change":"add","old_blob":null,"new_blob":"c".repeat(40)}]});
    let receipts = capture_file_provenance(&db, &job, &result, 10).unwrap();
    assert_eq!(receipts[0]["handoff_id"], "handoff:task-id:3");
    assert!(receipts[0]["candidate"].is_null());
    assert_eq!(receipts[0]["execution_id"], "task-exec");
}

#[test]
fn capture_receipt_limit_allows_more_than_git_diff_legacy_limit() {
    let db = NativeStore::memory().unwrap();
    crate::execute(&db, json!({"op":"init","id":"prov","name":"Prov","remote":{"namespace":"test","name":"prov"},"commit":"a".repeat(40),"policy":yoneda_core::Policy::default()})).unwrap();
    create(
        &db,
        "executions",
        "exec",
        &json!({"id":"exec","run_id":"run","epoch":1,"status":"capturing"}),
    )
    .unwrap();
    let job = json!({"kind":"capture","epoch":1,"payload":{"execution":{"id":"exec","run_id":"run","epoch":1},"base":{"commit":"a".repeat(40)}}});
    let make_result = |id: &str, count: usize| {
        let entries: Vec<_> = (0..count)
            .map(|index| {
                json!({"path":format!("src/file-{index}.rs"),"change":"add","old_blob":null,"new_blob":"c".repeat(40)})
            })
            .collect();
        let paths: Vec<_> = entries.iter().map(|entry| entry["path"].clone()).collect();
        json!({"id":id,"revision":{"commit":"b".repeat(40)},"paths":paths,"file_provenance":entries})
    };
    let result = make_result("candidate-many", 501);
    assert_eq!(
        capture_file_provenance(&db, &job, &result, 42)
            .unwrap()
            .len(),
        501
    );
    let too_many = make_result("candidate-too-many", 10_001);
    assert_eq!(
        capture_file_provenance(&db, &job, &too_many, 43)
            .unwrap_err()
            .code,
        "RESOURCE_LIMIT"
    );
}

#[test]
fn merge_refresh_is_platform_authored_and_inherits_execution_only_for_exact_blobs() {
    let db = NativeStore::memory().unwrap();
    crate::execute(&db, json!({"op":"init","id":"prov","name":"Prov","remote":{"namespace":"test","name":"prov"},"commit":"a".repeat(40),"policy":yoneda_core::Policy::default()})).unwrap();
    let original = json!({"id":"candidate-old","execution":"original-exec","run_id":"run","revision":{"commit":"b".repeat(40)}});
    create(&db, "candidates", "candidate-old", &original).unwrap();
    create(
        &db,
        "executions",
        "original-exec",
        &json!({"id":"original-exec","run_id":"run","epoch":6,"status":"completed"}),
    )
    .unwrap();
    let original_receipt = json!({"id":"old-receipt","candidate":"candidate-old","run_id":"run","execution_id":"original-exec","execution_epoch":6,"path":"src/same.rs","new_blob":"f".repeat(40)});
    create(&db, "nodes", "old-receipt", &json!({"id":"old-receipt","kind":"file_provenance","author":"platform_capture","data":original_receipt})).unwrap();
    let job = json!({"kind":"capture","epoch":9,"payload":{"subtype":"refresh_candidate","candidate":original,"run_id":"run","expected_head":"c".repeat(40),"execution":{"id":"spoofed-execution","run_id":"run","epoch":99}}});
    let result = json!({"candidate_id":"candidate-refreshed","revision":{"commit":"d".repeat(40)},"paths":["src/same.rs","src/merged.rs"],"file_provenance":[
        {"path":"src/same.rs","change":"modify","old_blob":"e".repeat(40),"new_blob":"f".repeat(40)},
        {"path":"src/merged.rs","change":"add","old_blob":null,"new_blob":"9".repeat(40)}
    ]});
    let receipts = capture_file_provenance(&db, &job, &result, 15).unwrap();
    assert_eq!(receipts.len(), 2);
    assert_eq!(receipts[0]["candidate"], "candidate-refreshed");
    assert_eq!(receipts[0]["source_candidate"], "candidate-old");
    assert_eq!(receipts[0]["subject_id"], "candidate-refreshed");
    assert_eq!(receipts[0]["base_commit"], "c".repeat(40));
    assert_eq!(receipts[0]["capture_kind"], "merge_refresh");
    assert_eq!(receipts[0]["execution_id"], Value::Null);
    assert_eq!(receipts[0]["source_execution_id"], "original-exec");
    assert_eq!(receipts[0]["source_execution_epoch"], 6);
    assert_eq!(receipts[1]["execution_id"], Value::Null);
    assert_eq!(receipts[1]["source_execution_id"], Value::Null);
    let persisted = get(&db, "nodes", &string(&receipts[1], "id").unwrap()).unwrap();
    assert_eq!(persisted["author"], "platform_merge_refresh");
    let edges = db.query("SELECT source,target,relation FROM edges WHERE source LIKE 'file-receipt:merge-refresh:%' ORDER BY source,target", &[]).unwrap();
    assert!(
        edges.iter().any(
            |edge| edge["target"] == "original-exec" && edge["relation"] == "source_bytes_from"
        )
    );
    assert!(
        !edges
            .iter()
            .any(|edge| edge["target"] == "spoofed-execution")
    );
    create(
        &db,
        "candidates",
        "candidate-refreshed",
        &json!({"id":"candidate-refreshed","run_id":"run","base":{"commit":"c".repeat(40)},"revision":{"commit":"d".repeat(40)},"recorded_at":15}),
    )
    .unwrap();
    let same_blob = why(&db, &"d".repeat(40), "src/same.rs").unwrap();
    assert_eq!(same_blob["lineage"][0]["capture_kind"], "merge_refresh");
    assert_eq!(same_blob["lineage"][1]["execution_id"], "original-exec");
    assert_eq!(
        same_blob["lineage"][1]["lineage_relation"],
        "exact_blob_inherited_by_merge_refresh"
    );
    let changed_blob = why(&db, &"d".repeat(40), "src/merged.rs").unwrap();
    assert_eq!(changed_blob["lineage"].as_array().unwrap().len(), 1);
    assert!(changed_blob["lineage"][0]["execution_id"].is_null());
}

#[test]
fn merge_refresh_rejects_frozen_candidate_run_mismatch() {
    let db = NativeStore::memory().unwrap();
    crate::execute(&db, json!({"op":"init","id":"prov","name":"Prov","remote":{"namespace":"test","name":"prov"},"commit":"a".repeat(40),"policy":yoneda_core::Policy::default()})).unwrap();
    let candidate = json!({"id":"candidate-old","execution":"original-exec","run_id":"actual-run"});
    create(&db, "candidates", "candidate-old", &candidate).unwrap();
    create(
        &db,
        "executions",
        "original-exec",
        &json!({"id":"original-exec","run_id":"actual-run","epoch":1,"status":"completed"}),
    )
    .unwrap();
    let job = json!({"kind":"capture","epoch":9,"payload":{"subtype":"refresh_candidate","candidate":candidate,"run_id":"other-run","expected_head":"c".repeat(40)}});
    assert_eq!(capture_file_provenance(&db, &job, &json!({"candidate_id":"new","revision":{"commit":"d".repeat(40)},"paths":[],"file_provenance":[]}), 1).unwrap_err().code, "FENCED");
}

#[test]
fn lineage_inherits_unchanged_paths_and_keeps_file_histories_isolated() {
    let db = NativeStore::memory().unwrap();
    crate::execute(&db, json!({"op":"init","id":"prov","name":"Prov","remote":{"namespace":"test","name":"prov"},"commit":"a".repeat(40),"policy":yoneda_core::Policy::default()})).unwrap();
    for (id, base, revision, path, change, execution) in [
        ("c1", "a", "b", "src/one.rs", "add", "agent-one"),
        ("c2", "b", "c", "src/two.rs", "add", "agent-two"),
        ("c3", "c", "d", "src/renamed.rs", "rename", "repair-agent"),
    ] {
        let mut receipt = json!({"id":format!("r-{id}"),"candidate":id,"run_id":"run","execution_id":execution,"execution_epoch":1,"capture_epoch":1,"base_commit":format!("{}{}",base,"a".repeat(39)),"commit":format!("{}{}",revision,"a".repeat(39)),"revision":{"commit":format!("{}{}",revision,"a".repeat(39))},"path":path,"change":change,"old_blob":"e".repeat(40),"new_blob":"f".repeat(40),"authority":"trusted_capture"});
        if change == "rename" {
            receipt["old_path"] = json!("src/one.rs");
        }
        let rid = string(&receipt, "id").unwrap();
        create(&db,"nodes",&rid,&json!({"id":rid,"kind":"file_provenance","data":receipt,"label":"receipt","author":"platform_capture","recorded_at":1})).unwrap();
        create(&db,"candidates",id,&json!({"id":id,"run_id":"run","base":{"commit":format!("{}{}",base,"a".repeat(39))},"revision":{"commit":format!("{}{}",revision,"a".repeat(39))},"recorded_at":1,"summary":execution})).unwrap();
    }
    let handoff = json!({"id":"r-task-handoff","kind":"file_provenance","label":"rename src/renamed.rs","author":"platform_capture","recorded_at":1,"data":{"id":"r-task-handoff","handoff_id":"handoff:task-3:1","run_id":"run","execution_id":"task-agent","execution_epoch":1,"capture_epoch":1,"path":"src/renamed.rs","change":"modify","old_blob":"1".repeat(40),"new_blob":"f".repeat(40),"authority":"trusted_capture"}});
    create(&db, "nodes", "r-task-handoff", &handoff).unwrap();
    let second = json!({"id":"r-c2-modify","kind":"file_provenance","label":"modify src/one.rs","author":"platform_capture","recorded_at":1,"data":{"id":"r-c2-modify","candidate":"c2","run_id":"run","execution_id":"agent-two","execution_epoch":1,"capture_epoch":1,"base_commit":format!("b{}","a".repeat(39)),"commit":format!("c{}","a".repeat(39)),"revision":{"commit":format!("c{}","a".repeat(39))},"path":"src/one.rs","change":"modify","old_blob":"1".repeat(40),"new_blob":"2".repeat(40),"authority":"trusted_capture"}});
    create(&db, "nodes", "r-c2-modify", &second).unwrap();
    let decision = json!({"id":"decision-c2","candidate":"c2","rationale":"Preserves the retry contract","alternatives":[{"candidate":"candidate-not-in-file-lineage","reason":"Misses the accepted retry boundary"}]});
    create(&db, "decisions", "decision-c2", &decision).unwrap();
    link_file_provenance_to_decision(&db, &decision, 5).unwrap();
    let got = why(&db, &format!("d{}", "a".repeat(39)), "src/renamed.rs").unwrap();
    assert_eq!(got["coverage"], "recorded");
    assert_eq!(got["lineage"][0]["execution_id"], "repair-agent");
    assert_eq!(got["lineage"][1]["execution_id"], "task-agent");
    assert_eq!(got["lineage"][2]["execution_id"], "agent-two");
    assert_eq!(got["lineage"][3]["execution_id"], "agent-one");
    assert_eq!(
        got["decisions"][0]["rationale"],
        "Preserves the retry contract"
    );
    assert_eq!(
        got["rejected_alternatives"][0]["reason"],
        "Misses the accepted retry boundary"
    );
    let other = why(&db, &format!("d{}", "a".repeat(39)), "src/two.rs").unwrap();
    assert!(
        other["lineage"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["execution_id"] != "repair-agent")
    );
    assert_eq!(
        why(&db, &format!("d{}", "a".repeat(39)), "src/missing.rs").unwrap()["coverage"],
        "unknown"
    );
    let deleted = json!({"id":"r-c4","kind":"file_provenance","label":"delete src/renamed.rs","author":"platform_capture","recorded_at":2,"data":{"id":"r-c4","candidate":"c4","run_id":"run","execution_id":"repair-agent","execution_epoch":2,"capture_epoch":2,"base_commit":format!("d{}","a".repeat(39)),"commit":format!("e{}","a".repeat(39)),"revision":{"commit":format!("e{}","a".repeat(39))},"path":"src/renamed.rs","change":"delete","old_blob":"f".repeat(40),"new_blob":null,"authority":"trusted_capture"}});
    create(&db, "nodes", "r-c4", &deleted).unwrap();
    create(&db,"candidates","c4",&json!({"id":"c4","base":{"commit":format!("d{}","a".repeat(39))},"revision":{"commit":format!("e{}","a".repeat(39))},"recorded_at":2})).unwrap();
    let gone = why(&db, &format!("e{}", "a".repeat(39)), "src/renamed.rs").unwrap();
    assert_eq!(gone["status"], "deleted");
}
