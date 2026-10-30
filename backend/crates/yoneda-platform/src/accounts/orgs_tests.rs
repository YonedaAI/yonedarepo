//! Organizations held by the account authority: creation in the shared account namespace,
//! owners and members, teams, the access answer the adapter builds credentials from,
//! personal-account hints, org-limited tokens and the migration that adds them.
use super::execute_workspace;
use crate::{native::NativeStore, storage::SqlStore};
use serde_json::{Value, json};

fn at(db: &NativeStore, now: i64, mut command: Value) -> yoneda_core::Result<Value> {
    command["now"] = json!(now);
    execute_workspace(db, command)
}
fn ok(db: &NativeStore, command: Value) -> Value {
    at(db, 1000, command).unwrap()
}
fn code(db: &NativeStore, command: Value) -> String {
    at(db, 1000, command).unwrap_err().code
}
/// The `acme` org, created by alice.
fn acme() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    ok(&db, json!({"op":"org_create","org":"acme","actor":"alice"}));
    db
}
fn person(name: &str) -> NativeStore {
    let db = NativeStore::memory().unwrap();
    ok(
        &db,
        json!({"op":"signup","username":name,"password":"a long test password","salt":"01".repeat(16),"recovery_hash":"b".repeat(64),"session_hash":"a".repeat(64)}),
    );
    db
}

#[test]
fn an_org_takes_its_name_and_nobody_signs_in_as_it() {
    let db = acme();
    assert_eq!(
        code(&db, json!({"op":"org_create","org":"acme","actor":"bob"})),
        "ALREADY_EXISTS"
    );
    let signup = json!({"op":"signup","username":"acme","password":"a long test password","salt":"01".repeat(16),"recovery_hash":"b".repeat(64),"session_hash":"a".repeat(64)});
    assert_eq!(code(&db, signup), "ALREADY_EXISTS");
    let login =
        json!({"op":"login","password":"a long test password","session_hash":"c".repeat(64)});
    assert_eq!(ok(&db, login)["authenticated"], false);
    assert_eq!(ok(&db, json!({"op":"account_exists"}))["exists"], false);
    assert_eq!(
        code(
            &db,
            json!({"op":"pat_create","id":"pat_0123456789abcdef","name":"x","token_hash":"c".repeat(64),"scopes":["repo:read"],"expires_days":1})
        ),
        "NOT_FOUND"
    );
    // A person's name is taken too, and org names are never emails.
    let alice = person("alice");
    assert_eq!(
        code(
            &alice,
            json!({"op":"org_create","org":"alice","actor":"bob"})
        ),
        "ALREADY_EXISTS"
    );
    let fresh = NativeStore::memory().unwrap();
    assert_eq!(
        code(
            &fresh,
            json!({"op":"org_create","org":"a@b.co","actor":"bob"})
        ),
        "INVALID_INPUT"
    );
    assert_eq!(
        code(&alice, json!({"op":"org_show","actor":"alice"})),
        "NOT_FOUND"
    );
}

#[test]
fn owners_manage_members_and_teams_members_only_look() {
    let db = acme();
    let put = |actor: &str, account: &str, role: &str| {
        at(
            &db,
            1000,
            json!({"op":"org_member_put","actor":actor,"account":account,"role":role}),
        )
    };
    assert_eq!(
        put("alice", "bob", "member").unwrap()["previous"],
        json!(null)
    );
    assert_eq!(put("bob", "carol", "member").unwrap_err().code, "FORBIDDEN");
    assert_eq!(
        put("mallory", "carol", "member").unwrap_err().code,
        "FORBIDDEN"
    );
    assert_eq!(
        put("alice", "acme", "member").unwrap_err().code,
        "INVALID_INPUT"
    );
    assert_eq!(
        put("alice", "carol", "admin").unwrap_err().code,
        "INVALID_INPUT"
    );
    // The last owner stays an owner.
    assert_eq!(
        put("alice", "alice", "member").unwrap_err().code,
        "FORBIDDEN"
    );

    let team = |actor: &str, op: &str, extra: Value| {
        let mut command = json!({"op":op,"actor":actor,"team":"devs"});
        for (k, v) in extra.as_object().unwrap() {
            command[k] = v.clone();
        }
        at(&db, 1000, command)
    };
    assert_eq!(
        team("bob", "team_create", json!({})).unwrap_err().code,
        "FORBIDDEN"
    );
    team("alice", "team_create", json!({})).unwrap();
    assert_eq!(
        ok(&db, json!({"op":"team_exists","team":"devs"}))["exists"],
        true
    );
    assert_eq!(
        ok(&db, json!({"op":"team_exists","team":"ops"}))["exists"],
        false
    );
    assert_eq!(
        team("alice", "team_create", json!({})).unwrap_err().code,
        "ALREADY_EXISTS"
    );
    assert_eq!(
        team("alice", "team_member_put", json!({"account":"carol"}))
            .unwrap_err()
            .code,
        "INVALID_INPUT",
        "only org members join teams"
    );
    team("alice", "team_member_put", json!({"account":"bob"})).unwrap();
    let shown = ok(&db, json!({"op":"org_show","actor":"bob"}));
    assert_eq!(shown["role"], "member");
    assert_eq!(
        shown["teams"],
        json!([{"name":"devs","id":1,"created_by":"user:alice","created_at":1000,"members":["bob"]}])
    );
    assert_eq!(shown["members"].as_array().unwrap().len(), 2);
    assert_eq!(
        code(&db, json!({"op":"org_show","actor":"carol"})),
        "FORBIDDEN"
    );

    let access = |account: &str| ok(&db, json!({"op":"org_access","account":account}));
    assert_eq!(
        access("bob"),
        json!({"org":"acme","role":"member","teams":[{"name":"devs","id":1}]})
    );
    assert_eq!(
        access("alice"),
        json!({"org":"acme","role":"owner","teams":[]})
    );
    assert_eq!(
        access("carol"),
        json!({"org":"acme","role":null,"teams":[]})
    );

    team("alice", "team_member_remove", json!({"account":"bob"})).unwrap();
    assert_eq!(access("bob")["teams"], json!([]));
    assert_eq!(
        team("alice", "team_member_remove", json!({"account":"bob"}))
            .unwrap_err()
            .code,
        "NOT_FOUND"
    );

    // Leaving the org (by oneself) drops its teams too; deleting a team drops its rows.
    team("alice", "team_member_put", json!({"account":"bob"})).unwrap();
    ok(
        &db,
        json!({"op":"org_member_remove","actor":"bob","account":"bob"}),
    );
    assert_eq!(access("bob"), json!({"org":"acme","role":null,"teams":[]}));
    put("alice", "bob", "member").unwrap();
    assert_eq!(
        access("bob")["teams"],
        json!([]),
        "rejoining restores no team"
    );
    team("alice", "team_member_put", json!({"account":"bob"})).unwrap();
    team("alice", "team_delete", json!({})).unwrap();
    assert_eq!(access("bob")["teams"], json!([]));
    let rows = db
        .query("SELECT COUNT(*) AS n FROM org_team_members", &[])
        .unwrap();
    assert_eq!(rows[0]["n"], 0);

    // A second owner lets the first step down; the last one cannot leave.
    put("alice", "bob", "owner").unwrap();
    put("bob", "alice", "member").unwrap();
    assert_eq!(
        code(
            &db,
            json!({"op":"org_member_remove","actor":"bob","account":"bob"})
        ),
        "FORBIDDEN"
    );
    assert_eq!(
        code(
            &db,
            json!({"op":"team_create","actor":"bob","team":"Bad Name"})
        ),
        "INVALID_INPUT"
    );
}

#[test]
fn hints_ride_on_sessions_and_tokens_and_tokens_may_be_limited_to_an_org() {
    let db = person("bob");
    ok(&db, json!({"op":"org_hint_add","org":"acme"}));
    ok(&db, json!({"op":"org_hint_add","org":"acme"}));
    let session = ok(&db, json!({"op":"session","session_hash":"a".repeat(64)}));
    assert_eq!(session["orgs"], json!(["acme"]));
    let created = ok(
        &db,
        json!({"op":"pat_create","id":"pat_0123456789abcdef","name":"ci","token_hash":"c".repeat(64),"scopes":["repo:read","repo:write"],"org":"acme","expires_days":1}),
    );
    assert_eq!(created["org"], "acme");
    let checked = ok(&db, json!({"op":"pat_check","token_hash":"c".repeat(64)}));
    assert_eq!(
        (checked["org"].clone(), checked["orgs"].clone()),
        (json!("acme"), json!(["acme"]))
    );
    assert_eq!(
        code(
            &db,
            json!({"op":"pat_create","id":"pat_0123456789abcde0","name":"ci","token_hash":"d".repeat(64),"scopes":["repo:read"],"org":"A@b","expires_days":1})
        ),
        "INVALID_INPUT"
    );
    ok(&db, json!({"op":"org_hint_remove","org":"acme"}));
    let session = ok(&db, json!({"op":"session","session_hash":"a".repeat(64)}));
    assert_eq!(session["orgs"], json!([]));
    // Hints belong to people, never to an org.
    assert_eq!(
        code(&acme(), json!({"op":"org_hint_add","org":"other"})),
        "NOT_FOUND"
    );
}

#[test]
fn the_org_migration_upgrades_a_version_two_store_and_keeps_its_tokens() {
    let old = NativeStore::memory().unwrap();
    old.query(
        "CREATE TABLE workspace_migrations(version INTEGER PRIMARY KEY,digest TEXT NOT NULL)",
        &[],
    )
    .unwrap();
    for (version, sql) in [
        (1, include_str!("migrations/0001_accounts.sql")),
        (2, include_str!("migrations/0002_account_tokens.sql")),
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
        &[json!(json!({"username":"bob","created_at":1}).to_string())],
    )
    .unwrap();
    old.query(
        "INSERT INTO account_tokens(id,name,token_hash,scopes,repos,created_at,expires_at) VALUES('pat_0123456789abcdef','old',?,'[\"repo:read\"]',NULL,1,99999)",
        &[json!("c".repeat(64))],
    )
    .unwrap();
    let checked = ok(&old, json!({"op":"pat_check","token_hash":"c".repeat(64)}));
    assert_eq!(
        (checked["org"].clone(), checked["orgs"].clone()),
        (json!(null), json!([]))
    );
    let versions = old
        .query(
            "SELECT version FROM workspace_migrations ORDER BY version",
            &[],
        )
        .unwrap();
    assert_eq!(versions.len(), 9);
    // Repeat application changes nothing.
    ok(&old, json!({"op":"org_hint_add","org":"acme"}));
    assert_eq!(
        old.query("SELECT COUNT(*) AS n FROM workspace_migrations", &[])
            .unwrap()[0]["n"],
        9
    );
}

#[test]
fn team_ids_are_never_reused_and_a_deleted_org_retires_its_name() {
    let db = acme();
    let team = |op: &str| ok(&db, json!({"op":op,"actor":"alice","team":"devs"}));
    assert_eq!(team("team_create")["id"], 1);
    team("team_delete");
    assert_eq!(
        ok(&db, json!({"op":"team_exists","team":"devs"})),
        json!({"exists":false,"id":null})
    );
    assert_eq!(
        team("team_create")["id"],
        2,
        "a re-created team is a new team"
    );
    assert_eq!(ok(&db, json!({"op":"team_exists","team":"devs"}))["id"], 2);

    ok(
        &db,
        json!({"op":"org_member_put","actor":"alice","account":"bob","role":"member"}),
    );
    assert_eq!(
        code(
            &db,
            json!({"op":"org_delete","actor":"bob","confirm":"acme"})
        ),
        "FORBIDDEN"
    );
    assert_eq!(
        code(
            &db,
            json!({"op":"org_delete","actor":"alice","confirm":"acm"})
        ),
        "INVALID_INPUT"
    );
    let deleted = ok(
        &db,
        json!({"op":"org_delete","actor":"alice","confirm":"acme"}),
    );
    assert_eq!(deleted["members"], json!(["alice", "bob"]));
    // Gone for every operation, and the name stays taken.
    assert_eq!(
        code(&db, json!({"op":"org_access","account":"alice"})),
        "NOT_FOUND"
    );
    assert_eq!(
        code(&db, json!({"op":"org_show","actor":"alice"})),
        "NOT_FOUND"
    );
    assert_eq!(
        code(
            &db,
            json!({"op":"org_create","org":"acme","actor":"mallory"})
        ),
        "ALREADY_EXISTS"
    );
    let signup = json!({"op":"signup","username":"acme","password":"a long test password","salt":"01".repeat(16),"recovery_hash":"b".repeat(64),"session_hash":"a".repeat(64)});
    assert_eq!(code(&db, signup), "ALREADY_EXISTS");
    let rows = db
        .query(
            "SELECT (SELECT COUNT(*) FROM org_members)+(SELECT COUNT(*) FROM org_teams) AS n",
            &[],
        )
        .unwrap();
    assert_eq!(rows[0]["n"], 0);
}

#[test]
fn the_team_id_migration_numbers_existing_teams_and_continues_after_them() {
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
            json!({"username":"acme","kind":"org","created_at":1,"created_by":"alice"}).to_string()
        )],
    )
    .unwrap();
    old.query(
        "INSERT INTO org_members VALUES('alice','owner','user:alice',1)",
        &[],
    )
    .unwrap();
    for team in ["devs", "ops"] {
        old.query(
            "INSERT INTO org_teams(name,created_by,created_at) VALUES(?,'user:alice',1)",
            &[json!(team)],
        )
        .unwrap();
    }
    let shown = ok(&old, json!({"op":"org_show","actor":"alice"}));
    let ids: Vec<_> = shown["teams"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].clone())
        .collect();
    assert_eq!(ids, vec![json!(1), json!(2)]);
    let created = ok(
        &old,
        json!({"op":"team_create","actor":"alice","team":"qa"}),
    );
    assert_eq!(created["id"], 3);
    // A person's store gets no counter.
    let fresh = person("bob");
    assert!(
        fresh
            .query("SELECT id FROM workspace_records WHERE id='team_seq'", &[])
            .unwrap()
            .is_empty()
    );
}
