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
        {"seq":2,"kind":"repo.not_listed","at":2,"data":{"id":"t",secret:"hunter2-hunter2"}},
        {"seq":3,"kind":"org.team_created","at":3,"data":{"team":{"nested":true},"id":"seven"}},
    ]);
    assert_eq!(append(&db, ORG, events), json!({"appended":2,"cursor":3}));
    let stored = raw(&db);
    for leaked in ["_secret", "hunter2", "ffffffff", "note", "repo.not_listed"] {
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
fn a_repository_is_a_source_with_a_cursor_of_its_own() {
    const REPO: &str = "r0123456789abcdef0123";
    let source = format!("repo:{REPO}");
    let db = log();
    let event = |seq: i64| {
        json!({"seq":seq,"kind":"repo.deleted","at":seq,
            "data":{"name":"demo","actor":"user:alice","repo":"r00000000000000000099"}})
    };
    append(&db, &source, json!([event(4), event(9)]));
    // Handed over again, as after an answer lost between the log and the repository.
    append(&db, &source, json!([event(4), event(9)]));
    append(
        &db,
        ORG,
        json!([{"seq":1,"kind":"org.created","at":1,"data":{}}]),
    );
    let items = rows(&db);
    assert_eq!(items.len(), 3);
    assert_eq!(items[1]["source"], source);
    assert_eq!(items[1]["source_seq"], 9);
    assert_eq!(items[1]["actor"], "user:alice");
    // The repository is the source's, whatever the event says.
    assert_eq!(items[1]["details"], json!({"repo":REPO,"name":"demo"}));
    assert_eq!(
        ok(&db, json!({"op":"audit_cursor","source":source}))["cursor"],
        9
    );
}

#[test]
fn a_repository_event_names_nobody_when_it_names_no_actor() {
    let source = "repo:r0123456789abcdef0123";
    let db = log();
    append(
        &db,
        source,
        json!([{"seq":1,"kind":"repo.deleted","at":1,"data":{"name":"demo"}}]),
    );
    assert_eq!(rows(&db)[0]["actor"], Value::Null);
}

#[test]
fn a_source_is_an_account_or_a_repository_id() {
    let db = log();
    for source in [
        "repo:",
        "repo:demo",
        "repo:R0123456789abcdef0123",
        "device:X",
    ] {
        let e = at(&db, 1000, json!({"op":"audit_cursor","source":source})).unwrap_err();
        assert_eq!(e.code, "INVALID_INPUT", "{source}");
    }
}

#[test]
fn repository_events_keep_only_their_listed_fields() {
    let db = log();
    let source = "repo:r0123456789abcdef0123";
    let digest = "ab".repeat(32);
    let shared = json!({"name":"demo","actor":"user:alice","_secret":"yrp_nope","token_hash":"x"});
    let event = |seq: i64, kind: &str, more: Value| {
        let mut data = shared.clone();
        for (key, value) in more.as_object().unwrap() {
            data[key] = value.clone();
        }
        json!({"seq":seq,"kind":kind,"at":seq,"data":data})
    };
    let events = json!([
        event(
            1,
            "repo.created",
            json!({"visibility":"private","parent":"r00000000000000000009"})
        ),
        event(2, "repo.deleted", json!({})),
        event(3, "repo.restored", json!({"previous":"old"})),
        event(4, "repo.renamed", json!({"previous":"old"})),
        event(5, "repo.visibility_changed", json!({"visibility":"public"})),
        event(
            6,
            "repo.member_put",
            json!({"account":"team:acme/devs","role":"read","previous":"write"})
        ),
        event(7, "repo.member_removed", json!({"account":"bob"})),
        event(
            8,
            "repo.token_created",
            json!({"token":"ci","scopes":["read","check:lint"],"paths":{"x":1}})
        ),
        event(9, "repo.token_revoked", json!({"token":"ci"})),
        event(
            10,
            "repo.policy_changed",
            json!({"digest":digest,"previous":digest,"required_checks":["unit"],"approvals":2,"policy":{"x":1}})
        ),
        event(
            11,
            "repo.retention_changed",
            json!({"keep_versions":100,"keep_days":10})
        ),
        event(
            12,
            "webhook.created",
            json!({"id":"3","url":"https://ci.example.com/tok3n?key=abc"})
        ),
        event(
            13,
            "webhook.deleted",
            json!({"id":"3","url":"https://ci.example.com/tok3n?key=abc"})
        ),
        event(14, "repo.purge_requested", json!({})),
    ]);
    append(&db, source, events);
    let repo = "r0123456789abcdef0123";
    let items = rows(&db);
    assert_eq!(items.len(), 14);
    let details = |kind: &str| {
        items
            .iter()
            .find(|row| row["kind"] == kind)
            .map(|row| row["details"].clone())
            .unwrap()
    };
    assert_eq!(
        details("repo.created"),
        json!({"repo":repo,"name":"demo","visibility":"private","parent":"r00000000000000000009"})
    );
    assert_eq!(details("repo.deleted"), json!({"repo":repo,"name":"demo"}));
    assert_eq!(
        details("repo.purge_requested"),
        json!({"repo":repo,"name":"demo"})
    );
    assert_eq!(
        details("repo.member_put"),
        json!({"repo":repo,"name":"demo","account":"team:acme/devs","role":"read","previous":"write"})
    );
    assert_eq!(
        details("repo.token_created"),
        json!({"repo":repo,"name":"demo","token":"ci","scopes":["read","check:lint"]})
    );
    assert_eq!(
        details("repo.policy_changed"),
        json!({"repo":repo,"name":"demo","digest":digest,"previous":digest,"required_checks":["unit"],"approvals":2})
    );
    assert_eq!(
        details("repo.retention_changed"),
        json!({"repo":repo,"name":"demo","keep_versions":100,"keep_days":10})
    );
    assert_eq!(
        details("webhook.created"),
        json!({"repo":repo,"name":"demo","id":"3","host":"ci.example.com"})
    );
    assert!(!raw(&db).contains("yrp_nope"));
    assert!(!raw(&db).contains("tok3n"));
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

#[test]
fn a_password_reset_and_a_new_recovery_code_reach_the_orgs() {
    let alice = person();
    joined(&alice);
    ok(
        &alice,
        json!({"op":"recovery_regenerate","session_hash":"a".repeat(64),"recovery_hash":"d".repeat(64)}),
    );
    ok(
        &alice,
        json!({"op":"email_change","email":"alice@example.com","token_hash":"e".repeat(64)}),
    );
    ok(
        &alice,
        json!({"op":"email_verify","token_hash":"e".repeat(64)}),
    );
    ok(
        &alice,
        json!({"op":"password_reset_request","token_hash":"f".repeat(64)}),
    );
    ok(
        &alice,
        json!({"op":"password_reset","token_hash":"f".repeat(64),"password":"another long password","salt":"02".repeat(16),"new_recovery_hash":"0".repeat(64)}),
    );
    let db = log();
    copy(&alice, BOB, &db);
    let items = rows(&db);
    assert_eq!(items[0]["kind"], "account.password_reset");
    assert_eq!(items[1]["kind"], "account.recovery_regenerated");
    assert_eq!(items[0]["details"], json!({}));
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

#[test]
fn an_export_is_a_row_of_the_log_itself_and_chains_with_the_rest() {
    let db = log();
    append(&db, ORG, events(2));
    ok(
        &db,
        json!({"op":"audit_exported","actor":"user:alice","format":"csv","kind":"org.created",
            "of_actor":"user:bob","before":9,"secret":"nope"}),
    );
    append(
        &db,
        ORG,
        json!([{"seq":3,"kind":"org.created","at":3,"data":{}}]),
    );
    let items = rows(&db);
    assert_eq!(items.len(), 4);
    let row = &items[1];
    assert_eq!(row["kind"], "audit.exported");
    assert_eq!(row["actor"], "user:alice");
    assert_eq!(row["source"], "log");
    assert_eq!(
        row["details"],
        json!({"format":"csv","kind":"org.created","of_actor":"user:bob","before":9})
    );
    assert_eq!(verified(&db)["ok"], true);
    // It moves no source's cursor, and a person's authority has no log to write to.
    let cursor = ok(&db, json!({"op":"audit_cursor","source":ORG}));
    assert_eq!(cursor["cursor"], 3);
    let e = at(
        &person(),
        1,
        json!({"op":"audit_exported","actor":"user:alice","format":"csv"}),
    );
    assert_eq!(e.unwrap_err().code, "INVALID_INPUT");
}

/// `audit_seal_next` at `now`.
fn seal_next(db: &NativeStore, now: i64, all: bool) -> Value {
    at(db, now, json!({"op":"audit_seal_next","all":all})).unwrap()
}
fn seal_done(db: &NativeStore, seal: &Value) -> Value {
    ok(
        db,
        json!({"op":"audit_seal_done","to":seal["to"],"hash":seal["hash"]}),
    )
}

#[test]
fn a_segment_falls_due_when_it_is_old_when_it_is_full_or_when_asked() {
    const DAY: i64 = 24 * 60 * 60 * 1000;
    let db = log();
    assert_eq!(seal_next(&db, 1, true)["due"], false);
    append(&db, ORG, events(3));
    // The first row is from 1001.
    assert_eq!(seal_next(&db, 1001 + DAY - 1, false)["due"], false);
    assert_eq!(seal_next(&db, 1001 + DAY, false)["due"], true);
    let asked = seal_next(&db, 2000, true);
    assert_eq!(asked["to"], 3);
    seal_done(&db, &asked);

    let full: Vec<Value> = (4..=1003)
        .map(|n| json!({"seq":n,"kind":"org.created","at":DAY * 2,"data":{}}))
        .collect();
    for page in full.chunks(100) {
        append(&db, ORG, json!(page));
    }
    let next = seal_next(&db, DAY * 2, false);
    assert_eq!(next["due"], true);
    assert_eq!(next["from"], 4);
    assert_eq!(next["to"], 1003);
}

#[test]
fn a_segment_holds_the_rows_as_they_read_and_follows_the_last() {
    let db = log();
    append(&db, ORG, events(3));
    let first = seal_next(&db, 4, true);
    assert_eq!(first["from"], 1);
    assert_eq!(first["to"], 3);
    assert_eq!(first["previous"], "");
    let mut read = rows(&db);
    read.reverse();
    assert_eq!(first["rows"], json!(read));
    assert_eq!(first["hash"], read[2]["hash"]);
    // Nothing moves until the object is said to be written.
    assert_eq!(seal_next(&db, 4, true)["from"], 1);
    assert_eq!(seal_done(&db, &first)["through"], 3);
    assert_eq!(seal_next(&db, 4, true)["due"], false);
    // A repeat, or a slower copy of an older range, leaves the seal where it is.
    assert_eq!(seal_done(&db, &first)["through"], 3);
    append(
        &db,
        ORG,
        json!([{"seq":4,"kind":"org.created","at":4,"data":{}}]),
    );
    let second = seal_next(&db, 5, true);
    assert_eq!(second["from"], 4);
    assert_eq!(second["previous"], first["hash"]);
}

#[test]
fn only_the_logs_own_row_moves_a_seal() {
    let db = log();
    append(&db, ORG, events(2));
    for (to, hash) in [(2, "f".repeat(64)), (9, "f".repeat(64))] {
        let e = at(&db, 5, json!({"op":"audit_seal_done","to":to,"hash":hash}));
        assert_eq!(e.unwrap_err().code, "INVALID_INPUT");
    }
    assert_eq!(seal_next(&db, 5, true)["from"], 1);
    for command in [
        json!({"op":"audit_seal_next"}),
        json!({"op":"audit_seal_done","to":1,"hash":"h"}),
    ] {
        assert_eq!(at(&person(), 1, command).unwrap_err().code, "INVALID_INPUT");
    }
}
