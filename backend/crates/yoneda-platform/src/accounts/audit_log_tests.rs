//! The audit log: rows reach it from their sources once, in a chain any edit breaks; only
//! allow-listed fields enter; who reads it; and what a person's own log records.
use super::audit_details::field_names;
use super::execute_workspace;
use crate::{native::NativeStore, storage::SqlStore};
use serde_json::{Value, json};

const ORG: &str = "account:acme";

fn at(db: &NativeStore, now: i64, mut command: Value) -> yoneda_core::Result<Value> {
    command["now"] = json!(now);
    execute_workspace(db, command)
}
fn ok(db: &NativeStore, command: Value) -> Value {
    at(db, 1000, command).unwrap()
}
fn log() -> NativeStore {
    NativeStore::memory().unwrap()
}
fn acme() -> NativeStore {
    let db = log();
    ok(&db, json!({"op":"org_create","org":"acme","actor":"alice"}));
    db
}
fn person() -> NativeStore {
    let db = log();
    ok(
        &db,
        json!({"op":"signup","username":"alice","password":"a long test password","salt":"01".repeat(16),"recovery_hash":"b".repeat(64),"session_hash":"a".repeat(64)}),
    );
    db
}
/// `n` events from the org: `org.member_put` of `m1`, `m2`, ….
fn events(n: i64) -> Value {
    Value::Array(
        (1..=n)
            .map(|seq| {
                json!({"seq":seq,"kind":"org.member_put","at":1000+seq,
                "data":{"account":format!("m{seq}"),"role":"member","actor":"user:alice"}})
            })
            .collect(),
    )
}
fn append(db: &NativeStore, source: &str, events: Value) -> Value {
    ok(
        db,
        json!({"op":"audit_append","org":"acme","source":source,"events":events}),
    )
}
fn rows(db: &NativeStore) -> Vec<Value> {
    ok(db, json!({"op":"audit_read"}))["items"]
        .as_array()
        .unwrap()
        .clone()
}
/// Copies the org's own pending events into `db`, as the adapter does.
fn copy(from: &NativeStore, source: &str, to: &NativeStore) -> Value {
    let after = ok(to, json!({"op":"audit_cursor","source":source}))["cursor"].clone();
    let pending = ok(
        from,
        json!({"op":"audit_pending","org":"acme","after":after}),
    );
    append(to, source, pending["events"].clone())
}
fn verified(db: &NativeStore) -> Value {
    ok(db, json!({"op":"audit_verify"}))
}
fn raw(db: &NativeStore) -> String {
    let events = db
        .query("SELECT kind,data FROM workspace_events", &[])
        .unwrap();
    let records = db
        .query("SELECT id,payload FROM workspace_records", &[])
        .unwrap();
    format!("{events:?} {records:?}")
}

#[test]
fn rows_carry_their_source_and_chain_each_to_the_one_before() {
    let db = log();
    assert_eq!(
        append(&db, ORG, events(3)),
        json!({"appended":3,"cursor":3})
    );
    let items = rows(&db);
    assert_eq!(items.len(), 3);
    assert_eq!(items[0]["seq"], 3);
    assert_eq!(items[0]["actor"], "user:alice");
    assert_eq!(items[0]["source"], ORG);
    assert_eq!(items[0]["source_seq"], 3);
    assert_eq!(items[0]["at"], 1003);
    assert_eq!(items[0]["details"], json!({"account":"m3","role":"member"}));
    assert_eq!(items[0]["previous"], items[1]["hash"]);
    assert_eq!(items[1]["previous"], items[2]["hash"]);
    assert_eq!(items[2]["previous"], "");
    assert_eq!(verified(&db), json!({"ok":true,"checked":3,"next":null}));
}

#[test]
fn a_repeat_delivery_appends_nothing_and_each_source_counts_alone() {
    let db = log();
    append(&db, ORG, events(2));
    assert_eq!(
        append(&db, ORG, events(3)),
        json!({"appended":1,"cursor":3})
    );
    assert_eq!(
        append(&db, ORG, events(3)),
        json!({"appended":0,"cursor":3})
    );
    // The same numbers from another source are other events. It's a member's, whose
    // events name no actor: it acted itself.
    let member = json!([{"seq":1,"kind":"pat.revoked","at":5,"data":{"id":"pat_1"}}]);
    assert_eq!(
        append(&db, "account:bob", member),
        json!({"appended":1,"cursor":1})
    );
    let items = rows(&db);
    assert_eq!(items.len(), 4);
    assert_eq!(items[0]["actor"], "user:bob");
    assert_eq!(verified(&db)["ok"], true);
}

#[test]
fn an_edited_row_breaks_the_chain_at_that_row() {
    for (sql, broken) in [
        (
            "UPDATE workspace_events SET data=replace(data,'m2','m9') WHERE seq=2",
            2,
        ),
        (
            "UPDATE workspace_events SET kind='org.deleted' WHERE seq=2",
            2,
        ),
        ("UPDATE workspace_events SET at=1 WHERE seq=2", 2),
        (
            "UPDATE workspace_events SET data=replace(data,'user:alice','user:eve') WHERE seq=3",
            3,
        ),
    ] {
        let db = log();
        append(&db, ORG, events(4));
        db.query(sql, &[]).unwrap();
        let answer = verified(&db);
        assert_eq!(answer["ok"], false, "{sql}");
        assert_eq!(answer["broken_at"], broken, "{sql}");
    }
}

#[test]
fn a_removed_row_breaks_the_chain_even_the_newest() {
    let db = log();
    append(&db, ORG, events(4));
    db.query("DELETE FROM workspace_events WHERE seq=2", &[])
        .unwrap();
    assert_eq!(verified(&db)["broken_at"], 2);

    let db = log();
    append(&db, ORG, events(4));
    db.query("DELETE FROM workspace_events WHERE seq=4", &[])
        .unwrap();
    assert_eq!(verified(&db)["broken_at"], 4);
}

#[test]
fn a_rehashed_forgery_still_breaks_at_the_next_row() {
    let db = log();
    append(&db, ORG, events(3));
    let row = db
        .query(
            "SELECT seq,kind,at,data FROM workspace_events WHERE seq=2",
            &[],
        )
        .unwrap();
    let mut data: Value = serde_json::from_str(row[0]["data"].as_str().unwrap()).unwrap();
    data["details"]["account"] = json!("mallory");
    let body = json!({"seq":2,"kind":row[0]["kind"],"at":row[0]["at"],"actor":data["actor"],
        "source":data["source"],"source_seq":data["source_seq"],"details":data["details"]});
    data["hash"] =
        json!(yoneda_core::fingerprint(&json!({"previous":data["previous"],"row":body})).unwrap());
    db.query(
        "UPDATE workspace_events SET data=? WHERE seq=2",
        &[json!(data.to_string())],
    )
    .unwrap();
    assert_eq!(verified(&db)["broken_at"], 3);
}

#[test]
fn verifying_walks_a_page_at_a_time() {
    let db = log();
    append(&db, ORG, events(5));
    let first = ok(&db, json!({"op":"audit_verify","limit":3}));
    assert_eq!(first, json!({"ok":true,"checked":3,"next":3}));
    let rest = ok(&db, json!({"op":"audit_verify","limit":3,"after":3}));
    assert_eq!(rest, json!({"ok":true,"checked":2,"next":null}));
}

#[test]
fn reads_page_by_seq_and_filter_by_kind_and_actor() {
    let db = log();
    let mut all = events(5).as_array().unwrap().clone();
    // Every row at the same moment: time couldn't page these.
    for event in &mut all {
        event["at"] = json!(7);
    }
    all.push(
        json!({"seq":6,"kind":"org.team_deleted","at":7,"data":{"team":"devs","actor":"user:bob"}}),
    );
    append(&db, ORG, Value::Array(all));
    let page = ok(&db, json!({"op":"audit_read","limit":2}));
    assert_eq!(page["items"][0]["seq"], 6);
    assert_eq!(page["next"], 5);
    let page = ok(&db, json!({"op":"audit_read","limit":4,"before":5}));
    assert_eq!(page["items"].as_array().unwrap().len(), 4);
    assert_eq!(page["items"][3]["seq"], 1);
    assert_eq!(page["next"], Value::Null);
    let kind = ok(&db, json!({"op":"audit_read","kind":"org.team_deleted"}));
    assert_eq!(kind["items"].as_array().unwrap().len(), 1);
    let actor = ok(&db, json!({"op":"audit_read","actor":"user:bob"}));
    assert_eq!(actor["items"][0]["seq"], 6);
    let none = ok(&db, json!({"op":"audit_read","actor":"user:nobody"}));
    assert_eq!(none["items"], json!([]));
}

#[test]
fn only_owners_may_read_it() {
    let db = acme();
    ok(
        &db,
        json!({"op":"org_member_put","actor":"alice","account":"bob","role":"member"}),
    );
    assert_eq!(
        ok(&db, json!({"op":"org_audit","actor":"alice"})),
        json!({"org":"acme"})
    );
    for stranger in ["bob", "eve"] {
        let refused = at(&db, 1000, json!({"op":"org_audit","actor":stranger})).unwrap_err();
        assert_eq!(refused.code, "FORBIDDEN", "{stranger}");
    }
}

#[test]
fn an_account_authority_never_holds_a_log() {
    let refused = at(
        &acme(),
        1000,
        json!({"op":"audit_append","org":"acme","source":ORG,"events":[]}),
    );
    assert_eq!(refused.unwrap_err().code, "INVALID_INPUT");
    let bad_source = at(
        &log(),
        1000,
        json!({"op":"audit_cursor","source":"device:X"}),
    );
    assert_eq!(bad_source.unwrap_err().code, "INVALID_INPUT");
}

#[test]
fn only_allow_listed_fields_enter_and_unknown_kinds_leave_no_row() {
    let db = log();
    let secret = "_secret";
    let events = json!([
        {"seq":1,"kind":"org.member_put","at":1,"data":{"account":"bob","role":"member",
            "actor":"user:alice",secret:"hunter2-hunter2","token_hash":"f".repeat(64),"note":"x"}},
        {"seq":2,"kind":"repo.token_created","at":2,"data":{"id":"t",secret:"hunter2-hunter2"}},
        {"seq":3,"kind":"org.team_created","at":3,"data":{"team":{"nested":true},"id":"seven"}},
    ]);
    assert_eq!(append(&db, ORG, events), json!({"appended":2,"cursor":3}));
    let stored = raw(&db);
    for leaked in [
        "_secret",
        "hunter2",
        "ffffffff",
        "note",
        "repo.token_created",
    ] {
        assert!(!stored.contains(leaked), "{leaked} in {stored}");
    }
    // Fields of the wrong type are dropped, not stringified.
    assert_eq!(rows(&db)[0]["details"], json!({}));
}

#[test]
fn the_allow_list_names_no_secret_field() {
    let mut fields = 0;
    for (kind, name) in field_names() {
        fields += 1;
        for forbidden in [
            "secret", "password", "hash", "cookie", "verifier", "key_b64",
        ] {
            assert!(!name.contains(forbidden), "{kind}.{name}");
        }
    }
    assert!(fields > 15);
}

#[test]
fn reasons_are_scanned_and_capped() {
    let db = log();
    let token = format!("ghp_{}", "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hJ3lN6");
    let long = "x".repeat(500);
    let events = json!([
        {"seq":1,"kind":"ssh_key.removed","at":1,"data":{"id":"ssh_1","reason":format!("leaked {token} in a log")}},
        {"seq":2,"kind":"ssh_key.removed","at":1,"data":{"id":"ssh_2","reason":long}},
        // A credential past the cap is still found first, and no fragment of it stays.
        {"seq":3,"kind":"ssh_key.removed","at":1,"data":{"id":"ssh_3","reason":format!("{} {token}", "y".repeat(189))}},
    ]);
    append(&db, ORG, events);
    let items = rows(&db);
    assert_eq!(
        items[2]["details"]["reason"],
        "leaked [REDACTED:github-token] in a log"
    );
    assert_eq!(
        items[1]["details"]["reason"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        200
    );
    assert!(
        !items[0]["details"]["reason"]
            .as_str()
            .unwrap()
            .contains("ghp_")
    );
    assert!(!raw(&db).contains("aB3dE6gH9jK2mN5p"));
}

#[test]
fn a_webhook_url_logs_its_host_only() {
    let db = log();
    let events = json!([
        {"seq":1,"kind":"webhook.created","at":1,"data":{"id":"hook_1",
            "url":"https://user:pass@Hooks.Example.com:8443/path/tok3n?key=abc#frag"}},
        {"seq":2,"kind":"webhook.deleted","at":1,"data":{"id":"hook_1","url":"ftp://x.example/"}},
    ]);
    append(&db, ORG, events);
    let items = rows(&db);
    assert_eq!(
        items[1]["details"],
        json!({"id":"hook_1","host":"hooks.example.com"})
    );
    assert_eq!(items[0]["details"], json!({"id":"hook_1"}));
    for leaked in ["pass", "tok3n", "abc", "8443", "frag"] {
        assert!(!raw(&db).contains(leaked), "{leaked}");
    }
}

#[test]
fn the_orgs_own_events_arrive_with_their_actors_once() {
    let org = acme();
    let db = log();
    ok(
        &org,
        json!({"op":"org_member_put","actor":"alice","account":"bob","role":"member"}),
    );
    assert_eq!(copy(&org, ORG, &db)["appended"], 2);
    assert_eq!(copy(&org, ORG, &db)["appended"], 0);
    ok(
        &org,
        json!({"op":"org_member_put","actor":"alice","account":"bob","role":"owner"}),
    );
    // A copy that failed loses nothing: the next one starts at the cursor.
    assert_eq!(copy(&org, ORG, &db)["appended"], 1);
    let items = rows(&db);
    assert_eq!(items[0]["kind"], "org.member_put");
    assert_eq!(items[0]["actor"], "user:alice");
    assert_eq!(
        items[0]["details"],
        json!({"account":"bob","role":"owner","previous":"member"})
    );
    assert_eq!(items[2]["kind"], "org.created");
    assert_eq!(items[2]["actor"], "user:alice");
}

#[test]
fn an_event_from_before_actors_names_nobody() {
    let db = log();
    let old = json!([{"seq":1,"kind":"org.team_deleted","at":1,"data":{"team":"old"}}]);
    append(&db, ORG, old);
    assert_eq!(rows(&db)[0]["actor"], Value::Null);
}

fn token(org: Value) -> Value {
    json!({"op":"pat_create","id":"pat_0123456789abcdef","name":"ci","token_hash":"c".repeat(64),
        "scopes":["repo:read"],"org":org,"expires_days":1})
}
fn joined(db: &NativeStore) {
    ok(db, json!({"op":"org_hint_add","org":"acme"}));
}
const BOB: &str = "account:alice";

#[test]
fn a_members_org_limited_token_reaches_the_org() {
    let alice = person();
    joined(&alice);
    let db = log();
    ok(&alice, token(json!("acme")));
    ok(
        &alice,
        json!({"op":"pat_revoke","id":"pat_0123456789abcdef"}),
    );
    assert_eq!(copy(&alice, BOB, &db)["appended"], 2);
    let items = rows(&db);
    assert_eq!(items[1]["kind"], "pat.created");
    assert_eq!(items[1]["actor"], "user:alice");
    assert_eq!(items[1]["details"]["org"], "acme");
    assert_eq!(items[1]["details"]["scopes"], json!(["repo:read"]));
    assert_eq!(items[0]["kind"], "pat.revoked");
    assert_eq!(items[0]["details"]["org"], "acme");
}

#[test]
fn other_tokens_and_a_strangers_never_reach_the_org() {
    let alice = person();
    joined(&alice);
    ok(&alice, token(Value::Null));
    let stranger = person();
    ok(&stranger, token(json!("acme")));
    let db = log();
    assert_eq!(copy(&alice, BOB, &db)["appended"], 0);
    assert_eq!(copy(&stranger, BOB, &db)["appended"], 0);
}

const KEY: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJCFG1MqHVbmDrGBB3CKcDmbsEQFHjzlqaEVG/RtBvA8";

#[test]
fn a_members_ssh_keys_reach_each_of_their_orgs() {
    let alice = person();
    joined(&alice);
    let id = "ssh_0123456789abcdef";
    ok(
        &alice,
        json!({"op":"ssh_key_add","id":id,"title":"laptop","public_key":KEY}),
    );
    ok(&alice, json!({"op":"ssh_key_remove","id":id}));
    let db = log();
    assert_eq!(copy(&alice, BOB, &db)["appended"], 2);
    let items = rows(&db);
    assert_eq!(items[1]["kind"], "ssh_key.added");
    assert!(
        items[1]["details"]["fingerprint"]
            .as_str()
            .unwrap()
            .starts_with("SHA256:")
    );
    assert_eq!(items[0]["kind"], "ssh_key.removed");
    assert!(!raw(&db).contains("laptop"));
}

#[test]
fn an_account_recovery_tells_its_orgs_what_it_revoked() {
    let alice = person();
    joined(&alice);
    ok(&alice, token(json!("acme")));
    ok(
        &alice,
        json!({"op":"ssh_key_add","id":"ssh_0123456789abcdef","title":"laptop","public_key":KEY}),
    );
    ok(
        &alice,
        json!({"op":"recover","recovery_hash":"b".repeat(64),"password":"another long password","salt":"02".repeat(16),"new_recovery_hash":"d".repeat(64)}),
    );
    let db = log();
    copy(&alice, BOB, &db);
    let items = rows(&db);
    assert_eq!(items[0]["kind"], "account.recovered");
    assert_eq!(items[0]["details"], json!({"tokens":1,"ssh_keys":1}));
}

/// Sign-in rows of the person's own log, oldest first: `(kind, data)`.
fn own(db: &NativeStore) -> Vec<(String, Value)> {
    db.query(
        "SELECT kind,data FROM workspace_events WHERE kind LIKE 'auth.%' ORDER BY seq",
        &[],
    )
    .unwrap()
    .iter()
    .map(|r| {
        (
            r["kind"].as_str().unwrap().to_owned(),
            serde_json::from_str(r["data"].as_str().unwrap()).unwrap(),
        )
    })
    .collect()
}
fn login(password: &str) -> Value {
    json!({"op":"login","password":password,"session_hash":"e".repeat(64),"audit_log":true})
}
const PASSWORD: &str = "a long test password";

#[test]
fn switched_off_nothing_new_is_written() {
    let db = person();
    let quiet = |mut c: Value| {
        c["audit_log"] = Value::Null;
        c
    };
    ok(&db, quiet(login(PASSWORD)));
    ok(&db, quiet(login("wrong password here")));
    ok(&db, json!({"op":"logout","session_hash":"e".repeat(64)}));
    assert!(own(&db).is_empty());
    assert!(!raw(&db).contains("login_failed"));
}

#[test]
fn a_persons_sign_ins_stay_on_their_own_log() {
    let db = person();
    joined(&db);
    ok(&db, login(PASSWORD));
    ok(
        &db,
        json!({"op":"logout","session_hash":"e".repeat(64),"audit_log":true}),
    );
    // Logging out of no session logs nothing.
    ok(
        &db,
        json!({"op":"logout","session_hash":"9".repeat(64),"audit_log":true}),
    );
    ok(
        &db,
        json!({"op":"device_noted","approved":true,"client":"yoneda cli","host":"laptop","audit_log":true}),
    );
    ok(
        &db,
        json!({"op":"device_noted","approved":false,"client":"yoneda cli","host":null,"audit_log":true}),
    );
    let kinds: Vec<_> = own(&db).into_iter().map(|(kind, _)| kind).collect();
    assert_eq!(
        kinds,
        [
            "auth.login",
            "auth.logout",
            "auth.device_approved",
            "auth.device_denied"
        ]
    );
    let org_log = log();
    assert_eq!(copy(&db, BOB, &org_log)["appended"], 0);
}

#[test]
fn an_oauth_sign_in_is_recorded_with_its_provider() {
    let db = log();
    let identity = json!({"provider":"github","subject":"7","login":"alice"});
    let mut signup = identity.clone();
    signup["op"] = json!("identity_signup");
    signup["username"] = json!("alice");
    signup["session_hash"] = json!("a".repeat(64));
    ok(&db, signup);
    let mut signin = identity;
    signin["op"] = json!("identity_signin");
    signin["session_hash"] = json!("b".repeat(64));
    signin["audit_log"] = json!(true);
    assert_eq!(ok(&db, signin)["authenticated"], true);
    assert_eq!(own(&db)[0].1, json!({"method":"github"}));
}

#[test]
fn failed_logins_share_one_row_an_hour() {
    let db = person();
    let hour = 60 * 60 * 1000;
    let wrong = login("wrong password here");
    for minute in 0..12 {
        let now = 1000 + minute * 5 * 60_000;
        assert_eq!(at(&db, now, wrong.clone()).unwrap()["authenticated"], false);
    }
    assert_eq!(own(&db).len(), 1);
    assert_eq!(own(&db)[0].1, json!({"earlier":0}));
    at(&db, 1000 + hour, wrong.clone()).unwrap();
    let rows = own(&db);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1].1, json!({"earlier":11}));
}

#[test]
fn attempts_the_account_limited_leave_no_row() {
    let db = person();
    let wrong = login("wrong password here");
    for _ in 0..30 {
        ok(&db, wrong.clone());
    }
    assert_eq!(own(&db).len(), 1);
    let window = db
        .query(
            "SELECT payload FROM workspace_records WHERE id='login_failed'",
            &[],
        )
        .unwrap();
    assert!(
        window[0]["payload"]
            .as_str()
            .unwrap()
            .contains(r#""count":10"#)
    );
}

#[test]
fn a_persons_log_keeps_its_newest_sign_ins() {
    let db = person();
    for i in 0..1005 {
        ok(
            &db,
            json!({"op":"device_noted","approved":true,"client":format!("c{i}"),"host":null,"audit_log":true}),
        );
    }
    let rows = own(&db);
    assert_eq!(rows.len(), 1000);
    assert_eq!(rows[0].1["client"], "c5");
    assert_eq!(rows[999].1["client"], "c1004");
    // Other events aren't trimmed with them.
    assert!(raw(&db).contains("account.created"));
}

#[test]
fn device_text_is_scanned_before_it_is_kept() {
    let db = person();
    let token = format!("ghp_{}", "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hJ3lN6");
    ok(
        &db,
        json!({"op":"device_noted","approved":true,"client":token,"host":null,"audit_log":true}),
    );
    assert!(!raw(&db).contains("ghp_"));
}
