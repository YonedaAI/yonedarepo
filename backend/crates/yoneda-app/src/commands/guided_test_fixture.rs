//! Native ledger command pipeline with fixture observations; no model or hosted claim.
use super::*;
fn call(db: &NativeStore, mut input: Value, now: i64) -> Value {
    input["now"] = json!(now);
    execute(db, input).unwrap()
}
pub(super) fn checked(db: &NativeStore, rid: &str, phase: &str, overlap: bool) -> String {
    checked_with_context(db, rid, phase, overlap, None)
}
pub(super) fn checked_with_context(
    db: &NativeStore,
    rid: &str,
    phase: &str,
    overlap: bool,
    prior: Option<&str>,
) -> String {
    let cid = captured_with_context(db, rid, overlap, prior);
    evaluate(db, &cid, phase);
    cid
}
/// Hosted shape: the integrator records a decision that explicitly supersedes the specialist's choice.
pub(super) fn checked_with_integrator_decision(db: &NativeStore, rid: &str) -> String {
    let cid = captured(db, rid, true, None, true);
    evaluate(db, &cid, "build");
    cid
}
pub(super) fn evaluate(db: &NativeStore, cid: &str, phase: &str) {
    let evaluation = call(
        db,
        json!({"op":"claim","job_id":format!("evaluate:{cid}")}),
        55,
    );
    call(
        db,
        json!({"op":"verify_finish","job_id":evaluation["id"],"epoch":evaluation["epoch"],"evidence":"e".repeat(64),
        "report":{"guided_check_phase":phase,"guided_check_variant":evaluation["payload"]["guided"]["variant"],
        "environment":"linux-node24-rust1.94-v1","suite":"commands-v1","setup":[],"commands":[{"name":"board","output":{"exit":0}}]}}),
        56,
    );
    assert_eq!(get(db, "candidates", cid).unwrap()["status"], "eligible");
}
pub(super) fn captured_with_context(
    db: &NativeStore,
    rid: &str,
    overlap: bool,
    prior: Option<&str>,
) -> String {
    captured(db, rid, overlap, prior, false)
}
fn captured(
    db: &NativeStore,
    rid: &str,
    overlap: bool,
    prior: Option<&str>,
    integrator_decision: bool,
) -> String {
    let workers = ["core", "ui"];
    let mut claimed = Vec::new();
    for (index, task) in workers.iter().enumerate() {
        let eid = format!("{rid}:task:{task}");
        let job = call(
            db,
            json!({"op":"claim","job_id":format!("job:{eid}")}),
            10 + index as i64,
        );
        if overlap {
            call(
                db,
                json!({"op":"progress","job_id":job["id"],"epoch":job["epoch"],"progress":{"stage":"harness_running"}}),
                12 + index as i64,
            );
        }
        claimed.push(job);
    }
    call(
        db,
        json!({"op":"context_publish","job_id":claimed[0]["id"],"epoch":claimed[0]["epoch"],
        "record":{"id":format!("context:choice:{rid}"),"kind":"proposed_decision",
        "statement":"Keep stable IDs so bookmarks remain valid across edits",
        "purpose":"Preserve references to task identity","intent_id":format!("intent:{rid}"),
        "file_paths":["public/tasks.mjs"],"links":[]}}),
        15,
    );
    if let Some(prior) = prior {
        call(
            db,
            json!({"op":"context_get","job_id":claimed[0]["id"],"epoch":claimed[0]["epoch"],"id":prior}),
            16,
        );
        call(
            db,
            json!({"op":"record_context_access","job_id":claimed[0]["id"],"epoch":claimed[0]["epoch"],"call_id":format!("receipt-{}",&yoneda_core::digest(rid.as_bytes())[..16]),"tool":"context_get","stage":"opened","targets":[{"id":prior}]}),
            17,
        );
        call(
            db,
            json!({"op":"context_publish","job_id":claimed[0]["id"],"epoch":claimed[0]["epoch"],"record":{"id":format!("context:citation:{rid}"),"kind":"finding","statement":"Stable IDs preserve bookmark references across edits","purpose":"Explain the retrieved prior decision's influence","intent_id":format!("intent:{rid}"),"links":[{"relation":"depends_on","target":prior}],"file_paths":["public/tasks.mjs"]}}),
            18,
        );
    }
    for (index, job) in claimed.iter().enumerate() {
        call(
            db,
            json!({"op":"record_transcript","job_id":job["id"],"epoch":job["epoch"],"digest":"c".repeat(64)}),
            30 + index as i64,
        );
        call(
            db,
            json!({"op":"finish","job_id":job["id"],"epoch":job["epoch"],"result":{"workspace":"e".repeat(64)}}),
            32 + index as i64,
        );
        let eid = job["payload"]["execution"]["id"].as_str().unwrap();
        let capture = call(
            db,
            json!({"op":"claim","job_id":format!("capture:{eid}")}),
            40 + index as i64,
        );
        call(
            db,
            json!({"op":"finish","job_id":capture["id"],"epoch":capture["epoch"],
            "result":{"id":format!("contribution:{eid}"),"revision":{"repository":"owner/contribution","commit":if index==0{"c".repeat(40)}else{"d".repeat(40)}},
            "tree":"f".repeat(40),"paths":[if index==0{"public/tasks.mjs"}else{"public/app.mjs"}],
            "summary":"Native capture protocol fixture observation"}}),
            42 + index as i64,
        );
        assert_eq!(
            get(db, "jobs", capture["id"].as_str().unwrap()).unwrap()["status"],
            "done"
        );
    }
    let eid = format!("{rid}:task:integrate");
    let integrator = call(db, json!({"op":"claim","job_id":format!("job:{eid}")}), 50);
    if integrator_decision {
        call(
            db,
            json!({"op":"context_publish","job_id":integrator["id"],"epoch":integrator["epoch"],
            "record":{"id":format!("context:integrated:{rid}"),"kind":"proposed_decision",
            "statement":"Stable-identity decision: task ids are assigned once and never replaced",
            "purpose":"Reconcile the specialists' identity choice in the integrated tree","intent_id":format!("intent:{rid}"),
            "file_paths":["public/tasks.mjs"],"links":[{"relation":"supersedes","target":format!("context:choice:{rid}")}]}}),
            50,
        );
    }
    call(
        db,
        json!({"op":"record_transcript","job_id":integrator["id"],"epoch":integrator["epoch"],"digest":"d".repeat(64)}),
        51,
    );
    call(
        db,
        json!({"op":"finish","job_id":integrator["id"],"epoch":integrator["epoch"],"result":{"workspace":"e".repeat(64)}}),
        52,
    );
    let capture = call(
        db,
        json!({"op":"claim","job_id":format!("capture:{eid}")}),
        53,
    );
    let cid = format!("candidate:{rid}");
    call(
        db,
        json!({"op":"finish","job_id":capture["id"],"epoch":capture["epoch"],
        "result":{"id":cid,"revision":{"repository":"owner/captured","commit":if rid.ends_with("-concurrent-0"){"1".repeat(40)}else if rid.ends_with("-concurrent-1"){"2".repeat(40)}else{"b".repeat(40)}},"tree":"f".repeat(40),
        "paths":["public/tasks.mjs","public/app.mjs"],"integration_digest":capture["payload"]["integration_digest"],
        "summary":"Native integrated capture fixture observation"}}),
        54,
    );
    cid
}
