use super::*;

fn team_repo() -> NativeStore {
    repo_with_policy(
        json!({"version":"team-v1","suite":"commands-v1","environment":"linux-node24-rust1.94-v1","required_checks":["build"],"build":{"setup":[],"checks":[{"name":"build","argv":["node","--check","public/index.js"],"timeout_seconds":30}]}}),
    )
}
fn request() -> Value {
    json!({"op":"start_run","id":"team","intent":"Build one event website together","mode":"collaborate","agents":[
        {"provider":"mimo","model":"mimo-v2.6-flash","strategy":"specialist"},
        {"provider":"zai","model":"glm-5.3-flash","strategy":"specialist"},
        {"provider":"mimo","model":"mimo-v2.6-flash","strategy":"integrator"}],
        "team":{"version":1,"contract":"Search exports filterEvents; registration exports rsvp; index wires both.","integrator_agent":2,"integration_paths":["public/index.js"],"tasks":[
        {"id":"search","title":"Event search","instructions":"Implement filterEvents","agent":0,"depends_on":[],"write_paths":["public/search.js"]},
        {"id":"rsvp","title":"Event registration","instructions":"Implement rsvp","agent":1,"depends_on":[],"write_paths":["public/rsvp.js"]},
        {"id":"summary","title":"Registration summary","instructions":"Read search and RSVP contracts and implement summary","agent":0,"depends_on":["search","rsvp"],"write_paths":["public/summary.js"]}]}})
}
fn snapshot(db: &NativeStore) -> Value {
    call(db, json!({"op":"snapshot"})).unwrap()
}
fn task(db: &NativeStore, local: &str) -> Value {
    snapshot(db)["team_tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["task_id"] == local)
        .unwrap()
        .clone()
}
fn claim(db: &NativeStore, jid: &str) -> Value {
    call(db, json!({"op":"claim","job_id":jid})).unwrap()
}
fn captured(db: &NativeStore, local: &str, paths: Value, digest: Option<Value>) -> Value {
    let eid = format!("team:task:{local}");
    let agent = claim(db, &format!("job:{eid}"));
    call(db,json!({"op":"finish","job_id":agent["id"],"epoch":agent["epoch"],"result":{"workspace":"b".repeat(64)}})).unwrap();
    let revision = task(db, local)["revision"].as_i64().unwrap();
    let capture = claim(
        db,
        &if revision > 1 {
            format!("capture:{eid}:r{revision}")
        } else {
            format!("capture:{eid}")
        },
    );
    let mut result = json!({"id":format!("captured-{local}-{revision}"),"revision":{"repository":format!("test/{local}"),"commit":yoneda_core::digest(local.as_bytes())},"tree":"c".repeat(40),"paths":paths,"summary":local,"diff":"trusted diff"});
    if let Some(digest) = digest {
        result["integration_digest"] = digest;
    }
    call(
        db,
        json!({"op":"finish","job_id":capture["id"],"epoch":capture["epoch"],"result":result}),
    )
    .unwrap();
    capture
}
fn capture_workers(db: &NativeStore) {
    captured(db, "search", json!(["public/search.js"]), None);
    captured(db, "rsvp", json!(["public/rsvp.js"]), None);
    captured(
        db,
        "summary",
        json!(["public/search.js", "public/rsvp.js", "public/summary.js"]),
        None,
    );
}
#[test]
fn tasks_wait_for_capture_and_only_integrator_creates_checked_candidate() {
    let db = team_repo();
    let run = call(&db, request()).unwrap();
    assert_eq!(run["agents"].as_array().unwrap().len(), 3);
    assert_eq!(run["execution_count"], 4);
    assert_eq!(snapshot(&db)["executions"].as_array().unwrap().len(), 2);
    assert_eq!(task(&db, "summary")["status"], "blocked");
    captured(&db, "search", json!(["public/search.js"]), None);
    assert_eq!(task(&db, "summary")["status"], "blocked");
    captured(&db, "rsvp", json!(["public/rsvp.js"]), None);
    assert_eq!(task(&db, "summary")["status"], "queued");
    let j = claim(&db, "job:team:task:summary");
    let context = call(&db, json!({"op":"team_context","job_id":j["id"],"epoch":1})).unwrap();
    assert_eq!(context["handoffs"].as_array().unwrap().len(), 2);
    assert_eq!(
        j["payload"]["team_owned_paths"],
        json!(["public/summary.js"])
    );
    assert_eq!(j["payload"]["team_inputs"][0]["task_id"], "rsvp");
    assert_eq!(snapshot(&db)["candidates"], json!([]));
    call(
        &db,
        json!({"op":"finish","job_id":j["id"],"epoch":1,"result":{"workspace":"b".repeat(64)}}),
    )
    .unwrap();
    let c = claim(&db, "capture:team:task:summary");
    call(&db,json!({"op":"finish","job_id":c["id"],"epoch":1,"result":{"id":"summary-capture","revision":{"repository":"test/summary","commit":"d".repeat(40)},"tree":"e".repeat(40),"paths":["public/search.js","public/rsvp.js","public/summary.js"],"summary":"Summary","diff":"summary"}})).unwrap();
    assert_eq!(
        task(&db, "summary")["output"]["paths"],
        json!(["public/summary.js"])
    );
    let integration = crate::storage::get(&db, "jobs", "job:team:task:integrate").unwrap();
    assert_eq!(
        integration["payload"]["team_inputs"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(snapshot(&db)["candidates"], json!([]));
    let digest = integration["payload"]["integration_digest"].clone();
    captured(
        &db,
        "integrate",
        json!([
            "public/search.js",
            "public/rsvp.js",
            "public/summary.js",
            "public/index.js"
        ]),
        Some(digest.clone()),
    );
    assert_eq!(snapshot(&db)["candidates"].as_array().unwrap().len(), 1);
    let candidate = snapshot(&db)["candidates"][0].clone();
    assert_eq!(candidate["integration_digest"], digest);
    assert_eq!(candidate["status"], "evaluating");
    let evaluation = claim(
        &db,
        &format!("evaluate:{}", candidate["id"].as_str().unwrap()),
    );
    call(&db,json!({"op":"verify_finish","job_id":evaluation["id"],"epoch":1,"report":{"suite":"commands-v1","environment":"linux-node24-rust1.94-v1","setup":[],"commands":[{"name":"build","output":{"exit":0}}]},"evidence":"f".repeat(64)})).unwrap();
    assert_eq!(task(&db, "integrate")["status"], "complete");
    call(&db,json!({"op":"accept","request_id":"team-release","candidate":candidate["id"],"expected_commit":"a".repeat(40),"expected_version":0,"rationale":"The integrated behavior passed"})).unwrap();
    assert_eq!(snapshot(&db)["runs"][0]["status"], "accepted");
}
#[test]
fn handoffs_are_replayed_assertions_and_cannot_complete_tasks() {
    let db = team_repo();
    call(&db, request()).unwrap();
    claim(&db, "job:team:task:search");
    let c = json!({"op":"task_handoff","job_id":"job:team:task:search","epoch":1,"summary":"API designed","interface_contract":"filterEvents(events,query,now)","references":["intent:team"]});
    let h = call(&db, c.clone()).unwrap();
    assert_eq!(h["authority"], "assertion");
    assert_eq!(call(&db, c).unwrap(), h);
    assert_eq!(task(&db, "search")["status"], "running");
    assert_eq!(task(&db, "summary")["status"], "blocked");
    assert_eq!(
        call(
            &db,
            json!({"op":"integration_request","job_id":"job:team:task:search","epoch":1})
        )
        .unwrap_err()
        .code,
        "FORBIDDEN"
    );
    assert_eq!(
        call(
            &db,
            json!({"op":"delegate_agent","job_id":"job:team:task:search","epoch":1})
        )
        .unwrap_err()
        .code,
        "FORBIDDEN"
    );
}
#[test]
fn invalid_dags_and_scopes_roll_back_run_creation() {
    for mutation in [
        "cycle",
        "overlap",
        "prefix-file",
        "out-of-roster",
        "missing",
    ] {
        let db = team_repo();
        let mut c = request();
        match mutation {
            "cycle" => c["team"]["tasks"][0]["depends_on"] = json!(["summary"]),
            "overlap" => c["team"]["tasks"][0]["write_paths"] = json!(["public/"]),
            "prefix-file" => c["team"]["tasks"][0]["write_paths"] = json!(["public"]),
            "out-of-roster" => c["team"]["tasks"][0]["agent"] = json!(3),
            _ => c["team"]["tasks"][0]["depends_on"] = json!(["absent"]),
        }
        assert!(call(&db, c).is_err(), "{mutation}");
        assert_eq!(snapshot(&db)["runs"], json!([]));
        assert_eq!(snapshot(&db)["team_tasks"], json!([]));
    }
}
#[test]
fn capture_rejects_out_of_scope_paths_and_manifest_omission_atomically() {
    let db = team_repo();
    call(&db, request()).unwrap();
    claim(&db, "job:team:task:search");
    call(&db,json!({"op":"finish","job_id":"job:team:task:search","epoch":1,"result":{"workspace":"b".repeat(64)}})).unwrap();
    claim(&db, "capture:team:task:search");
    assert_eq!(call(&db,json!({"op":"finish","job_id":"capture:team:task:search","epoch":1,"result":{"id":"malicious","revision":{"repository":"test/fork","commit":"c".repeat(40)},"tree":"d".repeat(40),"paths":["public/rsvp.js"],"summary":"Wrong task","diff":"x"}})).unwrap_err().code,"WRITE_SCOPE");
    assert_eq!(snapshot(&db)["candidates"], json!([]));
    assert_eq!(task(&db, "search")["status"], "capturing");
    let db = team_repo();
    call(&db, request()).unwrap();
    capture_workers(&db);
    claim(&db, "job:team:task:integrate");
    call(&db,json!({"op":"finish","job_id":"job:team:task:integrate","epoch":1,"result":{"workspace":"b".repeat(64)}})).unwrap();
    claim(&db, "capture:team:task:integrate");
    assert_eq!(call(&db,json!({"op":"finish","job_id":"capture:team:task:integrate","epoch":1,"result":{"id":"missing-manifest","revision":{"repository":"test/fork","commit":"c".repeat(40)},"tree":"d".repeat(40),"paths":["public/index.js"],"summary":"Integrated","diff":"x"}})).unwrap_err().code,"STALE_INTEGRATION");
    assert_eq!(snapshot(&db)["candidates"], json!([]));
}
#[test]
fn retry_fences_late_output_and_keeps_shared_model_accounting() {
    let db = team_repo();
    call(&db, request()).unwrap();
    claim(&db, "job:team:task:search");
    call(
        &db,
        json!({"op":"reserve_request","job_id":"job:team:task:search","epoch":1,"kind":"model","input_bytes":100,"output_tokens":4096}),
    )
    .unwrap();
    call(&db,json!({"op":"fail","job_id":"job:team:task:search","epoch":1,"error":"Fixture failure","retryable":false})).unwrap();
    assert_eq!(task(&db, "summary")["status"], "blocked");
    let retry = json!({"op":"retry_team_task","run_id":"team","task_id":"search","expected_epoch":1,"expected_revision":1});
    let t = call(&db, retry.clone()).unwrap();
    assert_eq!(t["revision"], 2);
    assert_eq!(call(&db, retry).unwrap_err().code, "TASK_MOVED");
    assert_eq!(call(&db,json!({"op":"finish","job_id":"job:team:task:search","epoch":1,"result":{"workspace":"b".repeat(64)}})).unwrap_err().code,"FENCED");
    let j = claim(&db, "job:team:task:search");
    assert_eq!(j["epoch"], 3);
    let n = call(
        &db,
        json!({"op":"reserve_request","job_id":j["id"],"epoch":3,"kind":"model","input_bytes":100,"output_tokens":4096}),
    )
    .unwrap();
    assert_eq!(n["run_number"], 2);
    call(&db, json!({"op":"cancel_run","run_id":"team"})).unwrap();
    assert_eq!(task(&db, "summary")["status"], "cancelled");
    assert_eq!(
        call(&db, json!({"op":"team_context","job_id":j["id"],"epoch":3}))
            .unwrap_err()
            .code,
        "FENCED"
    );
}
#[test]
fn migration_eight_upgrades_v7_and_repeats_without_changing_existing_runs() {
    let db = team_repo();
    call(&db, request()).unwrap();
    db.query("DELETE FROM schema_migrations WHERE version=8", &[])
        .unwrap();
    db.query("DROP TABLE team_handoffs", &[]).unwrap();
    migrate(&db).unwrap();
    migrate(&db).unwrap();
    assert_eq!(
        db.query("SELECT COUNT(*) AS count FROM schema_migrations", &[])
            .unwrap()[0]["count"],
        8
    );
    assert_eq!(snapshot(&db)["runs"][0]["mode"], "collaborate");
}

#[test]
fn acceptance_rejects_intermediate_and_stale_integrated_sources() {
    let db = team_repo();
    call(&db, request()).unwrap();
    capture_workers(&db);
    let intermediate = task(&db, "search")["output"].clone();
    crate::storage::create(&db,"candidates","forged-intermediate",&json!({"id":"forged-intermediate","execution":"team:task:search","run_id":"team","base":{"commit":"a".repeat(40)},"revision":intermediate["revision"],"status":"eligible"})).unwrap();
    assert_eq!(call(&db,json!({"op":"accept","request_id":"bad-intermediate","candidate":"forged-intermediate","expected_commit":"a".repeat(40),"expected_version":0,"rationale":"Do not publish a specialist alone"})).unwrap_err().code,"FORBIDDEN");
    let integration = crate::storage::get(&db, "jobs", "job:team:task:integrate").unwrap();
    captured(
        &db,
        "integrate",
        json!([
            "public/search.js",
            "public/rsvp.js",
            "public/summary.js",
            "public/index.js"
        ]),
        Some(integration["payload"]["integration_digest"].clone()),
    );
    let e = claim(&db, "evaluate:captured-integrate-1");
    call(&db,json!({"op":"verify_finish","job_id":e["id"],"epoch":1,"report":{"suite":"commands-v1","environment":"linux-node24-rust1.94-v1","setup":[],"commands":[{"name":"build","output":{"exit":0}}]},"evidence":"f".repeat(64)})).unwrap();
    db.query("UPDATE team_tasks SET payload=json_set(payload,'$.output.revision.commit',?) WHERE id='team:task:search'",&[json!("e".repeat(40))]).unwrap();
    assert_eq!(call(&db,json!({"op":"accept","request_id":"bad-stale","candidate":"captured-integrate-1","expected_commit":"a".repeat(40),"expected_version":0,"rationale":"Old inputs cannot ship"})).unwrap_err().code,"STALE_INTEGRATION");
    assert_eq!(snapshot(&db)["repository"]["version"], 0);
}

#[test]
fn team_reads_and_citations_keep_source_inclusion_distinct_from_assertion_truth() {
    let db = team_repo();
    call(&db, request()).unwrap();
    claim(&db, "job:team:task:search");
    let assertion=call(&db,json!({"op":"task_handoff","job_id":"job:team:task:search","epoch":1,"summary":"Search follows the agreed API","interface_contract":"filterEvents","references":["intent:team"]})).unwrap();
    call(&db,json!({"op":"finish","job_id":"job:team:task:search","epoch":1,"result":{"workspace":"b".repeat(64)}})).unwrap();
    claim(&db, "capture:team:task:search");
    call(&db,json!({"op":"finish","job_id":"capture:team:task:search","epoch":1,"result":{"id":"search-output","revision":{"repository":"test/search","commit":"c".repeat(40)},"tree":"d".repeat(40),"paths":["public/search.js"],"summary":"Search","diff":"x"}})).unwrap();
    captured(&db, "rsvp", json!(["public/rsvp.js"]), None);
    captured(
        &db,
        "summary",
        json!(["public/search.js", "public/rsvp.js", "public/summary.js"]),
        None,
    );
    let integrator = claim(&db, "job:team:task:integrate");
    let manifest = call(
        &db,
        json!({"op":"integration_request","job_id":integrator["id"],"epoch":1}),
    )
    .unwrap();
    call(&db,json!({"op":"record_context_access","job_id":integrator["id"],"epoch":1,"call_id":"team-manifest-read","tool":"integration_request","stage":"opened","targets":[{"id":manifest["manifest_record"]["id"],"digest":manifest["digest"]}]})).unwrap();
    let context = call(
        &db,
        json!({"op":"team_context","job_id":integrator["id"],"epoch":1}),
    )
    .unwrap();
    let targets: Vec<Value> = context["handoffs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| json!({"id":h["id"]}))
        .collect();
    call(&db,json!({"op":"record_context_access","job_id":integrator["id"],"epoch":1,"call_id":"team-handoffs-read","tool":"team_context","stage":"opened","targets":targets})).unwrap();
    call(&db,json!({"op":"finish","job_id":integrator["id"],"epoch":1,"result":{"workspace":"b".repeat(64)}})).unwrap();
    claim(&db, "capture:team:task:integrate");
    call(&db,json!({"op":"finish","job_id":"capture:team:task:integrate","epoch":1,"result":{"id":"team-result","revision":{"repository":"test/integrate","commit":"d".repeat(40)},"tree":"e".repeat(40),"paths":["public/search.js","public/rsvp.js","public/summary.js","public/index.js"],"summary":"Integrated","diff":"x","integration_digest":manifest["digest"]}})).unwrap();
    claim(&db, "evaluate:team-result");
    call(&db,json!({"op":"verify_finish","job_id":"evaluate:team-result","epoch":1,"report":{"suite":"commands-v1","environment":"linux-node24-rust1.94-v1","setup":[],"commands":[{"name":"build","output":{"exit":0}}]},"evidence":"f".repeat(64)})).unwrap();
    let usage = call(&db, json!({"op":"context_usage","run_id":"team"})).unwrap();
    assert_eq!(usage["counts"]["read_calls"], 2);
    assert_eq!(usage["counts"]["checked"], 1);
    let citation = usage["citations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["record_id"] == assertion["id"])
        .unwrap();
    assert_eq!(citation["authority"], "assertion");
    assert_eq!(
        citation["candidates"][0]["capture_kind"],
        "task_contribution"
    );
    assert_eq!(citation["candidates"][0]["evaluation"], Value::Null);
    assert_eq!(citation["candidates"][1]["capture_kind"], "integration");
    assert_eq!(
        citation["candidates"][1]["source_handoff"],
        "handoff:team:task:search:1"
    );
    assert_eq!(
        citation["candidates"][1]["evaluation"]["candidate_id"],
        "team-result"
    );
}

#[test]
fn sixteen_team_tasks_schedule_with_a_separate_integrator_and_study_mode_fails_closed() {
    let db = team_repo();
    let mut c = request();
    c["team"]["tasks"]=json!((0..16).map(|i|json!({"id":format!("task-{i}"),"title":format!("Task {i}"),"instructions":"Implement assigned module","agent":i%2,"depends_on":[],"write_paths":[format!("src/module_{i}.rs")]})).collect::<Vec<_>>());
    call(&db, c).unwrap();
    assert_eq!(snapshot(&db)["executions"].as_array().unwrap().len(), 2);
    assert_eq!(snapshot(&db)["team_tasks"].as_array().unwrap().len(), 17);
    assert_eq!(
        call(&db, json!({"op":"context_usage","run_id":"team"})).unwrap()["assigned"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(task(&db, "integrate")["status"], "blocked");
    call(&db, json!({"op":"cancel_run","run_id":"team"})).unwrap();
    let db = team_repo();
    db.query(
        "UPDATE repository SET payload=json_set(payload,'$.context_study',json(?)) WHERE id='repo'",
        &[json!({"id":"pilot","arm":"source_only"}).to_string().into()],
    )
    .unwrap();
    assert_eq!(call(&db, request()).unwrap_err().code, "FORBIDDEN");
    assert_eq!(snapshot(&db)["runs"], json!([]));
}
