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

fn booking_trial(arm: &str) -> NativeStore {
    let db = NativeStore::memory().unwrap();
    call(&db, json!({"op":"init","id":"booking","name":"Disposable booking study","workspace":"reviewer",
        "remote":{"namespace":"test","name":"booking"},"commit":"a".repeat(40),"policy":single_agent::policy(),
        "context_seed":{"intent_id":"intent:seed","statement":"Staged maintenance experiment","records":[
            {"id":"context:capacity","kind":"constraint","statement":"Reject registration once the event is full","purpose":"Initial capacity contract"},
            {"id":"context:waitlist","kind":"requirement","statement":"Add a waitlist in the next feature run","purpose":"Future feature contract"},
            {"id":"context:duplicate","kind":"finding","statement":"Prevent duplicate registration retries","purpose":"Later bug-fix contract"}]},
        "context_study":{"id":"booking-v2","case":"event_booking_maintenance","arm":arm,
            "corpus":["context:capacity","context:waitlist","context:duplicate"]}})).unwrap();
    db
}

fn stage_request(id: &str, ids: Value) -> Value {
    json!({"op":"start_run","id":id,"_workspace":"reviewer","intent":"Initial registration app: full event returns 409; no waitlist yet",
        "agents":[{"provider":"codex","model":"gpt-5.6-luna","strategy":"Implement current intent"}],
        "current_context_ids":ids,
        "model_budgets":[{"provider":"codex","model":"gpt-5.6-luna","max_requests":8,"max_output_tokens":4096,
            "max_execution_ms":600000,"spend_limit_microusd":2000000,
            "pricing":{"input_microusd_per_million":250000,"output_microusd_per_million":1200000,"source":"owner-approved conservative rates"}}],
        "campaign":{"id":"booking-study","version":2,"chain_id":id,"bucket":"routine","purpose":"routine"}})
}

fn sign_stage(mut command: Value) -> Value {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    let mut public = command.clone();
    for field in [
        "op",
        "now",
        "_workspace",
        "_campaign_grant",
        "_campaign_signing_key",
    ] {
        public.as_object_mut().unwrap().remove(field);
    }
    let claims = json!({"workspace":"reviewer","repo_id":"booking","run_id":command["id"],
        "campaign":command["campaign"],"model_budgets":command["model_budgets"],
        "request_digest":yoneda_core::fingerprint(&public).unwrap(),"expires":61000});
    let key = "1".repeat(64);
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).unwrap();
    mac.update(
        format!(
            "yoneda:campaign-grant:v1\0{}",
            yoneda_core::fingerprint(&claims).unwrap()
        )
        .as_bytes(),
    );
    let signature: String = mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    command["_campaign_grant"] = json!({"claims":claims,"signature":signature});
    command["_campaign_signing_key"] = json!(key);
    command
}

#[test]
fn signed_stage_corpus_excludes_future_requirements_and_stays_frozen() {
    for arm in ["source_only", "plain_notes", "graph"] {
        let db = booking_trial(arm);
        let initial = call(
            &db,
            sign_stage(stage_request("initial", json!(["context:capacity"]))),
        )
        .unwrap();
        assert_eq!(
            initial["context_study"]["corpus"],
            json!(["context:capacity"])
        );
        assert_eq!(
            initial["context_study"]["records"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            initial["context_study"]["records"][0]["id"],
            "context:capacity"
        );
        call(
            &db,
            json!({"op":"cancel_run","_workspace":"reviewer","run_id":"initial"}),
        )
        .unwrap();
        let feature = call(
            &db,
            sign_stage(stage_request(
                "feature",
                json!(["context:waitlist", "context:capacity"]),
            )),
        )
        .unwrap();
        assert_eq!(
            feature["context_study"]["corpus"],
            json!(["context:waitlist", "context:capacity"])
        );
        assert_eq!(
            feature["context_study"]["records"][0]["id"],
            "context:waitlist"
        );
        let snapshot = call(&db, json!({"op":"snapshot"})).unwrap();
        assert_eq!(
            snapshot["repository"]["context_study"]["corpus"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
        assert_eq!(
            snapshot["runs"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["id"] == "initial")
                .unwrap()["context_study"],
            initial["context_study"]
        );
    }
}

#[test]
fn stage_selection_requires_a_signed_owner_request_and_known_unique_nonempty_ids() {
    let db = booking_trial("graph");
    let before = call(&db, json!({"op":"snapshot"})).unwrap();
    let mut unsigned = stage_request("unsigned", json!(["context:capacity"]));
    unsigned.as_object_mut().unwrap().remove("campaign");
    assert_eq!(call(&db, unsigned).unwrap_err().code, "FORBIDDEN");
    for ids in [
        json!([]),
        json!(["context:unknown"]),
        json!(["context:capacity", "context:capacity"]),
    ] {
        assert_eq!(
            call(&db, sign_stage(stage_request("invalid", ids)))
                .unwrap_err()
                .code,
            "INVALID_INPUT"
        );
    }
    let mut tampered = sign_stage(stage_request("tampered", json!(["context:capacity"])));
    tampered["current_context_ids"] = json!(["context:waitlist"]);
    assert_eq!(call(&db, tampered).unwrap_err().code, "FORBIDDEN");
    assert_eq!(call(&db, json!({"op":"snapshot"})).unwrap(), before);
}
