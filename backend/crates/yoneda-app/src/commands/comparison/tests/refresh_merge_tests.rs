//! N8 step 12: two compare runs start on one main; A publishes; B's selected result is
//! refreshed onto the new main, evaluated, and published fast-forward only.
use super::fixtures as f;
use super::*;
use crate::native::NativeStore;

const A1: &str = "1111111111111111111111111111111111111111";
const B1: &str = "3333333333333333333333333333333333333333";
const MERGE: &str = "6666666666666666666666666666666666666666";

fn start(db: &NativeStore, id: &str) {
    let mut input = f::input();
    input["id"] = json!(id);
    f::call(db, input).unwrap();
}

/// Both builders check, the reviewer selects agent 1's result, and trusted completion records it.
fn select_first(db: &NativeStore, rid: &str, commits: [&str; 2]) -> String {
    for (index, commit) in commits.iter().enumerate() {
        f::finish_candidate(
            db,
            &format!("{rid}:agent-{}", index + 1),
            &format!("{rid}-candidate-{}", index + 1),
            commit,
        );
    }
    let job = run_jobs(db, rid)
        .unwrap()
        .into_iter()
        .find(|j| j["payload"]["comparison_review"] == true && j["status"] == "queued")
        .unwrap();
    let job = f::call(db, json!({"op":"claim","job_id":job["id"]})).unwrap();
    let context = f::call(
        db,
        json!({"op":"comparison_context","job_id":job["id"],"epoch":job["epoch"]}),
    )
    .unwrap();
    let alternatives: Vec<Value> = context["manifest"]["alternatives"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| {
            json!({"candidate_id":a["candidate_id"],"execution_id":a["execution_id"],
            "reason":"This independently checked booking approach preserves capacity"})
        })
        .collect();
    let chosen = context["manifest"]["alternatives"][0]["candidate_id"].clone();
    f::call(db, json!({"op":"comparison_submit","job_id":job["id"],"epoch":job["epoch"],
        "request_id":format!("review-{rid}"),"manifest_digest":context["manifest_digest"],
        "outcome":"selected","candidate_id":chosen,
        "rationale":"Prefer capacity-safe transaction boundaries to preserve booking integrity",
        "alternatives":alternatives,"risks":[],"evidence_refs":[],
        "repair_instructions":"Tighten cancellation transaction boundaries within the approved booking goal"})).unwrap();
    f::call(
        db,
        json!({"op":"finish","job_id":job["id"],"epoch":job["epoch"],
        "result":{"review_only":true,"source_unchanged":true,"transcript":"e".repeat(64)}}),
    )
    .unwrap();
    let run = get(db, "runs", rid).unwrap();
    assert_eq!(run["comparison"]["status"], "selected", "{rid}");
    run["comparison"]["selected_candidate_id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn publish(db: &NativeStore, request: &str, candidate: &str) -> Result<Value> {
    let r = repo(db).unwrap();
    let decision = f::call(
        db,
        json!({"op":"accept","request_id":request,"candidate":candidate,
        "expected_commit":r["head_commit"],"expected_version":r["version"],
        "rationale":"Owner publishes the selected checked result"}),
    )?;
    f::call(
        db,
        json!({"op":"publication_readback","decision_id":decision["id"],"observed_commit":decision["commit"]}),
    )
}

/// A published, B selected on the old main, B's pick refreshed cleanly onto A's main.
fn refreshed() -> (NativeStore, String, String) {
    let db = f::db();
    start(&db, "run-a");
    start(&db, "run-b");
    let a = select_first(&db, "run-a", [A1, "2".repeat(40).as_str()]);
    let b = select_first(&db, "run-b", [B1, "4".repeat(40).as_str()]);
    publish(&db, "publish-a", &a).unwrap();
    assert_eq!(repo(&db).unwrap()["published_commit"], A1);
    let receipt = f::call(
        &db,
        json!({"op":"refresh_candidate","request_id":"refresh-b",
        "candidate_id":b,"expected_commit":A1,"expected_version":1}),
    )
    .unwrap();
    let job = f::call(&db, json!({"op":"claim","job_id":receipt["job_id"]})).unwrap();
    let declared = crate::path_lists::load(&db, &job["payload"], "declared_paths").unwrap();
    let paths = json!(["src/booking.rs"]);
    let cid = format!("candidate:refresh:{MERGE}");
    f::call(&db, json!({"op":"conflict_refresh_complete","job_id":job["id"],"epoch":job["epoch"],"result":{
        "status":"clean","candidate_id":cid,"revision":{"repository":"test/fork","commit":MERGE},"tree":"f".repeat(40),"merge_commit":MERGE,"paths":paths,"diff_digest":"d".repeat(64),
        "evidence":{"base_commit":"a".repeat(40),"observed_head":A1,"candidate_commit":B1,"declared_paths":declared,"captured_paths":paths,"intervening_paths":paths,"overlapping_paths":paths},
        "readback":{"observed_head":A1,"version":1,"parents":[A1,B1],"candidate_paths":paths,"intervening_paths":paths,"merge_commit":MERGE,"merged_paths":paths}}}))
    .unwrap();
    (db, b, cid)
}

/// Claims the refreshed result's evaluator after one routine container deferral, as on the live
/// platform: every attempt transition wakes the comparison lifecycle.
fn claim_evaluator(db: &NativeStore, cid: &str) -> Value {
    let jid = format!("evaluate:{cid}");
    f::call(db, json!({"op":"claim","job_id":jid})).unwrap();
    f::call(
        db,
        json!({"op":"defer_job","job_id":jid,"epoch":1,"reason":"source_preparing"}),
    )
    .unwrap();
    f::call(db, json!({"op":"claim","job_id":jid,"now":6000})).unwrap()
}

fn evaluate(db: &NativeStore, cid: &str) -> Result<Value> {
    let job = claim_evaluator(db, cid);
    evaluate_claimed(db, cid, &job)
}

fn evaluate_claimed(db: &NativeStore, cid: &str, job: &Value) -> Result<Value> {
    let jid = format!("evaluate:{cid}");
    let p = repo(db).unwrap()["policy"].clone();
    f::call(
        db,
        json!({"op":"finish","job_id":jid,"epoch":job["epoch"],"now":8000,"result":{
        "id":format!("evaluation-{cid}"),"candidate":cid,"revision":{"repository":"test/fork","commit":MERGE},
        "policy":p["version"],"suite":p["suite"],"environment":p["environment"],"evidence":"e".repeat(64),
        "checks":[{"name":"build","status":"pass","detail":"Synthetic refreshed evaluation"}]}}),
    )
}

#[test]
fn refreshed_selection_evaluates_and_publishes_fast_forward_onto_the_new_main() {
    let (db, picked, cid) = refreshed();
    evaluate(&db, &cid).unwrap();
    assert_eq!(get(&db, "candidates", &cid).unwrap()["status"], "eligible");
    // The recorded selection stands; its refresh is not a new review or a new choice.
    let run = get(&db, "runs", "run-b").unwrap();
    assert_eq!(run["comparison"]["status"], "selected");
    assert_eq!(run["comparison"]["selected_candidate_id"], picked);
    let inventory = f::call(&db, json!({"op":"conflict_status"})).unwrap();
    assert_eq!(inventory["conflicts"][0]["status"], "clean");
    // The stale original pick can no longer be published; its checked refresh can.
    assert_eq!(
        publish(&db, "publish-stale-b", &picked).unwrap_err().code,
        "HEAD_MOVED"
    );
    publish(&db, "publish-b", &cid).unwrap();
    let r = repo(&db).unwrap();
    assert_eq!(r["published_commit"], MERGE);
    assert_eq!(r["version"], 2);
    let decision = get(&db, "decisions", "decision:publish-b").unwrap();
    assert_eq!(decision["comparison"]["selected_candidate_id"], picked);
    assert_eq!(decision["comparison"]["refreshed_candidate_id"], cid);
}

type Tamper = fn(&NativeStore, &str);

#[test]
fn refresh_lineage_tampering_and_other_runs_results_stay_fenced() {
    let tampers: [(&str, Tamper); 4] = [
        ("refresh of another run's result", |db, cid| {
            let mut c = get(db, "candidates", cid).unwrap();
            c["refresh_of"] = json!("run-a-candidate-1");
            save(db, "candidates", cid, &c).unwrap();
        }),
        ("refresh moved into another run", |db, cid| {
            let mut c = get(db, "candidates", cid).unwrap();
            c["run_id"] = json!("run-a");
            save(db, "candidates", cid, &c).unwrap();
        }),
        ("conflict record names another result", |db, _| {
            let mut record = get(db, "conflicts", "conflict:refresh-b").unwrap();
            record["refreshed_candidate_id"] = json!("forged");
            save(db, "conflicts", "conflict:refresh-b", &record).unwrap();
        }),
        ("refresh base is not the recorded target", |db, cid| {
            let mut c = get(db, "candidates", cid).unwrap();
            c["base"]["commit"] = json!("9".repeat(40));
            save(db, "candidates", cid, &c).unwrap();
        }),
    ];
    for (name, tamper) in tampers {
        let (db, _, cid) = refreshed();
        evaluate(&db, &cid).unwrap();
        tamper(&db, &cid);
        let before = f::call(&db, json!({"op":"snapshot"})).unwrap();
        assert!(publish(&db, "forged-b", &cid).is_err(), "{name}");
        assert_eq!(
            f::call(&db, json!({"op":"snapshot"})).unwrap(),
            before,
            "{name}"
        );
    }
}

#[test]
fn refresh_of_an_unselected_alternative_cannot_publish() {
    let (db, _, _) = refreshed();
    let mut c = get(&db, "candidates", &format!("candidate:refresh:{MERGE}")).unwrap();
    c["refresh_of"] = json!("run-b-candidate-2");
    let mut record = get(&db, "conflicts", "conflict:refresh-b").unwrap();
    record["candidate_id"] = json!("run-b-candidate-2");
    record["candidate_revision"] = json!("4".repeat(40));
    c["approved_parents"] = json!([A1, "4".repeat(40)]);
    c["execution"] = json!("run-b:agent-2");
    save(&db, "candidates", c["id"].as_str().unwrap(), &c).unwrap();
    save(&db, "conflicts", "conflict:refresh-b", &record).unwrap();
    let cid = c["id"].as_str().unwrap().to_owned();
    evaluate(&db, &cid).unwrap();
    assert_eq!(
        publish(&db, "alternative-b", &cid).unwrap_err().code,
        "COMPARISON_NOT_SELECTED"
    );
}

#[test]
fn fenced_refresh_evaluation_ends_failed_with_a_visible_reason() {
    let (db, _, cid) = refreshed();
    // Lineage that no longer verifies, observed by a comparison that must recompute its manifest.
    let mut c = get(&db, "candidates", &cid).unwrap();
    c["approved_parents"] = json!([A1, "9".repeat(40)]);
    save(&db, "candidates", &cid, &c).unwrap();
    let mut run = get(&db, "runs", "run-b").unwrap();
    run["comparison"]["status"] = json!("checking");
    save(&db, "runs", "run-b", &run).unwrap();
    let jid = format!("evaluate:{cid}");
    let mut job = claim_evaluator(&db, &cid);
    for attempt in 1..=2 {
        assert_eq!(
            evaluate_claimed(&db, &cid, &job).unwrap_err().code,
            "FENCED"
        );
        // The runtime reports a rejected completion through the failure path.
        let failed = f::call(
            &db,
            json!({"op":"fail","job_id":jid,"epoch":job["epoch"],"now":7000,
            "retryable":true,"error":"FENCED: Refreshed candidate lineage changed"}),
        )
        .unwrap();
        if attempt == 1 {
            assert_eq!(failed["status"], "queued");
            job = f::call(&db, json!({"op":"claim","job_id":jid,"now":8000})).unwrap();
        } else {
            assert_eq!(failed["status"], "failed");
        }
    }
    let candidate = get(&db, "candidates", &cid).unwrap();
    assert_eq!(candidate["status"], "failed");
    assert!(candidate["error"].to_string().contains("FENCED"));
    let inventory = f::call(&db, json!({"op":"conflict_status"})).unwrap();
    assert_eq!(inventory["conflicts"][0]["status"], "failed");
    assert!(
        inventory["conflicts"][0]["error"]
            .to_string()
            .contains("FENCED")
    );
    let run = get(&db, "runs", "run-b").unwrap();
    assert_eq!(run["comparison"]["status"], "needs_attention");
    assert_eq!(run["comparison"]["terminal_reason"]["code"], "FENCED");
}
