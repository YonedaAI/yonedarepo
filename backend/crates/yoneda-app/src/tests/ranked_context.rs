use super::*;
use crate::storage::node;
use crate::storage::{get, save};

#[test]
fn ranked_pages_hold_a_watermark_as_new_context_arrives() {
    let db = repo();
    for (id, at) in [("one", 1), ("two", 2), ("three", 3)] {
        node(
            &db,
            id,
            "finding",
            "Registration behavior",
            "owner",
            at,
            json!({"statement":"Registration keeps safe retries","file_paths":["src/api.mjs"]}),
        )
        .unwrap();
    }
    let first = call(&db,json!({"op":"context_search","ranked":true,"query":"Registration","file_path":"src/api.mjs","limit":1})).unwrap();
    assert_eq!(first["items"][0]["id"], "three");
    node(
        &db,
        "new",
        "finding",
        "Registration behavior",
        "owner",
        4,
        json!({"statement":"Registration changed","file_paths":["src/api.mjs"]}),
    )
    .unwrap();
    let second = call(&db,json!({"op":"context_search","ranked":true,"query":"Registration","file_path":"src/api.mjs","limit":1,"cursor":first["next_cursor"]})).unwrap();
    assert_eq!(second["items"][0]["id"], "two");
    assert_eq!(second["watermark"], first["watermark"]);
    assert!(call(&db,json!({"op":"context_search","ranked":true,"query":"Different","file_path":"src/api.mjs","cursor":first["next_cursor"]})).is_err());
}

#[test]
fn previous_run_constraints_survive_large_unrelated_history() {
    let db = repo();
    node(
        &db,
        "constraint-old",
        "constraint",
        "Preserve USD cents",
        "owner",
        1,
        json!({"statement":"Money must remain integer cents","intent_id":"intent:previous"}),
    )
    .unwrap();
    for index in 0..1001 {
        node(
            &db,
            &format!("noise-{index}"),
            "finding",
            "Unrelated interface finding",
            "owner",
            100 + index,
            json!({"statement":"Unrelated interface finding"}),
        )
        .unwrap();
    }
    let found=call(&db,json!({"op":"context_search","ranked":true,"query":"Add waitlist","lineage":"previous","limit":10})).unwrap();
    assert_eq!(found["items"][0]["id"], "constraint-old");
    assert_eq!(found["items"][0]["retrieval"]["authority"], "assertion");
}

fn hosted() -> NativeStore {
    let db = repo_with_policy(single_agent::policy());
    call(&db,json!({"op":"start_run","id":"retrieval","intent":"Preserve booking capacity and SQLite registrations","agents":[{"provider":"mimo","model":"mimo-v2.6-flash","strategy":"retrieval"}]})).unwrap();
    call(&db, json!({"op":"claim","job_id":"job:retrieval:agent-1"})).unwrap();
    db
}

fn search(query: &str) -> Value {
    json!({"op":"context_search","job_id":"job:retrieval:agent-1","epoch":1,"query":query,"limit":50})
}

#[test]
fn hosted_search_ranks_nonadjacent_terms_and_current_intent_without_an_opt_in() {
    let db = hosted();
    node(
        &db,
        "capacity-rule",
        "constraint",
        "Cancellation must release an occupied booking slot",
        "owner",
        1,
        json!({"statement":"Waitlist promotion follows cancellation while preserving capacity"}),
    )
    .unwrap();
    let result = call(&db, search("waitlist cancellation")).unwrap();
    assert!(
        result["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|x| x["id"] == "capacity-rule")
    );
    let current = call(&db, search("capacity booking")).unwrap();
    assert_eq!(current["items"][0]["id"], "intent:retrieval");
    assert_eq!(current["items"][0]["retrieval"]["lineage_match"], true);
    let owner = call(
        &db,
        json!({"op":"context_search","query":"waitlist cancellation"}),
    )
    .unwrap();
    assert!(
        owner["items"].as_array().unwrap().is_empty(),
        "Owner legacy search remains literal"
    );
}

fn study(db: &NativeStore, arm: &str) {
    for (id, label) in [
        ("selected-rule", "Selected booking capacity constraint"),
        ("future-seed", "Future booking capacity stage constraint"),
    ] {
        node(
            db,
            id,
            "constraint",
            label,
            "owner",
            1,
            json!({"statement":label}),
        )
        .unwrap();
    }
    let mut run = get(db, "runs", "retrieval").unwrap();
    run["context_study"] = json!({"id":"frozen-stage","case":"event_booking_maintenance","arm":arm,"corpus":["selected-rule"],"records":[get(db,"nodes","selected-rule").unwrap(),get(db,"nodes","future-seed").unwrap()]});
    save(db, "runs", "retrieval", &run).unwrap();
}

#[test]
fn ranked_study_search_and_get_exclude_unselected_future_seed_before_paging() {
    let db = hosted();
    study(&db, "graph");
    for index in 0..1001 {
        node(
            &db,
            &format!("future-noise-{index}"),
            "constraint",
            "Booking capacity future noise",
            "owner",
            100 + index,
            json!({"statement":"Booking capacity future noise"}),
        )
        .unwrap();
    }
    let mut query = search("booking capacity");
    query["ranked"] = json!(true);
    query["limit"] = json!(1);
    let result = call(&db, query).unwrap();
    assert_eq!(result["items"][0]["id"], "selected-rule");
    assert_eq!(result["next_cursor"], Value::Null);
    let direct =
        json!({"op":"context_get","job_id":"job:retrieval:agent-1","epoch":1,"id":"future-seed"});
    assert_eq!(call(&db, direct).unwrap_err().code, "FORBIDDEN");
    assert_eq!(
        call(&db, json!({"op":"context_get","id":"future-seed"})).unwrap()["id"],
        "future-seed"
    );
    assert_eq!(call(&db,json!({"op":"context_get","job_id":"job:retrieval:agent-1","epoch":1,"id":"selected-rule"})).unwrap()["id"],"selected-rule");
}

#[test]
fn hosted_retrieval_is_denied_in_source_only_and_plain_notes_study_arms() {
    for arm in ["source_only", "plain_notes"] {
        let db = hosted();
        study(&db, arm);
        assert_eq!(
            call(&db, search("booking capacity")).unwrap_err().code,
            "FORBIDDEN"
        );
        assert_eq!(call(&db,json!({"op":"context_get","job_id":"job:retrieval:agent-1","epoch":1,"id":"selected-rule"})).unwrap_err().code,"FORBIDDEN");
        assert!(call(&db, json!({"op":"context_get","id":"selected-rule"})).is_ok());
    }
}

#[test]
fn ranked_hosted_queries_match_bounded_purpose_and_id_as_well_as_statement() {
    let db = hosted();
    node(&db,"neutral-capacity-rule","constraint","Preserve persisted registrations","owner",1,json!({"statement":"Capacity must account for pending registrations","purpose":"Preserve booking integrity across feature and bugfix work"})).unwrap();
    node(&db,"context:booking:architecture","finding","Retain datastore decisions","owner",1,json!({"statement":"Retain immutable checked decisions","purpose":"Document datastore behavior"})).unwrap();
    let booking = call(&db, search("booking")).unwrap();
    assert!(
        booking["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|x| x["id"] == "neutral-capacity-rule")
    );
    let both = call(&db, search("booking capacity")).unwrap();
    let relevant = both["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == "neutral-capacity-rule")
        .unwrap();
    assert_eq!(relevant["retrieval"]["score"], 40);
    let id = call(&db, search("booking architecture")).unwrap();
    assert!(
        id["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|x| x["id"] == "context:booking:architecture" && x["retrieval"]["score"] == 20)
    );
}

#[test]
fn frozen_study_pager_allows_trusted_current_context_and_keeps_its_json_watermark() {
    let db = hosted();
    study(&db, "graph");
    let publish = |id: &str| {
        call(&db,json!({"op":"context_publish","job_id":"job:retrieval:agent-1","epoch":1,"record":{"id":id,"kind":"finding","statement":"Booking preserves capacity","purpose":"Current run observation"}})).unwrap()
    };
    publish("context:current-observation");
    assert_eq!(call(&db,json!({"op":"context_get","job_id":"job:retrieval:agent-1","epoch":1,"id":"context:current-observation"})).unwrap()["id"],"context:current-observation");
    let mut query = search("booking capacity");
    query["limit"] = json!(1);
    let first = call(&db, query.clone()).unwrap();
    assert_eq!(first["items"][0]["id"], "context:current-observation");
    let cursor: Value = serde_json::from_str(first["next_cursor"].as_str().unwrap()).unwrap();
    assert_eq!(cursor["offset"], 1);
    assert_eq!(cursor["watermark"], first["watermark"]);
    assert!(cursor["fingerprint"].is_string());
    publish("context:later-observation");
    query["cursor"] = first["next_cursor"].clone();
    let next = call(&db, query).unwrap();
    assert_eq!(next["items"][0]["id"], "selected-rule");
    assert_eq!(next["watermark"], first["watermark"]);
    assert_eq!(next["next_cursor"], Value::Null);
}
