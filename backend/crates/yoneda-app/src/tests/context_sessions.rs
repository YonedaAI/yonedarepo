use super::*;
fn session(id: &str, grant: &str) -> Value {
    json!({"op":"context_session_begin","session_id":id,"_grant":grant,"expires_at":86_400_000,"protocol_version":"2025-06-18"})
}
fn begin(id: &str, session: &str) -> Value {
    json!({"op":"external_begin","id":id,"_grant":"grant-one","session_id":session,
        "fork":"test/external-fork","intent":"Local contribution","context":[],"criteria":[]})
}
fn read(session: Option<&str>, call: &str) -> Value {
    let mut c = json!({"op":"record_context_access","_grant":"grant-one","call_id":call,
        "tool":"context_get","stage":"opened","targets":[{"id":"repo-test"}],"run_id":"spoofed"});
    if let Some(session) = session {
        c["session_id"] = json!(session);
    }
    c
}
#[test]
fn session_binding_is_server_scoped_and_never_reassigns_pre_attempt_or_stateless_reads() {
    let db = repo();
    call(&db, session("session-one", "grant-one")).unwrap();
    call(&db, read(Some("session-one"), "before-bind")).unwrap();
    call(&db, read(None, "stateless")).unwrap();
    let job = call(&db, begin("local-one", "session-one")).unwrap();
    call(&db, read(Some("session-one"), "after-bind")).unwrap();
    let page = call(
        &db,
        json!({"op":"context_usage","_grant":"grant-one","session_id":"session-one"}),
    )
    .unwrap();
    assert_eq!(page["run_id"], job["payload"]["execution"]["run_id"]);
    assert_eq!(page["counts"]["read_calls"], 1);
    assert_eq!(page["entries"][0]["execution_id"], "local-one");
    assert_eq!(page["entries"][0]["session_id"], "session-one");
    let unattributed = call(&db, json!({"op":"context_usage","_grant":"grant-one"})).unwrap();
    assert_eq!(unattributed["counts"]["read_calls"], 2);
    assert!(
        unattributed["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["run_id"].is_null())
    );
    assert_eq!(
        call(
            &db,
            json!({"op":"context_session_get","session_id":"session-one","_grant":"other"})
        )
        .unwrap_err()
        .code,
        "SESSION_NOT_FOUND"
    );
    let before = call(&db, json!({"op":"snapshot"})).unwrap();
    assert_eq!(
        call(&db, begin("local-two", "session-one"))
            .unwrap_err()
            .code,
        "SESSION_BOUND"
    );
    assert_eq!(call(&db, json!({"op":"snapshot"})).unwrap(), before);
    call(&db, json!({"op":"cancel_run","run_id":"run:local-one"})).unwrap();
    call(&db, begin("local-two", "session-one")).unwrap();
    call(&db, read(Some("session-one"), "new-binding")).unwrap();
    assert_eq!(
        call(&db, json!({"op":"context_usage","run_id":"run:local-one"})).unwrap()["counts"]["read_calls"],
        1
    );
    assert_eq!(
        call(&db, json!({"op":"context_usage","run_id":"run:local-two"})).unwrap()["counts"]["read_calls"],
        1
    );
    call(
        &db,
        json!({"op":"context_session_end","session_id":"session-one","_grant":"grant-one"}),
    )
    .unwrap();
    assert_eq!(
        call(&db, read(Some("session-one"), "ended"))
            .unwrap_err()
            .code,
        "SESSION_NOT_FOUND"
    );
}
#[test]
fn sessions_preserve_negotiated_protocol_and_enforce_lifetime_and_grant_isolation() {
    let db = repo();
    let begin = session("session-one", "grant-one");
    let original = call(&db, begin.clone()).unwrap();
    assert_eq!(original["protocol_version"], "2025-06-18");
    assert_eq!(call(&db, begin).unwrap(), original);
    let mut excessive = session("too-long", "grant-one");
    excessive["expires_at"] = json!(86_401_001);
    assert_eq!(call(&db, excessive).unwrap_err().code, "INVALID_INPUT");
    assert_eq!(call(&db, json!({"op":"context_session_get","session_id":"session-one","_grant":"grant-one","now":86_400_000})).unwrap_err().code, "SESSION_NOT_FOUND");
    let mut wrong = session("session-one", "other");
    wrong["expires_at"] = json!(2000);
    assert_eq!(call(&db, wrong).unwrap_err().code, "SESSION_NOT_FOUND");
}
