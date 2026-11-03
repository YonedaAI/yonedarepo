use super::*;
use crate::native::NativeStore;
fn call(db: &NativeStore, mut command: Value) -> Value {
    command["now"] = json!(5000);
    if matches!(
        command["op"].as_str(),
        Some("notification_dismiss" | "notifications_clear")
    ) && command["session_hash"].is_null()
    {
        command["session_hash"] = json!("a".repeat(64));
    }
    execute_workspace(db, command).unwrap()
}
fn person() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    call(
        &db,
        json!({"op":"signup","username":"bob","password":"long test password","salt":"01".repeat(16),"recovery_hash":"b".repeat(64),"session_hash":"a".repeat(64),"email":"bob@example.com"}),
    );
    call(&db, json!({"op":"notification_identity"}));
    db
}
fn put(db: &NativeStore, id: i64) -> Value {
    call(
        db,
        json!({"op":"notification_put","org":"acme","id":id,"role":"member","at":id*100,"incarnation":1}),
    )
}
fn list(db: &NativeStore) -> Value {
    call(db, json!({"op":"notifications_list"}))
}
#[test]
fn dismissing_one_is_idempotent_and_never_changes_another_person_or_org_hint() {
    let db = person();
    let other = person();
    for user in [&db, &other] {
        put(user, 1);
        put(user, 2);
    }
    let response = call(&db, json!({"op":"notification_dismiss","id":"acme:1"}));
    assert_eq!(response["unread"], 1);
    assert_eq!(response["items"][0]["id"], "acme:2");
    assert_eq!(
        call(&db, json!({"op":"notification_dismiss","id":"acme:1"})),
        response
    );
    assert_eq!(
        call(&db, json!({"op":"notification_dismiss","id":"unknown:999"})),
        response
    );
    assert_eq!(list(&other)["unread"], 2);
    assert_eq!(super::orgs::hints(&db).unwrap(), vec!["acme"]);
    put(&db, 1);
    assert_eq!(list(&db), response);
}
#[test]
fn clear_all_dismisses_retained_rows_but_later_arrivals_remain_visible() {
    let db = person();
    put(&db, 1);
    put(&db, 2);
    let clear = call(&db, json!({"op":"notifications_clear"}));
    assert_eq!(clear["unread"], 0);
    assert_eq!(clear["items"], json!([]));
    put(&db, 1);
    put(&db, 2);
    assert_eq!(list(&db), clear);
    // This event was created before Clear all, but arrives afterward and was never retained.
    put(&db, 3);
    assert_eq!(list(&db)["unread"], 1);
    assert_eq!(list(&db)["items"][0]["id"], "acme:3");
    assert_eq!(super::orgs::hints(&db).unwrap(), vec!["acme"]);
}
#[test]
fn evicted_dismissal_tombstones_have_a_durable_prune_floor_against_late_replay() {
    let db = person();
    put(&db, 1);
    call(&db, json!({"op":"notification_dismiss","id":"acme:1"}));
    for id in 2..=101 {
        put(&db, id);
    }
    assert_eq!(
        db.query("SELECT COUNT(*) AS n FROM account_notifications", &[])
            .unwrap()[0]["n"],
        100
    );
    let replay = put(&db, 1);
    assert_eq!(replay["recorded"], true);
    assert_eq!(replay["contact"]["email"], "bob@example.com");
    assert_eq!(
        db.query(
            "SELECT COUNT(*) AS n FROM account_notifications WHERE id='acme:1'",
            &[]
        )
        .unwrap()[0]["n"],
        0
    );
    call(&db, json!({"op":"notifications_clear"}));
    put(&db, 1);
    assert_eq!(list(&db)["unread"], 0);
    put(&db, 102);
    assert_eq!(list(&db)["unread"], 1);
    assert_eq!(
        db.query("SELECT COUNT(*) AS n FROM account_notifications", &[])
            .unwrap()[0]["n"],
        100
    );
}
#[test]
fn migration_fifteen_upgrade_preserves_old_notices_and_repeats_once() {
    let db = person();
    put(&db, 1);
    call(&db, json!({"op":"notifications_read","through":100}));
    put(&db, 2);
    db.query(
        "ALTER TABLE account_notifications DROP COLUMN dismissed_at",
        &[],
    )
    .unwrap();
    db.query("DELETE FROM workspace_migrations WHERE version=16", &[])
        .unwrap();
    let before = list(&db);
    assert_eq!(before["items"].as_array().unwrap().len(), 2);
    assert_eq!(before["unread"], 1);
    assert_eq!(list(&db), before);
    assert_eq!(
        db.query(
            "SELECT COUNT(*) AS n FROM workspace_migrations WHERE version=16",
            &[]
        )
        .unwrap()[0]["n"],
        1
    );
}

#[test]
fn dismissals_require_a_current_session_inside_the_account_transaction() {
    let db = person();
    put(&db, 1);
    for op in ["notification_dismiss", "notifications_clear"] {
        let absent = execute_workspace(&db, json!({"op":op,"id":"acme:1","now":5000}));
        assert_eq!(absent.unwrap_err().code, "UNAUTHORIZED");
        let unknown = execute_workspace(
            &db,
            json!({"op":op,"id":"acme:1","session_hash":"b".repeat(64),"now":5000}),
        );
        assert_eq!(unknown.unwrap_err().code, "UNAUTHORIZED");
    }
    call(&db, json!({"op":"logout","session_hash":"a".repeat(64)}));
    let revoked = execute_workspace(
        &db,
        json!({"op":"notifications_clear","session_hash":"a".repeat(64),"now":5000}),
    );
    assert_eq!(revoked.unwrap_err().code, "UNAUTHORIZED");
    assert_eq!(list(&db)["unread"], 1);
}
