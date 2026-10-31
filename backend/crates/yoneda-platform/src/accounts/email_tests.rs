//! Contact-email verification: single-use 24-hour tokens stored as digests, verifying,
//! changing the address, and the resend limit.
use super::execute_workspace;
use crate::native::NativeStore;
use serde_json::{Value, json};

const DAY: i64 = 24 * 60 * 60 * 1000;

fn at(db: &NativeStore, now: i64, mut command: Value) -> yoneda_core::Result<Value> {
    command["now"] = json!(now);
    execute_workspace(db, command)
}
fn hash(c: char) -> String {
    c.to_string().repeat(64)
}
fn account(email: Option<&str>) -> NativeStore {
    let db = NativeStore::memory().unwrap();
    let mut signup = json!({"op":"signup","username":"alice","password":"a long test password","salt":"01".repeat(16),"recovery_hash":"b".repeat(64),"session_hash":"a".repeat(64)});
    if let Some(email) = email {
        signup["email"] = json!(email);
    }
    at(&db, 0, signup).unwrap();
    db
}
fn status(db: &NativeStore, now: i64, token: Option<char>) -> Value {
    let mut c = json!({"op":"email_status"});
    if let Some(t) = token {
        c["token_hash"] = json!(hash(t));
    }
    at(db, now, c).unwrap()
}
fn issue(db: &NativeStore, now: i64, token: char, purpose: &str) -> Value {
    at(
        db,
        now,
        json!({"op":"email_token","token_hash":hash(token),"purpose":purpose}),
    )
    .unwrap()
}
fn verify(db: &NativeStore, now: i64, token: char) -> Value {
    at(
        db,
        now,
        json!({"op":"email_verify","token_hash":hash(token)}),
    )
    .unwrap()
}

#[test]
fn a_token_verifies_once_within_a_day_and_marks_the_account() {
    let db = account(Some("alice@example.com"));
    assert_eq!(
        status(&db, 1, None),
        json!({"email":"alice@example.com","verified":false})
    );
    assert_eq!(issue(&db, 1, 'c', "welcome"), json!({"issued":true}));
    assert_eq!(status(&db, 2, Some('c'))["token_valid"], true);
    // Only the digest is stored.
    assert!(super::get(&db, &format!("email_token:{}", hash('c'))).is_ok());
    assert_eq!(verify(&db, 5, 'd'), json!({"verified":false}));
    assert_eq!(verify(&db, 5, 'c'), json!({"verified":true}));
    assert_eq!(super::get(&db, "account").unwrap()["email_verified_at"], 5);
    assert_eq!(status(&db, 6, Some('c'))["verified"], true);
    // Single use: the token is gone, and so is every other one.
    assert_eq!(status(&db, 6, Some('c'))["token_valid"], false);
    assert_eq!(verify(&db, 7, 'c'), json!({"verified":false}));
    // A verified address needs no new token.
    assert_eq!(
        issue(&db, 8, 'e', "resend"),
        json!({"issued":false,"reason":"verified"})
    );
}

#[test]
fn a_token_expires_after_24_hours() {
    let db = account(Some("alice@example.com"));
    issue(&db, 0, 'c', "welcome");
    assert_eq!(status(&db, DAY - 1, Some('c'))["token_valid"], true);
    assert_eq!(status(&db, DAY, Some('c'))["token_valid"], false);
    assert_eq!(verify(&db, DAY, 'c'), json!({"verified":false}));
    assert!(super::get(&db, "account").unwrap()["email_verified_at"].is_null());
}

#[test]
fn no_token_without_an_address_or_an_account() {
    let db = account(None);
    assert_eq!(
        issue(&db, 1, 'c', "welcome"),
        json!({"issued":false,"reason":"no_email"})
    );
    let empty = NativeStore::memory().unwrap();
    assert_eq!(
        at(
            &empty,
            1,
            json!({"op":"email_token","token_hash":hash('c'),"purpose":"welcome"})
        )
        .unwrap_err()
        .code,
        "NOT_FOUND"
    );
    assert_eq!(
        at(
            &db,
            1,
            json!({"op":"email_token","token_hash":hash('c'),"purpose":"other"})
        )
        .unwrap_err()
        .code,
        "INVALID_INPUT"
    );
}

#[test]
fn changing_the_address_clears_verification_and_old_tokens() {
    let db = account(Some("alice@example.com"));
    issue(&db, 1, 'c', "welcome");
    verify(&db, 2, 'c');
    issue(&db, 3, 'd', "welcome"); // refused: verified
    let change = |now: i64, email: &str, token: char| {
        at(
            &db,
            now,
            json!({"op":"email_change","email":email,"token_hash":hash(token)}),
        )
    };
    assert_eq!(
        change(4, "Alice@Example.com", 'e').unwrap(),
        json!({"changed":false,"reason":"same"})
    );
    assert_eq!(
        change(5, "not-an-address", 'e').unwrap_err().code,
        "INVALID_INPUT"
    );
    assert_eq!(
        change(6, "Alice@New.example", 'e').unwrap(),
        json!({"changed":true})
    );
    assert_eq!(
        status(&db, 7, Some('e')),
        json!({"email":"alice@new.example","verified":false,"token_valid":true})
    );
    // A token issued for the old address before the change never verifies the new one.
    issue(&db, 8, 'f', "resend");
    change(9, "third@example.com", '1').unwrap();
    assert_eq!(verify(&db, 10, 'f'), json!({"verified":false}));
    assert_eq!(verify(&db, 10, 'e'), json!({"verified":false}));
    assert_eq!(verify(&db, 10, '1'), json!({"verified":true}));
    assert_eq!(status(&db, 11, None)["email"], "third@example.com");
}

#[test]
fn resends_and_changes_share_a_limit_of_five_a_day_and_welcomes_are_free() {
    let db = account(Some("alice@example.com"));
    for (i, t) in ['c', 'd', 'e', 'f'].into_iter().enumerate() {
        assert_eq!(issue(&db, i as i64, t, "resend")["issued"], true);
    }
    assert_eq!(
        at(
            &db,
            5,
            json!({"op":"email_change","email":"b@example.com","token_hash":hash('1')})
        )
        .unwrap(),
        json!({"changed":true})
    );
    assert_eq!(
        issue(&db, 6, '2', "resend"),
        json!({"issued":false,"reason":"limited"})
    );
    assert_eq!(
        at(
            &db,
            7,
            json!({"op":"email_change","email":"c@example.com","token_hash":hash('3')})
        )
        .unwrap(),
        json!({"changed":false,"reason":"limited"})
    );
    assert_eq!(status(&db, 8, None)["email"], "b@example.com");
    assert_eq!(issue(&db, 9, '4', "welcome")["issued"], true);
    // A day after the first, the window resets.
    assert_eq!(issue(&db, DAY, '5', "resend")["issued"], true);
}

#[test]
fn a_provider_verified_address_starts_verified() {
    let db = NativeStore::memory().unwrap();
    at(&db, 3, json!({"op":"identity_signup","username":"octocat","session_hash":"a".repeat(64),"provider":"github","subject":"42","login":"octocat","email":"octo@example.com"})).unwrap();
    assert_eq!(
        status(&db, 4, None),
        json!({"email":"octo@example.com","verified":true})
    );
    assert_eq!(
        issue(&db, 4, 'c', "welcome"),
        json!({"issued":false,"reason":"verified"})
    );
    let none = NativeStore::memory().unwrap();
    at(&none, 3, json!({"op":"identity_signup","username":"octocat","session_hash":"a".repeat(64),"provider":"github","subject":"42","login":"octocat"})).unwrap();
    assert_eq!(
        status(&none, 4, None),
        json!({"email":null,"verified":false})
    );
}

#[test]
fn support_requests_are_limited_per_day_and_a_release_gives_the_slot_back() {
    let db = account(Some("alice@example.com"));
    let admit = |now| at(&db, now, json!({"op":"support_admit"})).unwrap();
    for n in 0..5 {
        assert_eq!(admit(n), json!({"admitted":true}), "request {n}");
    }
    assert_eq!(admit(6), json!({"admitted":false}));
    // A request that was not delivered does not count, and only one slot comes back.
    at(&db, 7, json!({"op":"support_release"})).unwrap();
    assert_eq!(admit(8), json!({"admitted":true}));
    assert_eq!(admit(9), json!({"admitted":false}));
    // Confirmation resends have their own limit.
    assert_eq!(issue(&db, 10, 'c', "resend"), json!({"issued":true}));
    assert_eq!(admit(DAY), json!({"admitted":true}));
}

#[test]
fn a_release_with_nothing_counted_gives_no_extra_requests() {
    let db = account(Some("alice@example.com"));
    at(&db, 0, json!({"op":"support_release"})).unwrap();
    for n in 0..5 {
        let admitted = at(&db, n, json!({"op":"support_admit"})).unwrap();
        assert_eq!(admitted, json!({"admitted":true}));
    }
    let refused = at(&db, 6, json!({"op":"support_admit"})).unwrap();
    assert_eq!(refused, json!({"admitted":false}));
}
