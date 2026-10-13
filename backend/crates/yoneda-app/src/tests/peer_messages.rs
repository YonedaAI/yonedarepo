use super::*;
fn team() -> NativeStore {
    let db = repo_with_policy(
        json!({"version":"v1","suite":"commands-v1","environment":"linux-node24-rust1.94-v1","required_checks":["build"],"build":{"checks":[{"name":"build","argv":["node","--check","app.js"],"timeout_seconds":30}]}}),
    );
    call(&db,json!({"op":"start_run","id":"team","intent":"Build booking with a stable API","mode":"collaborate","agents":[{"provider":"mimo","model":"flash","strategy":"planner"},{"provider":"mimo","model":"flash","strategy":"API"}]})).unwrap();
    call(&db, json!({"op":"claim","job_id":"job:team:planner"})).unwrap();
    db
}
fn send(db: &NativeStore, request: &str, recipient: &str, body: &str) -> Result<Value> {
    call(
        db,
        json!({"op":"peer_message","job_id":"job:team:planner","epoch":1,"request_id":request,"recipient":recipient,"kind":"contract","body":body}),
    )
}
#[test]
fn delivery_is_ordered_replay_safe_and_acknowledgement_is_platform_bound() {
    let db = team();
    let first = send(&db, "one", "team", "API returns cents").unwrap();
    assert_eq!(
        send(&db, "one", "team", "API returns cents").unwrap(),
        first
    );
    assert_eq!(
        send(&db, "one", "team", "API returns dollars")
            .unwrap_err()
            .code,
        "IDEMPOTENCY_CONFLICT"
    );
    let second = send(&db, "two", "team", "Client preserves currency units").unwrap();
    let inbox = call(
        &db,
        json!({"op":"peer_inbox","job_id":"job:team:planner","epoch":1,"limit":1}),
    )
    .unwrap();
    assert_eq!(inbox["items"][0]["seq"], first["seq"]);
    assert_eq!(inbox["has_more"], true);
    assert_eq!(call(&db,json!({"op":"peer_inbox","job_id":"job:team:planner","epoch":1,"after":first["seq"],"ack_ids":[99999]})).unwrap_err().code,"FORBIDDEN");
    let page=call(&db,json!({"op":"peer_inbox","job_id":"job:team:planner","epoch":1,"after":first["seq"],"ack_ids":[first["seq"]]})).unwrap();
    assert_eq!(page["items"][0]["seq"], second["seq"]);
    assert_eq!(page["delivery_authority"], "platform_delivery");
    let delivered = db
        .query(
            "SELECT acknowledged_at FROM peer_deliveries WHERE message_seq=?",
            &[first["seq"].clone()],
        )
        .unwrap();
    assert_eq!(delivered[0]["acknowledged_at"], 1000);
    let owner_page = call(
        &db,
        json!({"op":"peer_messages_page","run_id":"team","limit":1}),
    )
    .unwrap();
    assert_eq!(
        owner_page["items"][0]["delivery_receipts"]["acknowledged"],
        1
    );
    send(&db, "three", "team", "A new later contract").unwrap();
    let next=call(&db,json!({"op":"peer_messages_page","run_id":"team","limit":1,"after":owner_page["next_cursor"],"watermark":owner_page["watermark"]})).unwrap();
    assert_eq!(next["items"][0]["seq"], second["seq"]);
    assert_eq!(next["has_more"], false);
    assert!(call(&db, json!({"op":"peer_messages_page","run_id":"foreign"})).is_err());
}
#[test]
fn recipients_are_team_scoped_and_cancelled_attempts_cannot_send() {
    let db = team();
    assert_eq!(
        send(&db, "outside", "foreign:agent", "Steal context")
            .unwrap_err()
            .code,
        "FORBIDDEN"
    );
    call(&db, json!({"op":"cancel_run","run_id":"team"})).unwrap();
    assert_eq!(
        send(&db, "late", "team", "Stale contract")
            .unwrap_err()
            .code,
        "FENCED"
    );
    assert!(
        db.query("SELECT seq FROM peer_messages", &[])
            .unwrap()
            .is_empty()
    );
}
