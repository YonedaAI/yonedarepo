use super::execute_workspace;
use crate::native::NativeStore;
use serde_json::{Value, json};

static IDS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn admit(db: &NativeStore, now: i64) -> Value {
    execute_workspace(db, json!({"op":"auth_rate_limit","now":now,"request":format!("{:032x}", IDS.fetch_add(1, std::sync::atomic::Ordering::Relaxed))})).unwrap()
}

#[test]
fn shared_allowance_survives_reload_and_denials_do_not_extend_the_window() {
    let db = NativeStore::memory().unwrap();
    for _ in 0..30 {
        assert_eq!(admit(&db, 1000)["success"], true);
    }
    assert_eq!(admit(&db.clone(), 1001)["success"], false);
    assert_eq!(admit(&db, 60_999)["success"], false);
    assert_eq!(admit(&db, 61_000)["success"], true);
}

#[test]
fn a_different_key_has_its_own_allowance_and_clock_reversal_never_refills() {
    let db = NativeStore::memory().unwrap();
    for _ in 0..30 {
        admit(&db, 1000);
    }
    assert_eq!(admit(&db, 999)["success"], false);
    let another = NativeStore::memory().unwrap();
    assert_eq!(admit(&another, 1001)["success"], true);
    assert!(execute_workspace(&db, json!({"op":"auth_rate_limit","now":-1})).is_err());
}

#[test]
fn acknowledged_loss_retry_does_not_spend_twice() {
    let db = NativeStore::memory().unwrap();
    let c = json!({"op":"auth_rate_limit","now":1000,"request":"a".repeat(32)});
    for _ in 0..35 {
        assert_eq!(execute_workspace(&db, c.clone()).unwrap()["success"], true);
    }
    for _ in 0..29 {
        assert_eq!(admit(&db, 1001)["success"], true);
    }
    assert_eq!(admit(&db, 1001)["success"], false);
}
