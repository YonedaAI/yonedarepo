//! The connected GitHub installation: one an account, replaced by connecting again, nothing but
//! ids and a login, and the migration.
use super::execute_workspace;
use crate::{native::NativeStore, storage::SqlStore};
use serde_json::{Value, json};

fn at(db: &NativeStore, now: i64, mut command: Value) -> yoneda_core::Result<Value> {
    command["now"] = json!(now);
    execute_workspace(db, command)
}
fn signed_up() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    at(
        &db,
        1,
        json!({"op":"signup","username":"ada_l","password":"a long test password","salt":"01".repeat(16),"recovery_hash":"b".repeat(64),"session_hash":"a".repeat(64)}),
    )
    .unwrap();
    db
}
fn put(id: i64, login: &str) -> Value {
    json!({"op":"github_installation_put","installation":id,"login":login})
}
fn held(db: &NativeStore) -> Value {
    at(db, 9, json!({"op":"github_installation_get"})).unwrap()
}

#[test]
fn an_account_with_none_answers_nothing() {
    assert_eq!(held(&signed_up()), json!({}));
}

#[test]
fn connecting_again_replaces_the_installation() {
    let db = signed_up();
    at(&db, 2, put(7, "ada")).unwrap();
    at(&db, 3, put(8, "ada")).unwrap();
    assert_eq!(
        held(&db),
        json!({"installation":8,"login":"ada","connected_at":3,"target_type":"User",
               "target_id":null,"connected_by":null})
    );
}

#[test]
fn refuses_what_is_no_installation() {
    let db = signed_up();
    for bad in [
        json!({"op":"github_installation_put","installation":0,"login":"ada"}),
        json!({"op":"github_installation_put","installation":"7","login":"ada"}),
        put(7, ""),
        put(7, &"a".repeat(40)),
    ] {
        assert_eq!(at(&db, 2, bad).unwrap_err().code, "INVALID_INPUT");
    }
    assert_eq!(held(&db), json!({}));
}

#[test]
fn an_account_that_does_not_exist_holds_none() {
    let db = NativeStore::memory().unwrap();
    assert!(at(&db, 2, put(7, "ada")).is_err());
}

#[test]
fn the_migration_is_fresh_repeatable_and_upgrades_a_version_ten_store() {
    let versions = |db: &NativeStore| {
        db.query("SELECT version FROM workspace_migrations", &[])
            .unwrap()
            .len()
    };
    let fresh = signed_up();
    assert_eq!(versions(&fresh), 13);
    held(&fresh);
    assert_eq!(versions(&fresh), 13);

    // Upgrade: a version-10 store keeps its account and starts with no installation.
    let db = NativeStore::memory().unwrap();
    db.query(
        "CREATE TABLE workspace_migrations(version INTEGER PRIMARY KEY,digest TEXT NOT NULL)",
        &[],
    )
    .unwrap();
    let previous = [
        include_str!("migrations/0001_accounts.sql"),
        include_str!("migrations/0002_account_tokens.sql"),
        include_str!("migrations/0003_orgs.sql"),
        include_str!("migrations/0004_team_ids.sql"),
        include_str!("migrations/0005_ssh_keys.sql"),
        include_str!("migrations/0006_token_origin.sql"),
        include_str!("migrations/0007_identities.sql"),
        include_str!("migrations/0008_handles_repo_names.sql"),
        include_str!("migrations/0009_avatars.sql"),
        include_str!("migrations/0010_favorites.sql"),
    ];
    for (version, sql) in previous.iter().enumerate() {
        for statement in sql.split(';').filter(|s| !s.trim().is_empty()) {
            db.query(statement, &[]).unwrap();
        }
        db.query(
            "INSERT INTO workspace_migrations(version,digest) VALUES(?,?)",
            &[
                json!(version as i64 + 1),
                json!(yoneda_core::digest(sql.as_bytes())),
            ],
        )
        .unwrap();
    }
    db.query(
        "INSERT INTO workspace_records(id,payload) VALUES('account',?)",
        &[json!(
            json!({"username":"ada_l","verifier":null,"created_at":1}).to_string()
        )],
    )
    .unwrap();
    assert_eq!(held(&db), json!({}));
    assert_eq!(versions(&db), 13);
    at(&db, 10, put(7, "ada")).unwrap();
    assert_eq!(held(&db)["installation"], 7);
}

fn person(id: i64) -> Value {
    json!({"op":"github_installation_put","installation":id,"login":"ada"})
}
fn org(id: i64, login: &str, target: i64) -> Value {
    json!({"op":"github_installation_put","installation":id,"login":login,
           "target_type":"Organization","target_id":target,"connected_by":"101"})
}
fn listed(db: &NativeStore) -> Vec<(i64, String)> {
    at(db, 20, json!({"op":"github_installation_list"})).unwrap()["installations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["installation"].as_i64().unwrap(),
                r["login"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}
fn ticket(id: i64) -> Value {
    json!({"op":"github_org_ticket_put","ticket_hash":"a".repeat(64),"installation":id,
           "login":"acme","target_id":500})
}
const TAKE: &str = "github_org_ticket_take";
const PEEK: &str = "github_org_ticket_get";
fn asked(op: &str) -> Value {
    json!({"op":op,"ticket_hash":"a".repeat(64)})
}

#[test]
fn an_account_holds_its_own_installation_and_several_organizations() {
    let db = signed_up();
    at(&db, 10, org(9, "acme", 500)).unwrap();
    at(&db, 11, person(7)).unwrap();
    at(&db, 12, org(8, "globex", 501)).unwrap();
    // Its own comes first, then the organizations by name.
    assert_eq!(
        listed(&db),
        [(7, "ada".into()), (9, "acme".into()), (8, "globex".into())]
    );
    let row = at(
        &db,
        20,
        json!({"op":"github_installation_get","installation":9}),
    )
    .unwrap();
    assert_eq!(row["target_type"], "Organization");
    assert_eq!(row["target_id"], 500);
    assert_eq!(row["connected_by"], "101");
}

#[test]
fn connecting_a_personal_account_again_replaces_only_that_one() {
    let db = signed_up();
    at(&db, 10, person(7)).unwrap();
    at(&db, 11, org(9, "acme", 500)).unwrap();
    at(&db, 12, person(70)).unwrap();
    assert_eq!(listed(&db), [(70, "ada".into()), (9, "acme".into())]);
}

#[test]
fn connecting_an_organization_again_keeps_one_row() {
    let db = signed_up();
    at(&db, 10, org(9, "acme", 500)).unwrap();
    at(&db, 11, org(9, "acme-renamed", 500)).unwrap();
    assert_eq!(listed(&db), [(9, "acme-renamed".into())]);
}

#[test]
fn an_organization_needs_its_id_and_who_connected_it() {
    let db = signed_up();
    for bad in [
        json!({"op":"github_installation_put","installation":9,"login":"acme",
               "target_type":"Organization"}),
        json!({"op":"github_installation_put","installation":9,"login":"acme",
               "target_type":"Organization","target_id":500}),
        json!({"op":"github_installation_put","installation":9,"login":"acme",
               "target_type":"Enterprise","target_id":500,"connected_by":"101"}),
    ] {
        assert_eq!(at(&db, 10, bad).unwrap_err().code, "INVALID_INPUT");
    }
    assert!(listed(&db).is_empty());
}

#[test]
fn a_ticket_can_be_looked_at_and_is_good_for_one_take() {
    let db = signed_up();
    at(&db, 10, ticket(9)).unwrap();
    assert_eq!(at(&db, 11, asked(PEEK)).unwrap()["login"], "acme");
    let taken = at(&db, 12, asked(TAKE)).unwrap();
    assert_eq!(taken["installation"], 9);
    assert_eq!(taken["target_id"], 500);
    assert_eq!(at(&db, 13, asked(TAKE)).unwrap(), json!({}));
    assert_eq!(at(&db, 14, asked(PEEK)).unwrap(), json!({}));
}

#[test]
fn a_ticket_runs_out_in_ten_minutes() {
    let db = signed_up();
    at(&db, 10, ticket(9)).unwrap();
    let late = 10 + 10 * 60 * 1000;
    assert_eq!(at(&db, late, asked(PEEK)).unwrap(), json!({}));
    assert_eq!(at(&db, late, asked(TAKE)).unwrap(), json!({}));
}

#[test]
fn a_ticket_names_a_hash_not_a_guess() {
    let db = signed_up();
    at(&db, 10, ticket(9)).unwrap();
    let other = json!({"op":TAKE,"ticket_hash":"b".repeat(64)});
    assert_eq!(at(&db, 11, other).unwrap(), json!({}));
    let bad = json!({"op":TAKE,"ticket_hash":"short"});
    assert_eq!(at(&db, 11, bad).unwrap_err().code, "INVALID_INPUT");
}

#[test]
fn the_org_migration_keeps_a_connected_personal_installation() {
    let db = signed_up();
    at(&db, 10, person(7)).unwrap();
    let row = at(&db, 20, json!({"op":"github_installation_get"})).unwrap();
    assert_eq!(row["target_type"], "User");
    assert_eq!(row["target_id"], Value::Null);
    let versions = db
        .query("SELECT version FROM workspace_migrations", &[])
        .unwrap();
    assert_eq!(versions.len(), 13);
}

#[test]
fn a_store_of_version_twelve_upgrades_with_its_installation() {
    let db = NativeStore::memory().unwrap();
    db.query(
        "CREATE TABLE workspace_migrations(version INTEGER PRIMARY KEY,digest TEXT NOT NULL)",
        &[],
    )
    .unwrap();
    for (version, sql) in &crate::accounts::MIGRATIONS[..12] {
        for statement in sql.split(';').filter(|s| !s.trim().is_empty()) {
            db.query(statement, &[]).unwrap();
        }
        db.query(
            "INSERT INTO workspace_migrations(version,digest) VALUES(?,?)",
            &[json!(version), json!(yoneda_core::digest(sql.as_bytes()))],
        )
        .unwrap();
    }
    db.query(
        "INSERT INTO workspace_records(id,payload) VALUES('account',?)",
        &[json!(
            json!({"username":"ada_l","verifier":null,"created_at":1}).to_string()
        )],
    )
    .unwrap();
    db.query(
        "INSERT INTO account_github_installation(installation,login,connected_at) VALUES(7,'ada',1)",
        &[],
    )
    .unwrap();
    assert_eq!(listed(&db), [(7, "ada".into())]);
    let row = at(&db, 20, json!({"op":"github_installation_get"})).unwrap();
    assert_eq!(row["target_type"], "User");
}
