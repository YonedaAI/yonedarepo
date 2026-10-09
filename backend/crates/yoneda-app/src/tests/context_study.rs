use super::*;
fn config(arm: &str) -> Value {
    json!({"id":"trial-one","case":"website_update","arm":arm,"corpus":["context:colors"]})
}
fn seeded() -> NativeStore {
    let db = repo_with_policy(single_agent::policy());
    call(
        &db,
        json!({"op":"start_run","id":"seed","intent":"Fixture corpus",
        "agents":[{"provider":"mimo","model":"mimo-v2.6-flash","strategy":"minimal"}]}),
    )
    .unwrap();
    call(
        &db,
        json!({"op":"context_publish","record":{"id":"context:colors","kind":"constraint",
        "statement":"Preserve blue colors","purpose":"Trial corpus","intent_id":"intent:seed"}}),
    )
    .unwrap();
    call(&db, json!({"op":"cancel_run","run_id":"seed"})).unwrap();
    db
}
#[test]
fn study_corpus_is_owner_configured_frozen_and_separate_from_assigned_context() {
    let db = seeded();
    let frozen = call(&db, json!({"op":"configure_context_study","_workspace":"_admin","context_study":config("graph")})).unwrap();
    assert_eq!(frozen["records"][0]["id"], "context:colors");
    let run = call(&db, json!({"op":"start_run","id":"trial","intent":"Improve website","context":["context:colors"],
        "agents":[{"provider":"mimo","model":"mimo-v2.6-flash","strategy":"minimal"}],
        "delegation":{"enabled":true,"max_depth":1,"max_executions":2}})).unwrap();
    assert_eq!(run["context"], json!([]));
    assert_eq!(run["context_records"], json!([]));
    assert_eq!(run["context_study"], frozen);
    let parent = call(&db, json!({"op":"claim","job_id":"job:trial:agent-1"})).unwrap();
    assert_eq!(parent["payload"]["execution"]["context"], json!([]));
    let child = call(&db, json!({"op":"delegate_agent","job_id":parent["id"],"epoch":1,
        "request_id":"small-task","task":"Implement a small independent update","strategy":"focused"})).unwrap();
    let job = call(&db, json!({"op":"claim","job_id":child["job_id"]})).unwrap();
    assert_eq!(job["payload"]["run"]["context_study"], frozen);
    assert_eq!(job["payload"]["execution"]["context"], json!([]));
    assert_eq!(call(&db, json!({"op":"configure_context_study","_workspace":"_admin","context_study":config("plain_notes")})).unwrap_err().code, "INVALID_STATE");
}
#[test]
fn study_configuration_rejects_spoofed_records_grants_missing_corpus_and_active_setup() {
    let db = seeded();
    assert_eq!(call(&db, json!({"op":"configure_context_study","_workspace":"other","context_study":config("graph")})).unwrap_err().code, "FORBIDDEN");
    assert_eq!(call(&db, json!({"op":"configure_context_study","_workspace":"_admin","_grant":"grant","context_study":config("graph")})).unwrap_err().code, "FORBIDDEN");
    let mut spoofed = config("plain_notes");
    spoofed["records"] = json!([{"id":"fake","statement":"Spoofed corpus"}]);
    assert_eq!(
        call(
            &db,
            json!({"op":"configure_context_study","_workspace":"_admin","context_study":spoofed})
        )
        .unwrap_err()
        .code,
        "INVALID_INPUT"
    );
    let before = call(&db, json!({"op":"snapshot"})).unwrap();
    let mut missing = config("graph");
    missing["corpus"] = json!(["context:missing"]);
    assert_eq!(
        call(
            &db,
            json!({"op":"configure_context_study","_workspace":"_admin","context_study":missing})
        )
        .unwrap_err()
        .code,
        "NOT_FOUND"
    );
    assert_eq!(call(&db, json!({"op":"snapshot"})).unwrap(), before);
    call(
        &db,
        json!({"op":"start_run","id":"active","intent":"Setup still active",
        "agents":[{"provider":"mimo","model":"mimo-v2.6-flash","strategy":"minimal"}]}),
    )
    .unwrap();
    assert_eq!(call(&db, json!({"op":"configure_context_study","_workspace":"_admin","context_study":config("graph")})).unwrap_err().code, "RUN_ACTIVE");
}
#[test]
fn local_contributions_get_the_same_frozen_study_without_inline_history() {
    let db = seeded();
    let study = call(&db, json!({"op":"configure_context_study","_workspace":"_admin","context_study":config("source_only")})).unwrap();
    let job = call(
        &db,
        json!({"op":"external_begin","id":"local-trial","_grant":"grant-one",
        "fork":"test/local-trial","intent":"Local trial","context":["context:colors"]}),
    )
    .unwrap();
    assert_eq!(job["payload"]["run"]["context_study"], study);
    assert_eq!(job["payload"]["run"]["context"], json!([]));
    assert_eq!(job["payload"]["run"]["context_records"], json!([]));
}

#[test]
fn personal_project_owner_can_configure_a_disposable_trial_without_an_auth_bypass() {
    let db = NativeStore::memory().unwrap();
    call(&db, json!({"op":"init","id":"personal-study","name":"Context study fixture","workspace":"alice",
        "remote":{"namespace":"yoneda-test","name":"personal-study"},"commit":"a".repeat(40),"policy":single_agent::policy()})).unwrap();
    call(
        &db,
        json!({"op":"start_run","_workspace":"alice","id":"seed","intent":"Corpus seed",
        "agents":[{"provider":"mimo","model":"mimo-v2.6-flash","strategy":"minimal"}]}),
    )
    .unwrap();
    call(&db, json!({"op":"context_publish","_workspace":"alice","record":{"id":"context:colors","kind":"constraint",
        "statement":"Keep blue","purpose":"Trial corpus","intent_id":"intent:seed"}})).unwrap();
    call(
        &db,
        json!({"op":"cancel_run","_workspace":"alice","run_id":"seed"}),
    )
    .unwrap();
    assert_eq!(call(&db, json!({"op":"configure_context_study","_workspace":"bob","context_study":config("graph")})).unwrap_err().code, "FORBIDDEN");
    let frozen = call(&db, json!({"op":"configure_context_study","_workspace":"alice","context_study":config("graph")})).unwrap();
    let run = call(&db, json!({"op":"start_run","_workspace":"alice","id":"personal-trial","intent":"Improve website",
        "agents":[{"provider":"mimo","model":"mimo-v2.6-flash","strategy":"minimal"}]})).unwrap();
    assert_eq!(run["context_study"], frozen);
}

#[test]
fn only_plain_notes_counts_frozen_study_records_as_assigned_inputs() {
    for arm in ["source_only", "plain_notes", "graph"] {
        let db = seeded();
        call(&db, json!({"op":"configure_context_study","_workspace":"_admin","context_study":config(arm)})).unwrap();
        let run = call(
            &db,
            json!({"op":"start_run","id":"trial","intent":"Study update",
            "agents":[{"provider":"mimo","model":"mimo-v2.6-flash","strategy":"minimal"}]}),
        )
        .unwrap();
        assert_eq!(run["context"], json!([]));
        assert_eq!(run["context_records"], json!([]));
        let usage = call(&db, json!({"op":"context_usage","run_id":"trial"})).unwrap();
        assert_eq!(
            usage["counts"]["assigned"],
            if arm == "plain_notes" { 1 } else { 0 }
        );
        assert_eq!(usage["counts"]["read_calls"], 0);
        if arm == "plain_notes" {
            assert_eq!(usage["assigned"][0]["targets"][0]["id"], "context:colors");
            assert_eq!(
                usage["assigned"][0]["targets"][0]["label"],
                "Preserve blue colors"
            );
        } else {
            assert_eq!(usage["assigned"][0]["targets"], json!([]));
        }
    }
}
