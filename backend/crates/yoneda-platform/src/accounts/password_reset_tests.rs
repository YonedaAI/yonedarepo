//! Forgot password by email and the recovery code's regeneration: who gets a link, a link's
//! one use within its hour, what a reset ends and keeps, and the request limit.
use super::execute_workspace;
use crate::native::NativeStore;
use crate::storage::SqlStore;
use serde_json::{Value, json};

const HOUR: i64 = 60 * 60 * 1000;
const DAY: i64 = 24 * HOUR;
const OLD_PASSWORD: &str = "a long test password";
const NEW_PASSWORD: &str = "a brand new password";

fn at(db: &NativeStore, now: i64, mut command: Value) -> yoneda_core::Result<Value> {
    command["now"] = json!(now);
    execute_workspace(db, command)
}
fn hash(c: char) -> String {
    c.to_string().repeat(64)
}
fn account(email: Option<&str>) -> NativeStore {
    let db = NativeStore::memory().unwrap();
    let mut signup = json!({"op":"signup","username":"alice","password":OLD_PASSWORD,"salt":"01".repeat(16),"recovery_hash":hash('b'),"session_hash":hash('a')});
    if let Some(email) = email {
        signup["email"] = json!(email);
    }
    at(&db, 0, signup).unwrap();
    db
}
/// An account whose address is confirmed.
fn confirmed() -> NativeStore {
    let db = account(Some("alice@example.com"));
    at(
        &db,
        0,
        json!({"op":"email_token","token_hash":hash('e'),"purpose":"welcome"}),
    )
    .unwrap();
    at(&db, 0, json!({"op":"email_verify","token_hash":hash('e')})).unwrap();
    db
}
fn request(db: &NativeStore, now: i64, token: char) -> Value {
    at(
        db,
        now,
        json!({"op":"password_reset_request","token_hash":hash(token)}),
    )
    .unwrap()
}
fn reset(db: &NativeStore, now: i64, token: char, recovery: char) -> yoneda_core::Result<Value> {
    at(
        db,
        now,
        json!({"op":"password_reset","token_hash":hash(token),"password":NEW_PASSWORD,"salt":"02".repeat(16),"new_recovery_hash":hash(recovery)}),
    )
}
fn status(db: &NativeStore, now: i64, token: char) -> Value {
    at(
        db,
        now,
        json!({"op":"password_reset_status","token_hash":hash(token)}),
    )
    .unwrap()
}
fn login(db: &NativeStore, now: i64, password: &str, session: char) -> bool {
    at(
        db,
        now,
        json!({"op":"login","password":password,"session_hash":hash(session)}),
    )
    .unwrap()["authenticated"]
        == true
}
fn signed_in(db: &NativeStore, now: i64, session: char) -> bool {
    at(
        db,
        now,
        json!({"op":"session","session_hash":hash(session)}),
    )
    .unwrap()["authenticated"]
        == true
}
fn recover(db: &NativeStore, now: i64, code: char, next: char) -> bool {
    at(
        db,
        now,
        json!({"op":"recover","recovery_hash":hash(code),"password":"yet another long password","salt":"03".repeat(16),"new_recovery_hash":hash(next)}),
    )
    .unwrap()["authenticated"]
        == true
}
fn regenerate(db: &NativeStore, now: i64, session: char, code: char) -> Value {
    at(
        db,
        now,
        json!({"op":"recovery_regenerate","session_hash":hash(session),"recovery_hash":hash(code)}),
    )
    .unwrap()
}
fn events(db: &NativeStore, kind: &str) -> Vec<Value> {
    db.query(
        "SELECT data FROM workspace_events WHERE kind=?",
        &[json!(kind)],
    )
    .unwrap()
}

#[test]
fn only_a_confirmed_address_gets_a_link() {
    assert_eq!(request(&account(None), 1, 'c')["issued"], false);
    let unconfirmed = account(Some("alice@example.com"));
    assert_eq!(request(&unconfirmed, 1, 'c')["issued"], false);
    assert_eq!(status(&unconfirmed, 2, 'c'), json!({"email":null}));
    let nobody = NativeStore::memory().unwrap();
    assert_eq!(request(&nobody, 1, 'c')["issued"], false);

    let db = confirmed();
    assert_eq!(request(&db, 1, 'c')["issued"], true);
    assert_eq!(status(&db, 2, 'c'), json!({"email":"alice@example.com"}));
    // At rest only the digest exists, under a name of its own.
    assert!(super::get(&db, &format!("reset_token:{}", hash('c'))).is_ok());
    // A wrong token reads as nothing.
    assert_eq!(status(&db, 2, 'd'), json!({"email":null}));
}

#[test]
fn an_address_the_account_is_named_by_needs_confirming_too() {
    let db = NativeStore::memory().unwrap();
    at(&db, 0, json!({"op":"signup","username":"ada@example.com","password":OLD_PASSWORD,"salt":"01".repeat(16),"recovery_hash":hash('b'),"session_hash":hash('a')})).unwrap();
    assert_eq!(request(&db, 1, 'c')["issued"], false);
}

#[test]
fn a_reset_ends_sessions_replaces_both_secrets_and_leaves_an_audit_event() {
    let db = confirmed();
    assert!(login(&db, 1, OLD_PASSWORD, 'f'));
    request(&db, 2, 'c');
    let done = reset(&db, 3, 'c', 'd').unwrap();
    assert_eq!(done["authenticated"], true);
    assert_eq!(done["username"], "alice");
    // Both browser sessions are over.
    assert!(!signed_in(&db, 4, 'a'));
    assert!(!signed_in(&db, 4, 'f'));
    // The old password and the old recovery code are dead, the new ones work.
    assert!(!login(&db, 4, OLD_PASSWORD, '7'));
    assert!(login(&db, 4, NEW_PASSWORD, '7'));
    assert!(!recover(&db, 4, 'b', '8'));
    assert!(recover(&db, 4, 'd', '8'));
    let audit = events(&db, "account.password_reset");
    assert_eq!(audit.len(), 1);
    let data = audit[0]["data"].as_str().unwrap();
    assert!(!data.contains(&hash('c')) && !data.contains(&hash('d')));
}

const SSH_KEY: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJCFG1MqHVbmDrGBB3CKcDmbsEQFHjzlqaEVG/RtBvA8";
const OTHER_SSH_KEY: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMF8BBDJrJYSUSkzOVKqBwaNAv8Q7wXSzKwXd2kSjL2V";
const WEBSITE_TOKEN: &str = "pat_0123456789abcdef";
const CLI_TOKEN: &str = "pat_fedcba9876543210";

fn token(db: &NativeStore, id: &str, hashed: char, origin: Value) {
    at(db, 1, json!({"op":"pat_create","id":id,"name":"ci","token_hash":hash(hashed),"scopes":["repo:admin"],"expires_days":30,"repos":null,"origin":origin})).unwrap();
}
fn usable(db: &NativeStore, now: i64, hashed: char) -> bool {
    at(db, now, json!({"op":"pat_check","token_hash":hash(hashed)})).is_ok()
}
fn live_keys(db: &NativeStore) -> Vec<String> {
    at(db, 9, json!({"op":"ssh_key_list"})).unwrap()["keys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| k["id"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn a_reset_revokes_tokens_and_cli_sign_ins() {
    let db = confirmed();
    token(&db, WEBSITE_TOKEN, '9', Value::Null);
    token(&db, CLI_TOKEN, '6', json!("login"));
    assert!(usable(&db, 2, '9') && usable(&db, 2, '6'));
    request(&db, 2, 'c');
    reset(&db, 3, 'c', 'd').unwrap();
    assert!(!usable(&db, 4, '9'));
    assert!(!usable(&db, 4, '6'));
    let audit = events(&db, "account.password_reset");
    let data: Value = serde_json::from_str(audit[0]["data"].as_str().unwrap()).unwrap();
    assert_eq!(data["tokens"], 2);
}

#[test]
fn a_reset_removes_the_keys_a_token_added_like_any_revocation() {
    let db = confirmed();
    token(&db, WEBSITE_TOKEN, '9', Value::Null);
    let by_token = "ssh_0123456789abcdef";
    let by_person = "ssh_fedcba9876543210";
    at(&db, 1, json!({"op":"ssh_key_add","id":by_token,"title":"laptop","public_key":SSH_KEY,"token_id":WEBSITE_TOKEN})).unwrap();
    at(&db, 1, json!({"op":"ssh_key_add","id":by_person,"title":"desk","public_key":OTHER_SSH_KEY,"token_id":null})).unwrap();
    request(&db, 2, 'c');
    reset(&db, 3, 'c', 'd').unwrap();
    assert_eq!(live_keys(&db), vec![by_person.to_owned()]);
    let audit = events(&db, "account.password_reset");
    let data: Value = serde_json::from_str(audit[0]["data"].as_str().unwrap()).unwrap();
    assert_eq!(data["ssh_keys"], 1);
    assert_eq!(events(&db, "ssh_key.removed").len(), 1);
}

#[test]
fn a_link_expires_after_an_hour() {
    let db = confirmed();
    request(&db, 0, 'c');
    assert_eq!(
        status(&db, HOUR - 1, 'c')["email"],
        json!("alice@example.com")
    );
    assert_eq!(status(&db, HOUR, 'c'), json!({"email":null}));
    assert_eq!(
        reset(&db, HOUR, 'c', 'd').unwrap(),
        json!({"authenticated":false})
    );
    assert!(login(&db, HOUR, OLD_PASSWORD, '7'));
    assert!(signed_in(&db, HOUR, 'a'));
}

#[test]
fn a_link_works_once() {
    let db = confirmed();
    request(&db, 1, 'c');
    assert_eq!(reset(&db, 2, 'c', 'd').unwrap()["authenticated"], true);
    assert_eq!(
        reset(&db, 3, 'c', 'e').unwrap(),
        json!({"authenticated":false})
    );
    assert!(recover(&db, 4, 'd', 'f'));
}

#[test]
fn a_new_link_replaces_the_last_one() {
    let db = confirmed();
    request(&db, 1, 'c');
    request(&db, 2, 'd');
    assert_eq!(status(&db, 3, 'c'), json!({"email":null}));
    assert_eq!(
        reset(&db, 3, 'c', 'e').unwrap(),
        json!({"authenticated":false})
    );
    assert_eq!(reset(&db, 3, 'd', 'e').unwrap()["authenticated"], true);
}

#[test]
fn a_refused_password_leaves_the_link_usable() {
    let db = confirmed();
    request(&db, 1, 'c');
    let short = at(
        &db,
        2,
        json!({"op":"password_reset","token_hash":hash('c'),"password":"too short","salt":"02".repeat(16),"new_recovery_hash":hash('d')}),
    );
    assert_eq!(short.unwrap_err().code, "INVALID_INPUT");
    assert_eq!(reset(&db, 3, 'c', 'd').unwrap()["authenticated"], true);
}

#[test]
fn changing_the_address_or_recovering_cancels_a_link() {
    let db = confirmed();
    request(&db, 1, 'c');
    at(
        &db,
        2,
        json!({"op":"email_change","email":"new@example.com","token_hash":hash('f')}),
    )
    .unwrap();
    assert_eq!(status(&db, 3, 'c'), json!({"email":null}));
    // Going back to the first address does not bring the link back.
    at(
        &db,
        4,
        json!({"op":"email_change","email":"alice@example.com","token_hash":hash('e')}),
    )
    .unwrap();
    at(&db, 5, json!({"op":"email_verify","token_hash":hash('e')})).unwrap();
    assert_eq!(status(&db, 6, 'c'), json!({"email":null}));

    request(&db, 7, 'd');
    assert!(recover(&db, 8, 'b', '7'));
    assert_eq!(status(&db, 9, 'd'), json!({"email":null}));
}

#[test]
fn a_suspended_account_gets_no_link_and_no_reset() {
    let db = confirmed();
    request(&db, 1, 'c');
    at(&db, 2, json!({"op":"account_suspend"})).unwrap();
    assert_eq!(status(&db, 3, 'c'), json!({"email":null}));
    assert_eq!(
        reset(&db, 3, 'c', 'd').unwrap(),
        json!({"authenticated":false,"suspended":true})
    );
    assert_eq!(request(&db, 4, 'e')["issued"], false);
    at(&db, 5, json!({"op":"account_unsuspend"})).unwrap();
    assert!(login(&db, 6, OLD_PASSWORD, '7'));
}

#[test]
fn requests_are_limited_to_five_a_day_per_account() {
    let db = confirmed();
    for (i, token) in ('c'..='f').chain(['0']).enumerate() {
        assert_eq!(request(&db, i as i64 + 1, token)["issued"], true);
    }
    assert_eq!(request(&db, 10, '1')["issued"], false);
    // The refused request leaves the last link alone.
    assert_eq!(status(&db, 11, '0')["email"], json!("alice@example.com"));
    assert_eq!(request(&db, DAY + 1, '2')["issued"], true);
}

#[test]
fn reset_requests_do_not_use_up_confirmation_emails() {
    let db = account(Some("alice@example.com"));
    for token in ['c', 'd', 'e', 'f', '0', '1'] {
        request(&db, 1, token);
    }
    let resend = at(
        &db,
        2,
        json!({"op":"email_token","token_hash":hash('2'),"purpose":"resend"}),
    )
    .unwrap();
    assert_eq!(resend, json!({"issued":true}));
}

#[test]
fn a_provider_account_with_a_confirmed_address_can_set_a_password() {
    let db = NativeStore::memory().unwrap();
    at(&db, 0, json!({"op":"identity_signup","username":"alice","provider":"github","subject":"7","login":"alice","email":"alice@example.com","session_hash":hash('a')})).unwrap();
    assert_eq!(request(&db, 1, 'c')["issued"], true);
    assert_eq!(reset(&db, 2, 'c', 'd').unwrap()["authenticated"], true);
    assert!(login(&db, 3, NEW_PASSWORD, '7'));
    assert!(recover(&db, 4, 'd', 'f'));
}

#[test]
fn regenerating_needs_a_live_session_and_kills_the_old_code() {
    let db = account(Some("alice@example.com"));
    assert_eq!(regenerate(&db, 1, '6', 'd'), json!({"regenerated":false}));
    assert_eq!(regenerate(&db, 1, 'a', 'd'), json!({"regenerated":true}));
    assert_eq!(events(&db, "account.recovery_regenerated").len(), 1);
    assert!(!recover(&db, 2, 'b', 'e'));
    assert!(recover(&db, 3, 'd', 'e'));
    // A session past its seven days is no session.
    let db = account(None);
    assert_eq!(
        regenerate(&db, 7 * DAY, 'a', 'd'),
        json!({"regenerated":false})
    );
    assert!(recover(&db, 7 * DAY, 'b', 'e'));
}

#[test]
fn a_suspended_account_or_one_without_a_password_cannot_regenerate() {
    let db = account(None);
    at(&db, 1, json!({"op":"account_suspend"})).unwrap();
    assert_eq!(regenerate(&db, 2, 'a', 'd'), json!({"regenerated":false}));
    let db = NativeStore::memory().unwrap();
    at(&db, 0, json!({"op":"identity_signup","username":"alice","provider":"github","subject":"7","login":"alice","session_hash":hash('a')})).unwrap();
    assert_eq!(regenerate(&db, 1, 'a', 'd'), json!({"regenerated":false}));
}
