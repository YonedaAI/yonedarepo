use super::*;
use crate::native::NativeStore;
fn at(db: &NativeStore, now: i64, mut c: Value) -> yoneda_core::Result<Value> {
    c["now"] = json!(now);
    execute_workspace(db, c)
}
fn call(db: &NativeStore, c: Value) -> Value {
    at(db, 1000, c).unwrap()
}
fn org() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    call(&db, json!({"op":"org_create","org":"acme","actor":"alice"}));
    db
}
fn add(db: &NativeStore, role: &str) {
    call(
        db,
        json!({"op":"org_member_put","actor":"alice","account":"bob","role":role}),
    );
}
fn pending(db: &NativeStore) -> Vec<Value> {
    call(db, json!({"op":"member_notices_pending"}))["notices"]
        .as_array()
        .unwrap()
        .clone()
}
#[test]
fn a_new_membership_is_atomically_pending_and_repeated_put_does_not_duplicate_it() {
    let db = org();
    for role in ["member", "member", "owner"] {
        add(&db, role);
    }
    let rows = pending(&db);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["recipient"], "bob");
}
#[test]
fn notice_failure_rolls_back_the_membership_grant() {
    let db = org();
    db.query("CREATE TRIGGER fail_notice BEFORE INSERT ON org_member_notices BEGIN SELECT RAISE(ABORT,'fixture'); END",&[]).unwrap();
    assert!(
        at(
            &db,
            1000,
            json!({"op":"org_member_put","actor":"alice","account":"bob","role":"member"})
        )
        .is_err()
    );
    let shown = call(&db, json!({"op":"org_show","actor":"alice"}));
    assert_eq!(shown["members"].as_array().unwrap().len(), 1);
}
#[test]
fn removal_cancels_pending_work_and_real_readdition_has_a_new_event() {
    let db = org();
    add(&db, "member");
    let old = pending(&db)[0]["id"].clone();
    call(
        &db,
        json!({"op":"org_member_remove","actor":"alice","account":"bob"}),
    );
    assert!(pending(&db).is_empty());
    add(&db, "member");
    let new = pending(&db)[0]["id"].clone();
    assert_ne!(old, new);
    assert!(call(&db, json!({"op":"member_notice_claim","id":old}))["notice"].is_null());
}
#[test]
fn delivery_leases_fence_concurrent_and_expired_finishers() {
    let db = org();
    add(&db, "member");
    let id = pending(&db)[0]["id"].clone();
    let first = call(&db, json!({"op":"member_notice_claim","id":id}))["notice"].clone();
    assert_eq!(
        call(&db, json!({"op":"member_notice_claim","id":id}))["busy"],
        true
    );
    let second =
        at(&db, 62000, json!({"op":"member_notice_claim","id":id})).unwrap()["notice"].clone();
    assert!(
        at(
            &db,
            62001,
            json!({"op":"member_notice_finish","id":id,"epoch":first["epoch"],"email_state":"sent"})
        )
        .is_err()
    );
    at(
        &db,
        62001,
        json!({"op":"member_notice_finish","id":id,"epoch":second["epoch"],"email_state":"sent"}),
    )
    .unwrap();
    assert!(pending(&db).is_empty());
}
#[test]
fn acknowledgement_uncertainty_does_not_resend_past_provider_window() {
    let db = org();
    add(&db, "member");
    let id = pending(&db)[0]["id"].clone();
    let claim = call(&db, json!({"op":"member_notice_claim","id":id}))["notice"].clone();
    assert_eq!(
        call(
            &db,
            json!({"op":"member_notice_mail_begin","id":id,"epoch":claim["epoch"]})
        )["allowed"],
        true
    );
    let now = 24 * 60 * 60 * 1000;
    let next = at(&db, now, json!({"op":"member_notice_claim","id":id})).unwrap()["notice"].clone();
    assert_eq!(
        at(
            &db,
            now,
            json!({"op":"member_notice_mail_begin","id":id,"epoch":next["epoch"]})
        )
        .unwrap()["allowed"],
        false
    );
    at(&db,now,json!({"op":"member_notice_finish","id":id,"epoch":next["epoch"],"email_state":"uncertain"})).unwrap();
    let row = db
        .query("SELECT email_state FROM org_member_notices", &[])
        .unwrap();
    assert_eq!(row[0]["email_state"], "uncertain");
}
#[test]
fn recipient_inbox_is_idempotent_and_acknowledges_only_stored_rows() {
    let db = NativeStore::memory().unwrap();
    call(
        &db,
        json!({"op":"signup","username":"bob","password":"long test password","salt":"01".repeat(16),"recovery_hash":"b".repeat(64),"session_hash":"a".repeat(64)}),
    );
    for _ in 0..2 {
        call(
            &db,
            json!({"op":"notification_put","org":"acme","id":1,"role":"member","at":999}),
        );
    }
    let inbox = call(&db, json!({"op":"notifications_list"}));
    assert_eq!(inbox["unread"], 1);
    assert_eq!(inbox["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        call(&db, json!({"op":"notifications_read","through":999}))["unread"],
        0
    );
    call(
        &db,
        json!({"op":"notification_put","org":"acme","id":1,"role":"member","at":999}),
    );
    assert_eq!(call(&db, json!({"op":"notifications_list"}))["unread"], 0);
}

#[test]
fn preceding_schema_upgrade_keeps_membership_and_does_not_backfill_old_notices() {
    let db = org();
    add(&db, "member");
    db.query("DROP TABLE account_notifications", &[]).unwrap();
    db.query("DROP TABLE org_member_notices", &[]).unwrap();
    db.query("DELETE FROM workspace_migrations WHERE version=14", &[])
        .unwrap();
    let before = db
        .query("SELECT * FROM org_members ORDER BY account", &[])
        .unwrap();
    assert!(pending(&db).is_empty());
    assert!(pending(&db).is_empty());
    assert_eq!(
        db.query("SELECT * FROM org_members ORDER BY account", &[])
            .unwrap(),
        before
    );
    assert_eq!(
        db.query(
            "SELECT COUNT(*) AS n FROM workspace_migrations WHERE version=14",
            &[]
        )
        .unwrap()[0]["n"],
        1
    );
}
#[test]
fn failed_delivery_backlog_does_not_starve_new_notices() {
    let db = org();
    for n in 0..25 {
        call(
            &db,
            json!({"op":"org_member_put","actor":"alice","account":format!("person{n}"),"role":"member"}),
        );
    }
    assert_eq!(pending(&db).len(), 20);
    let next = at(&db, 2000, json!({"op":"member_notices_pending"})).unwrap();
    assert!(
        next["notices"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["recipient"] == "person24")
    );
}
