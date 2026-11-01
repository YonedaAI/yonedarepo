//! Repository events for an org's audit log: each commits with its change, only while the
//! adapter's switch is on; a failed action and a change of nothing record nothing; only the
//! platform hands them over, a tombstone included; and they stay out of webhooks' way.
use super::*;
use crate::native::NativeStore;
use crate::repo_store::execute_repo_store;
use crate::storage::SqlStore;

const AUDIT: &str = "platform:audit";
const HOOKS: &str = "platform:hooks";
const ERASE: &str = "platform:erase";
const REPO: &str = "r0123456789abcdef0123";

fn on(mut c: Value) -> Value {
    c["_audit"] = json!("on");
    c
}

fn rows(h: &Harness) -> i64 {
    h.db.query("SELECT COUNT(*) AS n FROM hook_outbox", &[])
        .unwrap()[0]["n"]
        .as_i64()
        .unwrap()
}

fn pending(h: &Harness) -> Vec<Value> {
    let answer = h.ok(AUDIT, json!({"op":"repo_audit_pending"}));
    assert_eq!(answer["workspace"], "ws-1");
    answer["events"].as_array().unwrap().clone()
}

fn kinds(events: &[Value]) -> Vec<&str> {
    events.iter().map(|e| e["kind"].as_str().unwrap()).collect()
}

fn hook(h: &Harness, c: Value) -> yoneda_core::Result<Value> {
    h.run(
        OWNER,
        on(
            json!({"op":"repo_hook_create","url":"https://ci.example.com/hook/tok3n?key=abc",
        "_secret":"whsec_0123456789abcdef0123456789abcdef","_repo":REPO,
        "_workers_subdomain":"mlong-f01","events":c}),
        ),
    )
}

/// Every audited action, sent as `send` does.
fn every_action(h: &Harness, send: impl Fn(Value) -> Value) {
    for c in [
        json!({"op":"repo_set_visibility","visibility":"public"}),
        json!({"op":"repo_rename","name":"renamed"}),
        json!({"op":"repo_member_put","account":"bob","role":"write"}),
        json!({"op":"repo_member_put","account":"bob","role":"admin"}),
        json!({"op":"repo_member_remove","account":"bob"}),
        json!({"op":"repo_token_create","name":"bot","scopes":["read"],
               "_secret":"bot-secret-0123456789abcdef0123456789"}),
        json!({"op":"repo_token_revoke","name":"bot"}),
        json!({"op":"repo_set_policy","policy":{"required_checks":["lint"],"approvals":2}}),
        json!({"op":"repo_set_retention","keep_versions":100,"keep_days":10}),
    ] {
        h.ok(OWNER, send(c));
    }
}

#[test]
fn an_owners_purge_is_recorded_once_with_who_asked() {
    let h = Harness::new();
    let unseen = pending(&h).len();
    h.ok(OWNER, on(json!({"op":"repo_delete","confirm":"demo"})));
    h.ok("member:ws-1", on(json!({"op":"repo_purge_now"})));
    h.ok("member:ws-1", on(json!({"op":"repo_purge_now"})));
    let events = pending(&h);
    assert_eq!(
        kinds(&events[unseen..]),
        ["repo.deleted", "repo.purge_requested"]
    );
    let requested = &events.last().unwrap()["data"];
    assert_eq!(requested["actor"], "user:ws-1");
    assert_eq!(requested["name"], "demo");
}

#[test]
fn with_the_switch_off_nothing_is_written() {
    let h = Harness::new();
    every_action(&h, |c| c);
    let made = h.ok(
        OWNER,
        json!({"op":"repo_hook_create","url":"https://ci.example.com/hook",
            "_secret":"whsec_0123456789abcdef0123456789abcdef","_repo":REPO,
            "_workers_subdomain":"mlong-f01","events":["land"]}),
    );
    h.ok(OWNER, json!({"op":"repo_hook_delete","hook_id":made["id"]}));
    h.ok(OWNER, json!({"op":"repo_delete","confirm":"renamed"}));
    h.ok(OWNER, json!({"op":"repo_restore"}));
    assert_eq!(rows(&h), 0);
    assert!(pending(&h).is_empty());
}

#[test]
fn a_create_commits_its_event_with_the_repository() {
    let db = Counted::new(NativeStore::memory().unwrap());
    let init = |name: &str| {
        execute_repo_store(
            &db,
            hold_off(on(
                json!({"op":"repo_init","name":name,"object_store":"artifacts:test/demo","now":5,
                       "policy":{"required_checks":[],"approvals":1},"visibility":"public",
                       "_session":{"workspace":"acme","principal":"user:alice"}}),
            )),
        )
    };
    assert_eq!(init(".bad").unwrap_err().code, "INVALID_INPUT");
    init("demo").unwrap();
    // A repeated init is refused, and the first's event stays alone.
    assert_eq!(init("again").unwrap_err().code, "ALREADY_EXISTS");
    let answer = execute_repo_store(
        &db,
        hold_off(json!({"op":"repo_audit_pending","now":6,"_system":"audit"})),
    )
    .unwrap();
    assert_eq!(answer["workspace"], "acme");
    assert_eq!(answer["events"].as_array().unwrap().len(), 1);
    let event = &answer["events"][0];
    assert_eq!(event["kind"], "repo.created");
    assert_eq!(event["at"], 5);
    assert_eq!(event["data"]["actor"], "user:alice");
    assert_eq!(event["data"]["name"], "demo");
    assert_eq!(event["data"]["visibility"], "public");
}

#[test]
fn each_action_commits_its_event_with_its_actor() {
    let h = Harness::new();
    every_action(&h, on);
    let made = hook(&h, json!(["land"])).unwrap();
    h.ok(
        OWNER,
        on(json!({"op":"repo_hook_delete","hook_id":made["id"]})),
    );
    h.ok(OWNER, on(json!({"op":"repo_delete","confirm":"renamed"})));
    h.ok(
        OWNER,
        on(json!({"op":"repo_restore","name":"back","check":true})),
    );
    h.ok(OWNER, on(json!({"op":"repo_restore","name":"back"})));

    let events = pending(&h);
    assert_eq!(
        kinds(&events),
        [
            "repo.visibility_changed",
            "repo.renamed",
            "repo.member_put",
            "repo.member_put",
            "repo.member_removed",
            "repo.token_created",
            "repo.token_revoked",
            "repo.policy_changed",
            "repo.retention_changed",
            "webhook.created",
            "webhook.deleted",
            "repo.deleted",
            "repo.restored",
        ]
    );
    for event in &events {
        assert_eq!(event["data"]["actor"], OWNER, "{event}");
        assert!(event["at"].as_i64().unwrap() > 0);
    }
    let data = |i: usize| &events[i]["data"];
    assert_eq!(data(0)["visibility"], "public");
    assert_eq!(data(1)["name"], "renamed");
    assert_eq!(data(1)["previous"], "demo");
    assert_eq!(data(2)["account"], "bob");
    assert_eq!(data(2)["role"], "write");
    assert_eq!(data(2)["previous"], Value::Null);
    assert_eq!(data(3)["role"], "admin");
    assert_eq!(data(3)["previous"], "write");
    assert_eq!(data(4)["account"], "bob");
    assert_eq!(data(5)["token"], "bot");
    assert_eq!(data(5)["scopes"], json!(["read"]));
    assert_eq!(data(6)["token"], "bot");
    assert_eq!(data(7)["required_checks"], json!(["lint"]));
    assert_eq!(data(7)["approvals"], 2);
    assert!(data(7)["digest"].is_string());
    assert!(data(7)["previous"].is_string());
    assert_ne!(data(7)["digest"], data(7)["previous"]);
    assert_eq!(data(8)["keep_versions"], 100);
    assert_eq!(data(8)["keep_days"], 10);
    assert_eq!(data(9)["id"], made["id"].to_string());
    assert_eq!(data(10)["id"], made["id"].to_string());
    assert_eq!(data(11)["name"], "renamed");
    assert_eq!(data(12)["name"], "back");
    assert_eq!(data(12)["previous"], "renamed");
    // The token's secret never enters: the payload is what the action says it is.
    assert!(!json!(events).to_string().contains("bot-secret"));
}

#[test]
fn a_failed_action_records_nothing() {
    let h = Harness::new();
    for (who, c) in [
        (OWNER, json!({"op":"repo_delete","confirm":"wrong"})),
        (
            OWNER,
            json!({"op":"repo_set_visibility","visibility":"secret"}),
        ),
        (OWNER, json!({"op":"repo_rename","name":".bad"})),
        (
            OWNER,
            json!({"op":"repo_member_put","account":"bob","role":"nope"}),
        ),
        (OWNER, json!({"op":"repo_member_remove","account":"nobody"})),
        (
            OWNER,
            json!({"op":"repo_token_create","name":"bad name!","scopes":["read"],
                   "_secret":"bot-secret-0123456789abcdef0123456789"}),
        ),
        (
            OWNER,
            json!({"op":"repo_token_create","name":"agent","scopes":["read"],
                   "_secret":"bot-secret-0123456789abcdef0123456789"}),
        ),
        (OWNER, json!({"op":"repo_set_policy","policy":"nope"})),
        (OWNER, json!({"op":"repo_set_retention","keep_versions":1})),
        (OWNER, json!({"op":"repo_hook_delete","hook_id":99})),
        // Refused callers.
        (
            "token:agent",
            json!({"op":"repo_set_visibility","visibility":"public"}),
        ),
        ("token:agent", json!({"op":"repo_delete","confirm":"demo"})),
    ] {
        assert!(h.run(who, on(c.clone())).is_err(), "{c}");
    }
    assert_eq!(hook(&h, json!(["nope"])).unwrap_err().code, "INVALID_INPUT");
    assert_eq!(rows(&h), 0);
}

#[test]
fn a_delete_refused_for_its_forks_records_nothing() {
    let h = Harness::new();
    h.db.query(
        "INSERT INTO forks(repo,created_at) VALUES('r00000000000000000099',1)",
        &[],
    )
    .unwrap();
    let e = h
        .run(OWNER, on(json!({"op":"repo_delete","confirm":"demo"})))
        .unwrap_err();
    assert_eq!(e.code, "CONFLICT");
    assert_eq!(rows(&h), 0);
}

#[test]
fn a_change_of_nothing_records_nothing() {
    let h = Harness::new();
    let policy = json!({"required_checks":["unit"],"approvals":1,"check_posters":{"unit":["owner","token:ci"]}});
    for c in [
        json!({"op":"repo_set_visibility","visibility":"private"}),
        json!({"op":"repo_rename","name":"demo"}),
        json!({"op":"repo_rename","name":"other","check":true}),
        json!({"op":"repo_restore","check":true}),
        json!({"op":"repo_restore"}),
        json!({"op":"repo_token_revoke","name":"nobody"}),
        json!({"op":"repo_set_policy","policy":policy}),
    ] {
        h.ok(OWNER, on(c));
    }
    h.ok(
        OWNER,
        on(json!({"op":"repo_set_retention","keep_versions":100})),
    );
    h.ok(
        OWNER,
        on(json!({"op":"repo_member_put","account":"bob","role":"read"})),
    );
    h.ok(AUDIT, json!({"op":"repo_audit_done","through":i64::MAX}));
    h.ok(
        OWNER,
        on(json!({"op":"repo_set_retention","keep_versions":100})),
    );
    h.ok(
        OWNER,
        on(json!({"op":"repo_member_put","account":"bob","role":"read"})),
    );
    h.ok(OWNER, on(json!({"op":"repo_token_revoke","name":"agent"})));
    assert_eq!(kinds(&pending(&h)), ["repo.token_revoked"]);
    h.ok(OWNER, on(json!({"op":"repo_token_revoke","name":"agent"})));
    assert_eq!(pending(&h).len(), 1);
    h.ok(OWNER, on(json!({"op":"repo_delete","confirm":"demo"})));
    h.ok(OWNER, on(json!({"op":"repo_delete","confirm":"demo"})));
    assert_eq!(pending(&h).len(), 2);
}

#[test]
fn only_the_platform_hands_events_over() {
    let h = Harness::new();
    h.ok(
        OWNER,
        on(json!({"op":"repo_set_visibility","visibility":"public"})),
    );
    for who in [OWNER, "token:agent", HOOKS, "member:bob"] {
        for c in [
            json!({"op":"repo_audit_pending"}),
            json!({"op":"repo_audit_done","through":i64::MAX}),
        ] {
            let e = h.run(who, c).unwrap_err();
            assert_eq!(e.code, "FORBIDDEN", "{who}");
        }
    }
    assert_eq!(rows(&h), 1);
}

#[test]
fn settled_events_leave_and_later_ones_stay() {
    let h = Harness::new();
    for visibility in ["public", "private", "public"] {
        h.ok(
            OWNER,
            on(json!({"op":"repo_set_visibility","visibility":visibility})),
        );
    }
    let events = pending(&h);
    assert_eq!(events.len(), 3);
    let first = h.ok(AUDIT, json!({"op":"repo_audit_pending","limit":2}))["events"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(first.len(), 2);
    h.ok(
        AUDIT,
        json!({"op":"repo_audit_done","through":first[1]["seq"]}),
    );
    let left = pending(&h);
    assert_eq!(left.len(), 1);
    assert_eq!(left[0]["seq"], events[2]["seq"]);
    // Handing the same page over twice settles nothing new.
    h.ok(
        AUDIT,
        json!({"op":"repo_audit_done","through":first[1]["seq"]}),
    );
    assert_eq!(pending(&h).len(), 1);
    assert_eq!(
        h.run(AUDIT, json!({"op":"repo_audit_done"}))
            .unwrap_err()
            .code,
        "INVALID_INPUT"
    );
}

#[test]
fn a_tombstone_hands_its_events_over_until_it_is_erased() {
    let h = Harness::new();
    h.ok(OWNER, on(json!({"op":"repo_delete","confirm":"demo"})));
    assert_eq!(kinds(&pending(&h)), ["repo.deleted"]);
    // Anyone else meets GONE, as for every other op on a tombstone.
    let e = h
        .run(OWNER, json!({"op":"repo_audit_pending"}))
        .unwrap_err();
    assert_eq!(e.code, "GONE");
    h.ok(AUDIT, json!({"op":"repo_audit_done","through":i64::MAX}));
    assert_eq!(rows(&h), 0);
    h.ok("platform:purge", json!({"op":"repo_purge_target"}));
    assert!(pending(&h).is_empty());
    while h.ok(ERASE, json!({"op":"repo_erase_step"}))["done"] != true {}
    let e = h
        .run(AUDIT, json!({"op":"repo_audit_pending"}))
        .unwrap_err();
    assert_eq!(e.code, "GONE");
}

#[test]
fn events_stay_out_of_webhooks_way() {
    let h = Harness::new();
    let made = hook(&h, json!(["repo"])).unwrap();
    h.ok(
        OWNER,
        on(json!({"op":"repo_set_visibility","visibility":"public"})),
    );
    // The hook sees its own payloads alone, and its delivery job finds nothing here.
    assert_eq!(
        h.ok(OWNER, json!({"op":"repo_hooks"}))["hooks"][0]["pending"],
        0
    );
    let claim = h.ok(HOOKS, json!({"op":"repo_hook_claim","hook_id":0}));
    assert_eq!(claim["idle"], true);
    assert_eq!(
        h.ok(HOOKS, json!({"op":"repo_hook_claim","hook_id":made["id"]}))["idle"],
        true
    );
    h.ok(OWNER, on(json!({"op":"repo_delete","confirm":"demo"})));
    // A repeated delete resends real hooks' payloads, never an id no hook has.
    let again = h.ok(OWNER, on(json!({"op":"repo_delete","confirm":"demo"})));
    assert_eq!(again["hooks"], json!([made["id"]]));
    // Waiting events hold no erase back, as they are nothing a hook has to deliver.
    h.db.query("UPDATE hooks SET active=0", &[]).unwrap();
    assert!(rows(&h) > 0);
    h.ok("platform:purge", json!({"op":"repo_purge_target"}));
    assert!(h.ok(ERASE, json!({"op":"repo_erase_plan"}))["hooks"].is_null());
}

#[test]
fn with_the_switch_on_an_erase_waits_for_the_log() {
    let h = Harness::new();
    h.ok(OWNER, on(json!({"op":"repo_delete","confirm":"demo"})));
    h.ok("platform:purge", json!({"op":"repo_purge_target"}));
    let step = json!({"op":"repo_erase_step"});
    assert_eq!(h.run(ERASE, on(step.clone())).unwrap_err().code, "CONFLICT");
    assert_eq!(rows(&h), 1);
    // It has them: the erase goes through, the rest of the tables with it.
    h.ok(AUDIT, json!({"op":"repo_audit_done","through":i64::MAX}));
    while h.ok(ERASE, on(step.clone()))["done"] != true {}
    assert_eq!(rows(&h), 0);
}

#[test]
fn with_the_switch_off_what_is_left_goes_with_the_rest() {
    let h = Harness::new();
    h.ok(OWNER, on(json!({"op":"repo_delete","confirm":"demo"})));
    h.ok("platform:purge", json!({"op":"repo_purge_target"}));
    assert_eq!(rows(&h), 1);
    while h.ok(ERASE, json!({"op":"repo_erase_step"}))["done"] != true {}
    assert_eq!(rows(&h), 0);
}

#[test]
fn a_hook_switched_off_for_its_failures_is_an_event() {
    let h = Harness::new();
    let made = hook(&h, json!(["repo"])).unwrap();
    h.ok(AUDIT, json!({"op":"repo_audit_done","through":i64::MAX}));
    h.db.query("UPDATE hooks SET failures=48", &[]).unwrap();
    h.ok(OWNER, on(json!({"op":"repo_delete","confirm":"demo"})));
    h.ok(AUDIT, json!({"op":"repo_audit_done","through":i64::MAX}));
    let settle = |h: &Harness| {
        h.db.query("UPDATE hook_outbox SET next_at=0,lease_until=NULL", &[])
            .unwrap();
        let claim = h.ok(HOOKS, json!({"op":"repo_hook_claim","hook_id":made["id"]}));
        h.ok(
            HOOKS,
            on(
                json!({"op":"repo_hook_settle","hook_id":made["id"],"seq":claim["seq"],
                "attempt":claim["attempt"],"ok":false,"status":500,"ms":1}),
            ),
        )
    };
    assert_eq!(settle(&h)["active"], true);
    assert!(pending(&h).is_empty());
    assert_eq!(settle(&h)["active"], false);
    let events = pending(&h);
    assert_eq!(kinds(&events), ["webhook.disabled"]);
    assert_eq!(events[0]["data"]["actor"], HOOKS);
    assert_eq!(events[0]["data"]["id"], made["id"].to_string());
}

#[test]
fn a_corrupt_event_is_handed_over_as_its_seq_with_what_came_before_it() {
    let h = Harness::new();
    let add = |payload: &str| {
        h.db.query(
            "INSERT INTO hook_outbox(hook_id,event,payload) VALUES(0,'repo.renamed',?)",
            &[json!(payload)],
        )
        .unwrap();
    };
    add(r#"{"name":"good","actor":"user:x","at":1}"#);
    add("not json");
    add(r#"{"name":"later","actor":"user:x","at":2}"#);
    let read = || h.ok(AUDIT, json!({"op":"repo_audit_pending"}));
    let first = read();
    assert_eq!(first["events"].as_array().unwrap().len(), 1);
    assert_eq!(first["corrupt"], 2);
    // Settling what came before it leaves it first in line, naming the same row.
    h.ok(
        AUDIT,
        json!({"op":"repo_audit_done","through":first["events"][0]["seq"]}),
    );
    let next = read();
    assert_eq!(next["events"], json!([]));
    assert_eq!(next["corrupt"], 2);
    assert_eq!(rows(&h), 2);
    assert!(!next.to_string().contains("not json"));
}

#[test]
fn an_event_the_log_would_refuse_is_corrupt_too() {
    for (n, payload) in ["[1,2]", "{\"name\":\"x\"}", "{\"at\":\"soon\"}"]
        .iter()
        .enumerate()
    {
        let h = Harness::new();
        h.db.query(
            "INSERT INTO hook_outbox(hook_id,event,payload) VALUES(0,'repo.renamed',?)",
            &[json!(payload)],
        )
        .unwrap();
        let answer = h.ok(AUDIT, json!({"op":"repo_audit_pending"}));
        assert_eq!(answer["corrupt"], 1, "{n}");
        assert_eq!(answer["events"], json!([]), "{n}");
    }
}

#[test]
fn nothing_corrupt_answers_null() {
    let h = Harness::new();
    h.ok(
        OWNER,
        on(json!({"op":"repo_set_visibility","visibility":"public"})),
    );
    let answer = h.ok(AUDIT, json!({"op":"repo_audit_pending"}));
    assert!(answer["corrupt"].is_null());
    assert_eq!(answer["events"].as_array().unwrap().len(), 1);
}
