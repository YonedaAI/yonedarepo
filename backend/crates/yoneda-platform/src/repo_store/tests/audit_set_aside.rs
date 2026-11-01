//! Setting one corrupt audit event aside (`audit_outbox::set_aside`): it can only ever touch a
//! row the log could never take, says nothing of what the row held, and leaves its own event
//! where the row was, so the log and any erase move on and the repair shows.
use super::*;
use crate::storage::SqlStore;

const AUDIT: &str = "platform:audit";
const ERASE: &str = "platform:erase";
const SECRET: &str = "hunter2-not-for-any-answer";

fn on(mut c: Value) -> Value {
    c["_audit"] = json!("on");
    c
}
fn add(h: &Harness, kind: &str, payload: &str) -> i64 {
    h.db.query(
        "INSERT INTO hook_outbox(hook_id,event,payload) VALUES(0,?,?)",
        &[json!(kind), json!(payload)],
    )
    .unwrap();
    h.db.query("SELECT MAX(seq) AS s FROM hook_outbox", &[])
        .unwrap()[0]["s"]
        .as_i64()
        .unwrap()
}
const GOOD: &str = r#"{"name":"demo","actor":"user:x","at":1}"#;
fn corrupt(h: &Harness) -> i64 {
    add(h, "repo.renamed", &format!("{{\"token\":\"{SECRET}\""))
}
fn stored(h: &Harness, seq: i64) -> Vec<Value> {
    h.db.query(
        "SELECT hook_id,event,payload FROM hook_outbox WHERE seq=?",
        &[json!(seq)],
    )
    .unwrap()
}
fn ask(seq: i64) -> Value {
    on(json!({"op":"repo_audit_set_aside","seq":seq,"check":true}))
}
fn set(seq: i64, bytes: &Value) -> Value {
    on(json!({"op":"repo_audit_set_aside","seq":seq,"bytes":bytes,"operator":"ops"}))
}
fn pending(h: &Harness) -> Value {
    h.ok(AUDIT, json!({"op":"repo_audit_pending"}))
}

#[test]
fn a_dry_run_says_what_it_would_do_and_changes_nothing() {
    let h = Harness::new();
    let seq = corrupt(&h);
    let before = stored(&h, seq);
    let answer = h.ok(AUDIT, ask(seq));
    assert_eq!(answer["state"], "corrupt");
    assert_eq!(answer["seq"], seq);
    assert_eq!(answer["kind"], "repo.renamed");
    assert_eq!(answer["bytes"], SECRET.len() + 11);
    assert_eq!(stored(&h, seq), before);
    assert!(!answer.to_string().contains("hunter2"));
}

#[test]
fn a_healthy_event_is_refused_and_stays_as_it_was() {
    let h = Harness::new();
    let seq = add(&h, "repo.renamed", GOOD);
    let before = stored(&h, seq);
    for command in [ask(seq), set(seq, &json!(GOOD.len()))] {
        let e = h.run(AUDIT, command).unwrap_err();
        assert_eq!(e.code, "CONFLICT");
        assert!(e.message.contains("healthy"), "{}", e.message);
    }
    assert_eq!(stored(&h, seq), before);
}

#[test]
fn every_shape_the_log_takes_is_healthy() {
    for payload in [
        r#"{"at":1}"#,
        r#"{"at":1,"anything":{"nested":[1,2]}}"#,
        r#"{"at":-1,"name":null}"#,
    ] {
        let h = Harness::new();
        let seq = add(&h, "some.future_kind", payload);
        assert_eq!(
            h.run(AUDIT, ask(seq)).unwrap_err().code,
            "CONFLICT",
            "{payload}"
        );
    }
}

#[test]
fn a_webhooks_row_is_not_an_audit_event_whatever_it_holds() {
    let h = Harness::new();
    h.db.query(
        "INSERT INTO hook_outbox(hook_id,event,payload) VALUES(7,'land','not json')",
        &[],
    )
    .unwrap();
    let seq =
        h.db.query("SELECT MAX(seq) AS s FROM hook_outbox", &[])
            .unwrap()[0]["s"]
            .as_i64()
            .unwrap();
    assert_eq!(h.ok(AUDIT, ask(seq))["state"], "absent");
    assert_eq!(h.ok(AUDIT, set(seq, &json!(8)))["state"], "absent");
    assert_eq!(stored(&h, seq)[0]["payload"], "not json");
}

#[test]
fn a_row_that_changed_since_the_dry_run_is_left_alone() {
    let h = Harness::new();
    let seq = corrupt(&h);
    let e = h.run(AUDIT, set(seq, &json!(1))).unwrap_err();
    assert_eq!(e.code, "CONFLICT");
    assert_eq!(stored(&h, seq)[0]["event"], "repo.renamed");
    let unsigned = on(json!({"op":"repo_audit_set_aside","seq":seq,"operator":"ops"}));
    assert_eq!(h.run(AUDIT, unsigned).unwrap_err().code, "INVALID_INPUT");
    let bytes = h.ok(AUDIT, ask(seq))["bytes"].clone();
    let nobody = on(json!({"op":"repo_audit_set_aside","seq":seq,"bytes":bytes}));
    assert_eq!(h.run(AUDIT, nobody).unwrap_err().code, "INVALID_INPUT");
    assert_eq!(stored(&h, seq)[0]["event"], "repo.renamed");
}

#[test]
fn set_aside_it_leaves_its_own_event_in_its_place_and_the_line_moves_on() {
    let h = Harness::new();
    let before = add(&h, "repo.renamed", GOOD);
    let seq = corrupt(&h);
    let after = add(&h, "repo.renamed", GOOD);
    assert_eq!(pending(&h)["corrupt"], seq);

    let bytes = h.ok(AUDIT, ask(seq))["bytes"].clone();
    let done = h.ok(AUDIT, set(seq, &bytes));
    assert_eq!(done["state"], "set_aside");
    assert_eq!(done["kind"], "repo.renamed");
    assert!(!done.to_string().contains("hunter2"));

    let page = pending(&h);
    assert!(page["corrupt"].is_null());
    let events = page["events"].as_array().unwrap();
    let seqs: Vec<i64> = events.iter().map(|e| e["seq"].as_i64().unwrap()).collect();
    assert_eq!(seqs, [before, seq, after]);
    let marker = &events[1];
    assert_eq!(marker["kind"], "audit.row_set_aside");
    assert_eq!(marker["data"]["actor"], "operator:ops");
    assert_eq!(marker["data"]["row"], seq);
    assert_eq!(marker["data"]["of_kind"], "repo.renamed");
    assert_eq!(marker["data"]["name"], "demo");
    assert!(marker["at"].as_i64().unwrap() > 0);
    // The bytes are gone from this row, and nothing but the marker replaced them.
    assert!(!stored(&h, seq)[0].to_string().contains("hunter2"));
}

#[test]
fn a_repeat_changes_nothing_and_says_so() {
    let h = Harness::new();
    let seq = corrupt(&h);
    let bytes = h.ok(AUDIT, ask(seq))["bytes"].clone();
    h.ok(AUDIT, set(seq, &bytes));
    let marked = stored(&h, seq);
    assert_eq!(h.ok(AUDIT, set(seq, &bytes))["state"], "already");
    assert_eq!(h.ok(AUDIT, ask(seq))["state"], "already");
    assert_eq!(stored(&h, seq), marked);
    // Copied and settled, the row is simply not there any more.
    h.ok(AUDIT, json!({"op":"repo_audit_done","through":seq}));
    assert_eq!(h.ok(AUDIT, set(seq, &bytes))["state"], "absent");
    assert_eq!(h.ok(AUDIT, ask(seq))["state"], "absent");
}

#[test]
fn it_never_leaves_a_repair_without_a_trail() {
    let h = Harness::new();
    let seq = corrupt(&h);
    let bytes = h.ok(AUDIT, ask(seq))["bytes"].clone();
    let mut off = set(seq, &bytes);
    off.as_object_mut().unwrap().remove("_audit");
    assert_eq!(h.run(AUDIT, off).unwrap_err().code, "CONFLICT");
    assert_eq!(stored(&h, seq)[0]["event"], "repo.renamed");
}

#[test]
fn only_the_platform_may_ask() {
    let h = Harness::new();
    let seq = corrupt(&h);
    for who in [OWNER, "token:agent", "platform:hooks", "platform:purge"] {
        assert_eq!(h.run(who, ask(seq)).unwrap_err().code, "FORBIDDEN", "{who}");
    }
}

#[test]
fn a_tombstone_can_be_repaired_until_it_is_erased_and_then_its_erase_goes_on() {
    let h = Harness::new();
    h.ok(OWNER, on(json!({"op":"repo_delete","confirm":"demo"})));
    let seq = corrupt(&h);
    h.ok("platform:purge", json!({"op":"repo_purge_target"}));
    assert_eq!(h.run(OWNER, ask(seq)).unwrap_err().code, "GONE");
    let step = on(json!({"op":"repo_erase_step"}));
    assert_eq!(h.run(ERASE, step.clone()).unwrap_err().code, "CONFLICT");

    let bytes = h.ok(AUDIT, ask(seq))["bytes"].clone();
    h.ok(AUDIT, set(seq, &bytes));
    assert_eq!(h.run(ERASE, step.clone()).unwrap_err().code, "CONFLICT");
    h.ok(AUDIT, json!({"op":"repo_audit_done","through":i64::MAX}));
    while h.ok(ERASE, step.clone())["done"] != true {}
    assert_eq!(h.run(AUDIT, ask(seq)).unwrap_err().code, "GONE");
}

#[test]
fn an_empty_kind_is_corrupt_too_as_the_log_could_never_take_it() {
    let h = Harness::new();
    let seq = add(&h, "", GOOD);
    assert_eq!(pending(&h)["corrupt"], seq);
    let answer = h.ok(AUDIT, ask(seq));
    assert_eq!(answer["state"], "corrupt");
    assert_eq!(answer["kind"], "unknown");
}

#[test]
fn a_kind_that_is_not_one_shows_as_unknown() {
    let h = Harness::new();
    let seq = add(&h, &format!("ghp_{SECRET}"), "not json");
    let answer = h.ok(AUDIT, ask(seq));
    assert_eq!(answer["kind"], "unknown");
    assert!(!answer.to_string().contains("hunter2"));
}

#[test]
fn a_held_repository_keeps_its_corrupt_row() {
    let h = Harness::new();
    let seq = corrupt(&h);
    let bytes = h.ok(AUDIT, ask(seq))["bytes"].clone();
    let mut held = set(seq, &bytes);
    held["_hold"] = json!({"held": true});
    assert_eq!(h.run(AUDIT, held).unwrap_err().code, "LEGAL_HOLD");
    assert_eq!(stored(&h, seq)[0]["event"], "repo.renamed");
}
