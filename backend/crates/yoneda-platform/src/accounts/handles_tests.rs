//! Handles and repository names on the account authority: one namespace for usernames,
//! org names and the handles email-named accounts pick, decided by each name's own
//! instance; reserved names refused to new names; repository names unique per owner
//! ignoring case, renames keeping earlier names; and the migration that adds them.
use super::execute_workspace;
use crate::{native::NativeStore, storage::SqlStore};
use serde_json::{Value, json};

fn at(db: &NativeStore, now: i64, mut command: Value) -> yoneda_core::Result<Value> {
    command["now"] = json!(now);
    execute_workspace(db, command)
}
fn ok(db: &NativeStore, command: Value) -> Value {
    at(db, 1000, command.clone()).unwrap_or_else(|e| panic!("{command}: {e}"))
}
fn code(db: &NativeStore, command: Value) -> String {
    at(db, 1000, command).unwrap_err().code
}
fn signup(name: &str) -> Value {
    json!({"op":"signup","username":name,"password":"a long test password","salt":"01".repeat(16),"recovery_hash":"b".repeat(64),"session_hash":"a".repeat(64)})
}
fn person(name: &str) -> NativeStore {
    let db = NativeStore::memory().unwrap();
    ok(&db, signup(name));
    db
}
const REPO: &str = "r0123456789abcdef0123";
const OTHER: &str = "r0123456789abcdef0124";

#[test]
fn a_username_or_org_is_its_own_handle_and_an_email_account_picks_one() {
    let ada = person("ada");
    assert_eq!(ok(&ada, json!({"op":"handle_get"}))["handle"], "ada");
    assert_eq!(
        ok(&ada, json!({"op":"handle_lookup"})),
        json!({"kind":"user","account":"ada","handle":"ada"})
    );
    assert_eq!(
        code(&ada, json!({"op":"handle_set","handle":"lovelace"})),
        "HANDLE_FIXED"
    );
    let org = NativeStore::memory().unwrap();
    ok(&org, json!({"op":"org_create","org":"acme","actor":"ada"}));
    assert_eq!(ok(&org, json!({"op":"handle_lookup"}))["kind"], "org");

    // An email-named account (made before sign-up named accounts by handle) has none yet,
    // and is never reached by its address.
    let legacy = person("grace@example.com");
    assert_eq!(
        ok(&legacy, json!({"op":"handle_get"}))["handle"],
        Value::Null
    );
    assert_eq!(code(&legacy, json!({"op":"handle_lookup"})), "NOT_FOUND");
    // The handle's own instance holds it for the account, once.
    let instance = NativeStore::memory().unwrap();
    let reserve = json!({"op":"handle_reserve","handle":"Grace","account":"grace@example.com"});
    assert_eq!(ok(&instance, reserve.clone())["handle"], "grace");
    ok(&instance, reserve);
    assert_eq!(
        code(
            &instance,
            json!({"op":"handle_reserve","handle":"grace","account":"eve@example.com"})
        ),
        "HANDLE_TAKEN"
    );
    assert_eq!(
        ok(&instance, json!({"op":"handle_lookup"})),
        json!({"kind":"alias","account":"grace@example.com","handle":"grace"})
    );
    // Nobody signs up as it or makes an org of it.
    assert_eq!(code(&instance, signup("grace")), "ALREADY_EXISTS");
    assert_eq!(
        code(
            &instance,
            json!({"op":"org_create","org":"grace","actor":"ada"})
        ),
        "ALREADY_EXISTS"
    );
    // A taken name cannot become a handle.
    assert_eq!(
        code(
            &ada,
            json!({"op":"handle_reserve","handle":"ada","account":"grace@example.com"})
        ),
        "HANDLE_TAKEN"
    );
    let set = ok(&legacy, json!({"op":"handle_set","handle":"grace"}));
    assert_eq!(set, json!({"handle":"grace","previous":null}));
    assert_eq!(ok(&legacy, json!({"op":"handle_get"}))["handle"], "grace");
    let changed = ok(&legacy, json!({"op":"handle_set","handle":"hopper"}));
    assert_eq!(changed["previous"], "grace");
    // Released by its account only.
    ok(
        &instance,
        json!({"op":"handle_release","account":"eve@example.com"}),
    );
    assert_eq!(
        ok(&instance, json!({"op":"handle_lookup"}))["kind"],
        "alias"
    );
    ok(
        &instance,
        json!({"op":"handle_release","account":"grace@example.com"}),
    );
    assert_eq!(code(&instance, json!({"op":"handle_lookup"})), "NOT_FOUND");
}

#[test]
fn reserved_names_are_refused_to_every_new_name() {
    for name in ["docs", "api", "source", "settings", "admin", "yonedarepo"] {
        let db = NativeStore::memory().unwrap();
        assert_eq!(code(&db, signup(name)), "HANDLE_RESERVED", "{name}");
        assert_eq!(
            code(&db, json!({"op":"org_create","org":name,"actor":"ada"})),
            "HANDLE_RESERVED",
            "{name}"
        );
        assert_eq!(
            code(
                &db,
                json!({"op":"handle_reserve","handle":name,"account":"grace@example.com"})
            ),
            "HANDLE_RESERVED",
            "{name}"
        );
    }
    for invalid in ["grace@example.com", "gr", "9lives"] {
        let db = NativeStore::memory().unwrap();
        assert_eq!(
            code(
                &db,
                json!({"op":"handle_reserve","handle":invalid,"account":"grace@example.com"})
            ),
            "HANDLE_INVALID",
            "{invalid}"
        );
    }
    // An email-named account is not a handle: its address is never reserved.
    let db = NativeStore::memory().unwrap();
    ok(&db, signup("docs@example.com"));
}

#[test]
fn repository_names_are_unique_per_owner_ignoring_case_and_renames_keep_the_old_name() {
    let db = person("ada");
    let claim = |repo: &str, name: &str| json!({"op":"owned_repo_claim","repo":repo,"name":name});
    assert_eq!(
        ok(&db, claim(REPO, "Testing")),
        json!({"name":"Testing","renamed_from":null})
    );
    assert_eq!(code(&db, claim(OTHER, "testing")), "NAME_TAKEN");
    // Claiming its own name again is a no-op.
    ok(&db, claim(REPO, "Testing"));
    let resolve = |name: &str| json!({"op":"owned_repo_resolve","name":name});
    assert_eq!(
        ok(&db, resolve("TESTING")),
        json!({"repo":REPO,"name":"Testing","renamed_from":null})
    );
    assert_eq!(code(&db, resolve("other")), "NOT_FOUND");
    // A rename: the earlier name resolves to the new one.
    assert_eq!(ok(&db, claim(REPO, "renamed"))["renamed_from"], "Testing");
    assert_eq!(
        ok(&db, resolve("testing")),
        json!({"repo":REPO,"name":"renamed","renamed_from":"Testing"})
    );
    // Another repository may take the earlier name; it then names that one.
    ok(&db, claim(OTHER, "testing"));
    assert_eq!(ok(&db, resolve("testing"))["repo"], OTHER);
    assert_eq!(ok(&db, resolve("renamed"))["repo"], REPO);
    // A deleted repository frees its names.
    ok(&db, json!({"op":"owned_repo_release","repo":REPO}));
    assert_eq!(code(&db, resolve("renamed")), "NOT_FOUND");
    for bad in [
        claim("r1", "x"),
        claim(REPO, ".hidden"),
        claim(REPO, "has space"),
    ] {
        assert_eq!(code(&db, bad), "INVALID_INPUT");
    }
    // Only an owner holds names.
    let nobody = NativeStore::memory().unwrap();
    assert_eq!(code(&nobody, claim(REPO, "x")), "NOT_FOUND");
}

#[test]
fn the_handles_migration_applies_fresh_repeatedly_and_over_version_seven() {
    let old = NativeStore::memory().unwrap();
    old.query(
        "CREATE TABLE workspace_migrations(version INTEGER PRIMARY KEY,digest TEXT NOT NULL)",
        &[],
    )
    .unwrap();
    for (version, sql) in [
        (1, include_str!("migrations/0001_accounts.sql")),
        (2, include_str!("migrations/0002_account_tokens.sql")),
        (3, include_str!("migrations/0003_orgs.sql")),
        (4, include_str!("migrations/0004_team_ids.sql")),
        (5, include_str!("migrations/0005_ssh_keys.sql")),
        (6, include_str!("migrations/0006_token_origin.sql")),
        (7, include_str!("migrations/0007_identities.sql")),
    ] {
        for statement in sql.split(';').filter(|s| !s.trim().is_empty()) {
            old.query(statement, &[]).unwrap();
        }
        old.query(
            "INSERT INTO workspace_migrations(version,digest) VALUES(?,?)",
            &[json!(version), json!(yoneda_core::digest(sql.as_bytes()))],
        )
        .unwrap();
    }
    old.query(
        "INSERT INTO workspace_records(id,payload) VALUES('account',?)",
        &[json!(
            json!({"username":"grace@example.com","created_at":1}).to_string()
        )],
    )
    .unwrap();
    // The account made before the migration keeps working and gains a handle.
    for db in [&old, &person("ada")] {
        at(db, 2000, json!({"op":"handle_get"})).unwrap();
        at(db, 2000, json!({"op":"handle_get"})).unwrap();
        let versions = db
            .query("SELECT MAX(version) AS v FROM workspace_migrations", &[])
            .unwrap();
        assert_eq!(versions[0]["v"], 8);
    }
    ok(&old, json!({"op":"handle_set","handle":"grace"}));
    ok(
        &old,
        json!({"op":"owned_repo_claim","repo":REPO,"name":"kept"}),
    );
}
