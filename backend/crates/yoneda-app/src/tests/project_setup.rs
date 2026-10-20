use crate::{SqlStore, execute_workspace, native::NativeStore};
use serde_json::{Value, json};

fn call(db: &NativeStore, mut command: Value, now: i64) -> yoneda_agents_core::Result<Value> {
    command["now"] = json!(now);
    execute_workspace(db, command)
}
fn project() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    call(&db, json!({"op":"signup","username":"alice","password":"a long test password","salt":"01".repeat(16),"recovery_hash":"b".repeat(64),"session_hash":"a".repeat(64)}), 1000).unwrap();
    call(&db, json!({"op":"project_reserve","id":"repo-one","name":"One","policy":yoneda_agents_core::Policy::default()}), 1000).unwrap();
    db
}
#[test]
fn leases_fence_overlapping_setup_and_expired_attempts() {
    let db = project();
    let first = call(&db, json!({"op":"project_claim","id":"repo-one"}), 1000).unwrap();
    assert_eq!(first["claimed"], true);
    assert_eq!(
        call(&db, json!({"op":"project_claim","id":"repo-one"}), 2000).unwrap()["claimed"],
        false
    );
    let next = call(&db, json!({"op":"project_claim","id":"repo-one"}), 122_000).unwrap();
    assert_eq!(next["setup_epoch"], 2);
    assert_eq!(call(&db, json!({"op":"project_update","id":"repo-one","epoch":first["setup_epoch"],"status":"failed"}), 123_000).unwrap_err().code, "FENCED");
    call(
        &db,
        json!({"op":"project_update","id":"repo-one","epoch":next["setup_epoch"],"status":"ready"}),
        123_000,
    )
    .unwrap();
    assert_eq!(
        call(
            &db,
            json!({"op":"project_update","id":"repo-one","epoch":1,"status":"failed"}),
            124_000
        )
        .unwrap()["status"],
        "ready"
    );
}
#[test]
fn persistent_pending_setup_stops_at_a_deadline_and_retry_preserves_identity() {
    let db = project();
    call(&db, json!({"op":"project_claim","id":"repo-one"}), 1000).unwrap();
    let failed = call(&db, json!({"op":"project_claim","id":"repo-one"}), 601_000).unwrap();
    assert_eq!(failed["status"], "failed");
    assert_eq!(failed["error_code"], "SETUP_TIMEOUT");
    assert_eq!(
        call(&db, json!({"op":"project_claim","id":"repo-one"}), 602_000).unwrap()["claimed"],
        false
    );
    let retry = call(&db, json!({"op":"project_retry","id":"repo-one"}), 603_000).unwrap();
    assert_eq!(retry["id"], "repo-one");
    assert_eq!(retry["name"], "One");
    assert_eq!(retry["status"], "provisioning");
    assert!(retry["error"].is_null());
    assert_eq!(
        call(&db, json!({"op":"project_claim","id":"repo-one"}), 603_000).unwrap()["setup_epoch"],
        2
    );
}
#[test]
fn old_project_records_are_scheduled_once_and_deletion_fences_setup() {
    let db = project();
    db.query("UPDATE workspace_records SET payload=json_remove(payload,'$.stage') WHERE id='project:repo-one'", &[]).unwrap();
    assert_eq!(
        call(&db, json!({"op":"project_schedule","id":"repo-one"}), 2000).unwrap()["schedule"],
        true
    );
    assert_eq!(
        call(&db, json!({"op":"project_schedule","id":"repo-one"}), 2000).unwrap()["schedule"],
        false
    );
    call(&db, json!({"op":"project_delete","id":"repo-one"}), 3000).unwrap();
    for op in [
        "project_claim",
        "project_retry",
        "project_progress",
        "project_update",
    ] {
        assert_eq!(
            call(
                &db,
                json!({"op":op,"id":"repo-one","epoch":1,"status":"ready","stage":"initializing"}),
                4000
            )
            .unwrap_err()
            .code,
            "REPOSITORY_DELETED"
        );
    }
}

#[test]
fn unacknowledged_dispatch_recovers_and_a_lost_worker_lease_is_redispatched() {
    let db = project();
    let intent = call(&db, json!({"op":"project_dispatches"}), 1000).unwrap();
    assert_eq!(intent["projects"][0], json!({"id":"repo-one","epoch":0}));
    // Failed send leaves the same intent available; only acknowledged sends defer it.
    assert_eq!(
        call(&db, json!({"op":"project_dispatches"}), 2000).unwrap()["projects"],
        intent["projects"]
    );
    call(
        &db,
        json!({"op":"project_dispatch_sent","id":"repo-one","epoch":0}),
        2000,
    )
    .unwrap();
    assert!(
        call(&db, json!({"op":"project_dispatches"}), 3000).unwrap()["projects"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let claim = call(&db, json!({"op":"project_claim","id":"repo-one"}), 32_000).unwrap();
    assert!(
        call(&db, json!({"op":"project_dispatches"}), 33_000).unwrap()["projects"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        call(&db, json!({"op":"project_dispatches"}), 153_000).unwrap()["projects"][0]["epoch"],
        claim["setup_epoch"]
    );
    let expired = call(&db, json!({"op":"project_dispatches"}), 601_000).unwrap();
    assert_eq!(expired["active"], false);
    assert_eq!(
        call(&db, json!({"op":"project_get","id":"repo-one"}), 601_000).unwrap()["error_code"],
        "SETUP_TIMEOUT"
    );
}

#[test]
fn explicit_pending_setup_retries_two_five_then_fifteen_seconds_on_native_clock() {
    let db = project();
    let mut now = 1000;
    for (code, delay) in [
        ("FORK_IN_PROGRESS", 2),
        ("IMPORT_IN_PROGRESS", 5),
        ("CREATE_IN_PROGRESS", 15),
        ("FORK_IN_PROGRESS", 15),
    ] {
        let claimed = call(&db, json!({"op":"project_claim","id":"repo-one"}), now).unwrap();
        assert_eq!(claimed["claimed"], true);
        let pending = call(&db,json!({"op":"project_update","id":"repo-one","epoch":claimed["setup_epoch"],"status":"provisioning","pending_code":code,"retry_delay_seconds":0,"setup_pending_count":99}),now+100).unwrap();
        assert_eq!(pending["retry_delay_seconds"], delay);
        let due = now + 100 + delay * 1000;
        assert_eq!(pending["setup_retry_at"], due);
        assert_eq!(pending["next_dispatch_at"], due);
        assert_eq!(pending["setup_started_at"], 1000);
        assert_eq!(
            call(&db, json!({"op":"project_claim","id":"repo-one"}), due - 1).unwrap()["claimed"],
            false
        );
        // Lost/duplicate pending completion cannot increment the backoff again.
        assert_eq!(call(&db,json!({"op":"project_update","id":"repo-one","epoch":claimed["setup_epoch"],"status":"provisioning","pending_code":code}),due-1).unwrap_err().code,"FENCED");
        assert_eq!(
            call(&db, json!({"op":"project_get","id":"repo-one"}), due - 1).unwrap(),
            pending
        );
        assert_eq!(
            call(&db, json!({"op":"project_dispatches"}), due).unwrap()["projects"][0]["id"],
            "repo-one"
        );
        // Alarm's acknowledged-send throttle must not block the job it just sent.
        call(
            &db,
            json!({"op":"project_dispatch_sent","id":"repo-one","epoch":claimed["setup_epoch"]}),
            due,
        )
        .unwrap();
        now = due;
    }
}

#[test]
fn short_pending_retry_cannot_bypass_active_lease_failure_or_deletion() {
    let db = project();
    let claim = call(&db, json!({"op":"project_claim","id":"repo-one"}), 1000).unwrap();
    assert_eq!(
        call(
            &db,
            json!({"op":"project_claim","id":"repo-one","retry_delay_seconds":2}),
            2000
        )
        .unwrap()["claimed"],
        false
    );
    let pending = call(&db,json!({"op":"project_update","id":"repo-one","epoch":claim["setup_epoch"],"status":"provisioning","pending_code":"FORK_IN_PROGRESS"}),2100).unwrap();
    assert_eq!(pending["retry_delay_seconds"], 2);
    let claim = call(&db, json!({"op":"project_claim","id":"repo-one"}), 4100).unwrap();
    assert!(claim["retry_delay_seconds"].is_null());
    let failed = call(&db,json!({"op":"project_update","id":"repo-one","epoch":claim["setup_epoch"],"status":"failed","error_code":"UPSTREAM_UNAVAILABLE"}),4200).unwrap();
    assert!(failed["retry_delay_seconds"].is_null());
    assert_eq!(
        call(&db, json!({"op":"project_claim","id":"repo-one"}), 4300).unwrap()["claimed"],
        false
    );
    call(&db, json!({"op":"project_retry","id":"repo-one"}), 4400).unwrap();
    let claim = call(&db, json!({"op":"project_claim","id":"repo-one"}), 4400).unwrap();
    let pending = call(&db,json!({"op":"project_update","id":"repo-one","epoch":claim["setup_epoch"],"status":"provisioning","pending_code":"IMPORT_IN_PROGRESS"}),4500).unwrap();
    assert_eq!(pending["retry_delay_seconds"], 2);
    call(&db, json!({"op":"project_delete","id":"repo-one"}), 4600).unwrap();
    assert_eq!(
        call(&db, json!({"op":"project_claim","id":"repo-one"}), 6500)
            .unwrap_err()
            .code,
        "REPOSITORY_DELETED"
    );
}
#[test]
fn first_platform_binding_wins_and_project_reads_never_carry_the_token() {
    let db = project();
    let sealed = json!({"v":2,"iv":"aXY=","ciphertext":"c2VjcmV0"});
    let bind = |repo: &str| json!({"op":"project_platform_bind","id":"repo-one","platform_repo":repo,"sealed":sealed});
    assert_eq!(
        call(&db, bind("not-a-repo"), 1100).unwrap_err().code,
        "INVALID_INPUT"
    );
    let first = format!("r{}", "a".repeat(20));
    assert_eq!(
        call(&db, bind(&first), 1100).unwrap()["platform"]["repo"],
        first
    );
    // A concurrent setup's second repository never replaces the first binding.
    let second = format!("r{}", "b".repeat(20));
    assert_eq!(
        call(&db, bind(&second), 1200).unwrap()["platform"]["repo"],
        first
    );
    let credential = call(
        &db,
        json!({"op":"project_platform_credential","id":"repo-one"}),
        1300,
    )
    .unwrap();
    assert_eq!(credential["repo"], first);
    assert_eq!(credential["sealed"], sealed);
    let project = call(&db, json!({"op":"project_get","id":"repo-one"}), 1300).unwrap();
    assert_eq!(project["platform"], json!({"repo":first}));
    assert!(!project.to_string().contains("c2VjcmV0"));
    let listed = call(&db, json!({"op":"projects"}), 1300).unwrap();
    assert_eq!(listed["projects"].as_array().unwrap().len(), 1);
    call(&db, json!({"op":"project_delete","id":"repo-one"}), 1400).unwrap();
    assert_eq!(
        call(
            &db,
            json!({"op":"project_platform_credential","id":"repo-one"}),
            1500
        )
        .unwrap_err()
        .code,
        "REPOSITORY_DELETED"
    );
}
