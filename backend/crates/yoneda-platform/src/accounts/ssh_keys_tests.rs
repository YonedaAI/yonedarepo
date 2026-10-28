//! SSH keys held by the account authority and the per-fingerprint claim index.
use super::execute_workspace;
use super::ssh_keys::parse_public_key;
use crate::native::NativeStore;
use serde_json::{Value, json};

const ED25519: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPABZXfg3RaL8nBzQXBqjmhNRoourGMePyLCIP1iMDqH test@ed25519";
const ECDSA: &str = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBLsUCMLZxezVKY0se9x00MY5l5i9wk6Lee8mWXzj/N2IgwcI4tpUDnRZmGMGmAB1IFLCf0vnBiGU/mZRGxn10KA= test@ecdsa";
const RSA_2048: &str = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDAuGDSee/mFhh398iBiTOQTUTd97iYPv0M5tva2II+o5ozgmyHAo1l8AOOfoDJ2APjYOjf28VslO0k16oTD4RF4XY8rZ5O0mMNag8SFoy99QdDLfdi9cCzwSnbNDFyO3Xp4JOzYJw8TDFepyEyrvvYqjBhc0i+d5NP4PIeOC2sPOO68Df45Veu4Kwhr6p/5tTIX2WV51Tt+m8KgSkrBVPtg/V+vaq1KtE4j7Q29LMXiW1zdOwP+WEQpzpQd8SZeRKVYMPK2OYaRDfvzfzUnJc6N3AJ0y8mHs3/ImJgaHdX6VvY1j6nTv/xOy7orcN7OKAc9FWC74VyejR0zfG3gVzR test@rsa";
const RSA_1024: &str = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQDlChsmZ70OHgqTSc1JXuQRPAFWFRJ8yHT7R/XHZrYPFson45ZLYUPIxyX1NSE6fcTBr8HSFKfWxym/FD99UOos5dGnM9QeFXBfVWcwGKDD2ccolZaTzpO1x+KVhPiZVDBZwoMi5IwKl5RU/hz+zRQNhwAeGWb7nssREyfmhYk4YQ==";
const ED25519_FP: &str = "SHA256:8EqRGtHv7KPU4JP7ITUpjcB1ZW5aJP4ISN49NDYsKWo";
const ID: &str = "ssh_0123456789abcdef";

fn at(db: &NativeStore, now: i64, mut command: Value) -> yoneda_core::Result<Value> {
    command["now"] = json!(now);
    execute_workspace(db, command)
}
fn account() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    at(&db, 1000, json!({"op":"signup","username":"alice","password":"a long test password","salt":"01".repeat(16),"recovery_hash":"b".repeat(64),"session_hash":"a".repeat(64)})).unwrap();
    db
}
fn add(db: &NativeStore, id: &str, key: &str) -> yoneda_core::Result<Value> {
    at(
        db,
        2000,
        json!({"op":"ssh_key_add","id":id,"title":"laptop","public_key":key}),
    )
}
fn code(result: yoneda_core::Result<Value>) -> String {
    result.unwrap_err().code
}

#[test]
fn fingerprints_match_ssh_keygen_and_weak_or_malformed_keys_are_refused() {
    // `ssh-keygen -lf` of each key.
    for (line, fp, algorithm) in [
        (ED25519, ED25519_FP, "ssh-ed25519"),
        (
            ECDSA,
            "SHA256:ZDqPuklpc5kPGUsaQ/6J56K/L5rvCHF/bqPISkpZcSk",
            "ecdsa-sha2-nistp256",
        ),
        (
            RSA_2048,
            "SHA256:yd73tx4jydj9LV8HGj2G95tPUWIxQXoaAcD37vNu23E",
            "ssh-rsa",
        ),
    ] {
        let key = parse_public_key(line).unwrap();
        assert_eq!(
            (key.fingerprint.as_str(), key.algorithm.as_str()),
            (fp, algorithm)
        );
        assert!(!key.line.contains("test@"), "the comment is not stored");
    }
    assert!(parse_public_key(RSA_1024).is_err(), "RSA under 2048 bits");
    // The line's type must be the blob's own type.
    let lying = ED25519.replacen("ssh-ed25519", "ssh-rsa", 1);
    assert!(parse_public_key(&lying).is_err());
    // Trailing bytes after the key structure, truncation, and garbage.
    let blob = ED25519.split(' ').nth(1).unwrap();
    let padded = format!("ssh-ed25519 {}AAAA", &blob[..blob.len() - 1]);
    assert!(parse_public_key(&padded).is_err());
    assert!(parse_public_key("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5").is_err());
    assert!(parse_public_key("-----BEGIN OPENSSH PRIVATE KEY-----").is_err());
    assert!(parse_public_key("ssh-dss AAAAB3NzaC1kc3M=").is_err());
}

#[test]
fn keys_are_added_listed_checked_and_removed_at_once() {
    let db = account();
    let added = add(&db, ID, ED25519).unwrap();
    assert_eq!(added["fingerprint"], ED25519_FP);
    assert_eq!(added["last_used_at"], Value::Null);
    assert_eq!(
        code(add(&db, "ssh_0123456789abcde0", ED25519)),
        "ALREADY_EXISTS"
    );
    assert_eq!(code(add(&db, "ssh_xyz", ECDSA)), "INVALID_INPUT");
    let listed = at(&db, 2100, json!({"op":"ssh_key_list"})).unwrap();
    assert_eq!(listed["keys"].as_array().unwrap().len(), 1);
    assert!(
        !listed.to_string().contains("AAAAC3"),
        "listing omits the key"
    );

    let checked = at(
        &db,
        3000,
        json!({"op":"ssh_key_check","key_id":ID,"fingerprint":ED25519_FP}),
    )
    .unwrap();
    assert_eq!(checked["username"], "alice");
    let listed = at(&db, 3100, json!({"op":"ssh_key_list"})).unwrap();
    assert_eq!(listed["keys"][0]["last_used_at"], 3000);
    // A check naming another key's fingerprint is refused.
    let other = "SHA256:ZDqPuklpc5kPGUsaQ/6J56K/L5rvCHF/bqPISkpZcSk";
    assert_eq!(
        code(at(
            &db,
            3200,
            json!({"op":"ssh_key_check","key_id":ID,"fingerprint":other})
        )),
        "UNAUTHORIZED"
    );

    let removed = at(&db, 4000, json!({"op":"ssh_key_remove","id":ID})).unwrap();
    assert_eq!(removed["fingerprint"], ED25519_FP);
    assert_eq!(
        code(at(&db, 4001, json!({"op":"ssh_key_check","key_id":ID}))),
        "UNAUTHORIZED"
    );
    assert_eq!(
        code(at(&db, 4002, json!({"op":"ssh_key_remove","id":ID}))),
        "NOT_FOUND"
    );
    // The same key may be added again once removed.
    add(&db, "ssh_0123456789abcde1", ED25519).unwrap();
}

#[test]
fn recovery_removes_every_key() {
    let db = account();
    add(&db, ID, ED25519).unwrap();
    at(&db, 5000, json!({"op":"recover","recovery_hash":"b".repeat(64),"password":"new long test password","salt":"02".repeat(16),"new_recovery_hash":"d".repeat(64)})).unwrap();
    assert_eq!(
        code(at(&db, 5001, json!({"op":"ssh_key_check","key_id":ID}))),
        "UNAUTHORIZED"
    );
}

#[test]
fn a_fingerprint_is_claimed_by_one_key_until_released_or_replaced() {
    // The index instance holds no account.
    let index = NativeStore::memory().unwrap();
    let claim = |account: &str, key: &str, replace: bool| {
        at(
            &index,
            1000,
            json!({"op":"ssh_fp_claim","fingerprint":ED25519_FP,"account":account,"key_id":key,"replace":replace}),
        )
        .unwrap()
    };
    let get = || {
        at(
            &index,
            1000,
            json!({"op":"ssh_fp_get","fingerprint":ED25519_FP}),
        )
    };
    assert_eq!(code(get()), "NOT_FOUND");
    assert_eq!(claim("alice", ID, false)["claimed"], true);
    assert_eq!(claim("alice", ID, false)["claimed"], true, "idempotent");
    let refused = claim("bob", "ssh_fedcba9876543210", false);
    assert_eq!(
        (refused["claimed"].clone(), refused["holder"].clone()),
        (json!(false), json!({"account":"alice","key_id":ID}))
    );
    // Another account's release of a claim it does not hold changes nothing.
    at(
        &index,
        1000,
        json!({"op":"ssh_fp_release","fingerprint":ED25519_FP,"account":"bob","key_id":ID}),
    )
    .unwrap();
    assert_eq!(get().unwrap()["account"], "alice");
    assert_eq!(claim("bob", "ssh_fedcba9876543210", true)["claimed"], true);
    assert_eq!(get().unwrap()["account"], "bob");
    at(&index, 1000, json!({"op":"ssh_fp_release","fingerprint":ED25519_FP,"account":"bob","key_id":"ssh_fedcba9876543210"})).unwrap();
    assert_eq!(code(get()), "NOT_FOUND");
    assert_eq!(
        code(at(
            &index,
            1000,
            json!({"op":"ssh_fp_get","fingerprint":"SHA256:../x"})
        )),
        "INVALID_INPUT"
    );
}
