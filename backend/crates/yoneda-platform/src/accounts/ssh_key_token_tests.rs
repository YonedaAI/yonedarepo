//! The link from an SSH key to the personal token that added it: revoking the token removes
//! the key in the same transaction, and nothing else moves or loses the link.
use super::execute_workspace;
use crate::{native::NativeStore, storage::SqlStore};
use serde_json::{Value, json};

const ED25519: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPABZXfg3RaL8nBzQXBqjmhNRoourGMePyLCIP1iMDqH test@ed25519";
const ED25519_FP: &str = "SHA256:8EqRGtHv7KPU4JP7ITUpjcB1ZW5aJP4ISN49NDYsKWo";
const ECDSA: &str = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBLsUCMLZxezVKY0se9x00MY5l5i9wk6Lee8mWXzj/N2IgwcI4tpUDnRZmGMGmAB1IFLCf0vnBiGU/mZRGxn10KA= test@ecdsa";
const KEY_A: &str = "ssh_0123456789abcdef";
const KEY_B: &str = "ssh_fedcba9876543210";
const KEY_C: &str = "ssh_00000000000000cc";
const TOKEN_A: &str = "pat_0123456789abcdef";
const TOKEN_B: &str = "pat_fedcba9876543210";
const DAY: i64 = 24 * 60 * 60 * 1000;

fn at(db: &NativeStore, now: i64, mut command: Value) -> yoneda_core::Result<Value> {
    command["now"] = json!(now);
    execute_workspace(db, command)
}
fn code(result: yoneda_core::Result<Value>) -> String {
    result.unwrap_err().code
}
/// An account with two live tokens, valid for a day from 1000.
fn account() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    at(&db, 1000, json!({"op":"signup","username":"alice","password":"a long test password","salt":"01".repeat(16),"recovery_hash":"b".repeat(64),"session_hash":"a".repeat(64)})).unwrap();
    for (id, hash) in [(TOKEN_A, 'c'), (TOKEN_B, 'd')] {
        at(&db, 1000, json!({"op":"pat_create","id":id,"name":"laptop","token_hash":hash.to_string().repeat(64),"scopes":["repo:admin"],"expires_days":1,"repos":null})).unwrap();
    }
    db
}
fn add(db: &NativeStore, id: &str, key: &str, token: Option<&str>) -> yoneda_core::Result<Value> {
    at(
        db,
        2000,
        json!({"op":"ssh_key_add","id":id,"title":"laptop","public_key":key,"token_id":token}),
    )
}
fn revoke(db: &NativeStore, id: &str) -> yoneda_core::Result<Value> {
    at(db, 3000, json!({"op":"pat_revoke","id":id}))
}
fn check(db: &NativeStore, id: &str) -> yoneda_core::Result<Value> {
    at(db, 3001, json!({"op":"ssh_key_check","key_id":id}))
}
fn live_keys(db: &NativeStore) -> Vec<String> {
    at(db, 3002, json!({"op":"ssh_key_list"})).unwrap()["keys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| k["id"].as_str().unwrap().to_owned())
        .collect()
}
fn listed_count(db: &NativeStore, token: &str) -> Value {
    let listed = at(db, 3002, json!({"op":"pat_list"})).unwrap();
    let tokens = listed["tokens"].as_array().unwrap();
    let found = tokens.iter().find(|t| t["id"] == token).unwrap();
    found["ssh_keys"].clone()
}
fn events(db: &NativeStore, kind: &str) -> Vec<Value> {
    db.query(
        "SELECT data FROM workspace_events WHERE kind=? ORDER BY seq",
        &[json!(kind)],
    )
    .unwrap()
    .iter()
    .map(|r| serde_json::from_str(r["data"].as_str().unwrap()).unwrap())
    .collect()
}
fn token_is_live(db: &NativeStore, hash: char) -> bool {
    let command = json!({"op":"pat_check","token_hash":hash.to_string().repeat(64)});
    at(db, 3001, command).is_ok()
}

#[test]
fn revoking_a_token_removes_the_keys_it_added_and_says_which() {
    let db = account();
    add(&db, KEY_A, ED25519, Some(TOKEN_A)).unwrap();
    assert_eq!(listed_count(&db, TOKEN_A), 1);
    assert_eq!(listed_count(&db, TOKEN_B), 0);

    let revoked = revoke(&db, TOKEN_A).unwrap();
    assert_eq!(
        revoked,
        json!({"id":TOKEN_A,"revoked":true,"removed_ssh_keys":[
            {"id":KEY_A,"title":"laptop","fingerprint":ED25519_FP}
        ]})
    );
    assert_eq!(code(check(&db, KEY_A)), "UNAUTHORIZED");
    assert!(live_keys(&db).is_empty());
    assert_eq!(
        events(&db, "ssh_key.removed"),
        vec![json!({"id":KEY_A,"reason":"token_revoked","token":TOKEN_A})]
    );
}

#[test]
fn keys_with_no_token_and_other_tokens_keys_stay() {
    let db = account();
    add(&db, KEY_A, ED25519, None).unwrap();
    add(&db, KEY_B, ECDSA, Some(TOKEN_B)).unwrap();
    assert_eq!(listed_count(&db, TOKEN_A), 0);

    let revoked = revoke(&db, TOKEN_A).unwrap();
    assert_eq!(revoked["removed_ssh_keys"], json!([]));
    assert_eq!(live_keys(&db), [KEY_A, KEY_B]);
    assert!(check(&db, KEY_A).is_ok());
    assert!(check(&db, KEY_B).is_ok());
}

#[test]
fn a_key_from_before_the_link_has_no_record_and_stays() {
    let db = account();
    // As an authority from before this change stored it: the row alone.
    db.query(
        "INSERT INTO account_ssh_keys(id,title,fingerprint,algorithm,public_key,created_at) VALUES(?,'old',?,'ssh-ed25519',?,1)",
        &[json!(KEY_A), json!(ED25519_FP), json!(ED25519)],
    )
    .unwrap();
    assert_eq!(revoke(&db, TOKEN_A).unwrap()["removed_ssh_keys"], json!([]));
    assert!(check(&db, KEY_A).is_ok());
}

#[test]
fn a_revocation_and_its_key_removal_commit_together_or_not_at_all() {
    // Each trigger fails one half, after the other half has run or before it.
    for trigger in [
        "CREATE TRIGGER refuse BEFORE UPDATE OF removed_at ON account_ssh_keys BEGIN SELECT RAISE(ABORT,'refused'); END",
        "CREATE TRIGGER refuse BEFORE INSERT ON workspace_events WHEN NEW.kind='ssh_key.removed' BEGIN SELECT RAISE(ABORT,'refused'); END",
        "CREATE TRIGGER refuse BEFORE INSERT ON workspace_events WHEN NEW.kind='pat.revoked' BEGIN SELECT RAISE(ABORT,'refused'); END",
    ] {
        let db = account();
        add(&db, KEY_A, ED25519, Some(TOKEN_A)).unwrap();
        db.query(trigger, &[]).unwrap();
        assert!(revoke(&db, TOKEN_A).is_err(), "{trigger}");
        assert!(token_is_live(&db, 'c'), "the token survives: {trigger}");
        assert!(check(&db, KEY_A).is_ok(), "the key survives: {trigger}");
        assert_eq!(
            listed_count(&db, TOKEN_A),
            1,
            "the link survives: {trigger}"
        );
        assert!(events(&db, "ssh_key.removed").is_empty(), "{trigger}");

        db.query("DROP TRIGGER refuse", &[]).unwrap();
        let revoked = revoke(&db, TOKEN_A).unwrap();
        assert_eq!(revoked["removed_ssh_keys"][0]["id"], KEY_A, "{trigger}");
        assert!(!token_is_live(&db, 'c'), "{trigger}");
        assert_eq!(code(check(&db, KEY_A)), "UNAUTHORIZED", "{trigger}");
    }
}

#[test]
fn a_repeat_revocation_finds_nothing_and_removes_nothing() {
    let db = account();
    add(&db, KEY_A, ED25519, Some(TOKEN_A)).unwrap();
    revoke(&db, TOKEN_A).unwrap();
    // Added again by the person: a new key with no token behind it.
    add(&db, KEY_B, ED25519, None).unwrap();
    assert_eq!(code(revoke(&db, TOKEN_A)), "NOT_FOUND");
    assert_eq!(live_keys(&db), [KEY_B]);
    assert_eq!(events(&db, "ssh_key.removed").len(), 1);
}

#[test]
fn a_token_that_cannot_act_cannot_add_a_key() {
    let db = account();
    revoke(&db, TOKEN_A).unwrap();
    // The Worker checked the token before this revocation committed: the add must not leave a
    // key behind it.
    assert_eq!(
        code(add(&db, KEY_A, ED25519, Some(TOKEN_A))),
        "UNAUTHORIZED"
    );
    assert_eq!(
        code(add(&db, KEY_A, ED25519, Some("pat_00000000000000aa"))),
        "UNAUTHORIZED"
    );
    assert_eq!(
        code(at(
            &db,
            2000 + 2 * DAY,
            json!({"op":"ssh_key_add","id":KEY_A,"title":"laptop","public_key":ED25519,"token_id":TOKEN_B})
        )),
        "UNAUTHORIZED",
        "expired"
    );
    assert_eq!(
        code(add(&db, KEY_A, ED25519, Some("ssh_0123456789abcdef"))),
        "INVALID_INPUT"
    );
    assert!(live_keys(&db).is_empty());
}

#[test]
fn adding_a_live_key_again_never_moves_its_record() {
    let db = account();
    add(&db, KEY_A, ED25519, Some(TOKEN_A)).unwrap();
    for token in [Some(TOKEN_B), None] {
        assert_eq!(code(add(&db, KEY_B, ED25519, token)), "ALREADY_EXISTS");
    }
    assert_eq!(listed_count(&db, TOKEN_A), 1);
    assert_eq!(listed_count(&db, TOKEN_B), 0);
    assert_eq!(revoke(&db, TOKEN_B).unwrap()["removed_ssh_keys"], json!([]));
    assert!(check(&db, KEY_A).is_ok());
    assert_eq!(
        revoke(&db, TOKEN_A).unwrap()["removed_ssh_keys"][0]["id"],
        KEY_A
    );
}

#[test]
fn a_key_removed_by_hand_leaves_nothing_to_revoke() {
    let db = account();
    add(&db, KEY_A, ED25519, Some(TOKEN_A)).unwrap();
    at(&db, 2500, json!({"op":"ssh_key_remove","id":KEY_A})).unwrap();
    assert_eq!(listed_count(&db, TOKEN_A), 0);
    // Added again by the person: this key is theirs, not the token's.
    add(&db, KEY_B, ED25519, None).unwrap();
    assert_eq!(revoke(&db, TOKEN_A).unwrap()["removed_ssh_keys"], json!([]));
    assert_eq!(live_keys(&db), [KEY_B]);
    assert_eq!(link_records(&db), 0);
}

#[test]
fn an_expired_tokens_key_stays_until_the_token_is_revoked() {
    let db = account();
    add(&db, KEY_A, ED25519, Some(TOKEN_A)).unwrap();
    let later = 1000 + 2 * DAY;
    let expired = at(
        &db,
        later,
        json!({"op":"pat_check","token_hash":"c".repeat(64)}),
    );
    assert_eq!(code(expired), "UNAUTHORIZED");
    at(&db, later, json!({"op":"ssh_key_check","key_id":KEY_A})).unwrap();
    // Still listed, so it can still be revoked, and its key with it.
    let revoked = at(&db, later, json!({"op":"pat_revoke","id":TOKEN_A})).unwrap();
    assert_eq!(revoked["removed_ssh_keys"][0]["id"], KEY_A);
    assert_eq!(code(check(&db, KEY_A)), "UNAUTHORIZED");
}

fn link_records(db: &NativeStore) -> i64 {
    db.query(
        "SELECT COUNT(*) AS n FROM workspace_records WHERE id LIKE 'ssh_key_token:%'",
        &[],
    )
    .unwrap()[0]["n"]
        .as_i64()
        .unwrap()
}

#[test]
fn recovery_removes_every_key_and_leaves_no_link() {
    let db = account();
    add(&db, KEY_A, ED25519, Some(TOKEN_A)).unwrap();
    add(&db, KEY_B, ECDSA, None).unwrap();
    assert_eq!(link_records(&db), 1);
    at(&db, 5000, json!({"op":"recover","recovery_hash":"b".repeat(64),"password":"new long test password","salt":"02".repeat(16),"new_recovery_hash":"d".repeat(64)})).unwrap();
    assert_eq!(code(check(&db, KEY_A)), "UNAUTHORIZED");
    assert_eq!(code(check(&db, KEY_B)), "UNAUTHORIZED");
    assert_eq!(link_records(&db), 0);
    // The same key comes back under a new id, with no token.
    add(&db, KEY_C, ED25519, None).unwrap();
    assert!(check(&db, KEY_C).is_ok());
}
