use super::*;

fn hosted() -> NativeStore {
    let db = repo_with_policy(json!({"version":"intent-v1","suite":"commands-v1",
        "environment":"linux-node24-rust1.94-v1","required_checks":["build"],
        "build":{"checks":[{"name":"build","argv":["node","--check","app.js"],"timeout_seconds":30}]}}));
    run(&db, "build");
    call(&db, json!({"op":"claim","job_id":"job:build:agent-1"})).unwrap();
    db
}
fn run(db: &NativeStore, id: &str) {
    call(
        db,
        json!({"op":"start_run","id":id,"intent":"Build an accessible website",
        "agents":[{"provider":"mimo","model":"mimo-v2.6-flash","strategy":"minimal"},
        {"provider":"zai","model":"glm-4.7-flash","strategy":"accessible"}]}),
    )
    .unwrap();
}
fn publish(id: &str) -> Value {
    json!({"op":"context_publish","job_id":"job:build:agent-1","epoch":1,
        "record":{"id":id,"kind":"finding","statement":"Navigation needs focus styles",
        "purpose":"Guide the assigned implementation","author":"owner","verified":true}})
}
fn snapshot(db: &NativeStore) -> Value {
    call(db, json!({"op":"snapshot"})).unwrap()
}

#[test]
fn hosted_context_derives_missing_intent_and_normalizes_only_its_exact_run_alias() {
    let db = hosted();
    for (i, intent) in [None, Some("build"), Some("intent:build")]
        .into_iter()
        .enumerate()
    {
        let id = format!("context:assigned-{i}");
        let mut command = publish(&id);
        if let Some(intent) = intent {
            command["record"]["intent_id"] = json!(intent);
        }
        let record = call(&db, command).unwrap();
        assert_eq!(record["data"]["intent_id"], "intent:build");
        assert_eq!(record["author"], "build:agent-1");
        assert_eq!(record["data"]["authority"], "assertion");
        assert!(record["data"].get("verified").is_none());
        assert!(
            snapshot(&db)["edges"]
                .as_array()
                .unwrap()
                .iter()
                .any(|edge| {
                    edge["source"] == id
                        && edge["target"] == "intent:build"
                        && edge["relation"] == "addresses"
                })
        );
    }
}

#[test]
fn hosted_repo_context_exposes_its_assigned_canonical_intent() {
    let db = hosted();
    let context = call(
        &db,
        json!({"op":"context","job_id":"job:build:agent-1","epoch":1}),
    )
    .unwrap();
    assert_eq!(context["intent_id"], "intent:build");
    assert_eq!(context["run"]["id"], "build");
    assert_eq!(context["execution"]["id"], "build:agent-1");
}

#[test]
fn context_intent_normalization_preserves_cross_intent_rejection_and_atomic_rollback() {
    let db = hosted();
    run(&db, "other");
    let before = snapshot(&db);
    for intent in ["intent:other", "other", "intent:missing"] {
        let mut command = publish("context:wrong-intent");
        command["record"]["intent_id"] = json!(intent);
        assert_eq!(call(&db, command).unwrap_err().code, "FORBIDDEN");
        assert_eq!(snapshot(&db), before);
    }
    for record in [json!([]), json!(false), json!({"intent_id":null})] {
        let mut command = publish("context:invalid");
        command["record"] = record;
        assert_eq!(call(&db, command).unwrap_err().code, "INVALID_INPUT");
        assert_eq!(snapshot(&db), before);
    }
}

#[test]
fn deriving_context_intent_does_not_bypass_attempt_fencing() {
    let db = hosted();
    let before = snapshot(&db);
    for extra in [json!({"epoch":2}), json!({"now":122000})] {
        let mut command = publish("context:expired");
        for (key, value) in extra.as_object().unwrap() {
            command[key] = value.clone();
        }
        assert_eq!(call(&db, command).unwrap_err().code, "FENCED");
        assert_eq!(snapshot(&db), before);
    }
}

#[test]
fn owner_and_external_context_keep_their_explicit_intent_contract() {
    let db = hosted();
    let mut owner = publish("context:owner");
    owner.as_object_mut().unwrap().remove("job_id");
    owner.as_object_mut().unwrap().remove("epoch");
    assert_eq!(call(&db, owner).unwrap_err().code, "INVALID_INPUT");
    call(
        &db,
        json!({"op":"external_begin","id":"external-one","_grant":"grant-one",
        "fork":"test/external-fork","intent":"Contribute locally"}),
    )
    .unwrap();
    let mut command = publish("context:external");
    command["job_id"] = json!("job:external-one");
    command["_grant"] = json!("grant-one");
    let before = snapshot(&db);
    assert_eq!(
        call(&db, command.clone()).unwrap_err().code,
        "INVALID_INPUT"
    );
    assert_eq!(snapshot(&db), before);
    command["record"]["intent_id"] = json!("intent:run:external-one");
    let record = call(&db, command).unwrap();
    assert_eq!(record["author"], "external-one");
    assert_eq!(record["data"]["intent_id"], "intent:run:external-one");
}
