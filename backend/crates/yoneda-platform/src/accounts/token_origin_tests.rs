//! Tokens made by `yoneda login` say so: the device flow carries the CLI's host to the
//! token (`origin: "login"`, `host`), and the token list shows both. The migration that
//! adds them marks earlier `yoneda-cli` tokens as logins and drops the retired agent
//! layer's records, which nothing reads.
use super::execute_workspace;
use crate::{native::NativeStore, storage::SqlStore};
use serde_json::{Value, json};

fn at(db: &NativeStore, now: i64, mut command: Value) -> yoneda_core::Result<Value> {
    command["now"] = json!(now);
    execute_workspace(db, command)
}
fn account() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    at(&db, 1000, json!({"op":"signup","username":"alice","password":"a long test password","salt":"01".repeat(16),"recovery_hash":"b".repeat(64),"session_hash":"a".repeat(64)})).unwrap();
    db
}
fn pat(id: &str, hash: char, extra: Value) -> Value {
    let mut command = json!({"op":"pat_create","id":id,"name":"yoneda-cli","token_hash":hash.to_string().repeat(64),"scopes":["repo:read"],"expires_days":30,"repos":null});
    for (k, v) in extra.as_object().unwrap() {
        command[k] = v.clone();
    }
    command
}

#[test]
fn device_logins_carry_their_host_to_the_token() {
    let device = NativeStore::memory().unwrap();
    let code = |op: &str, extra: Value| {
        let mut command = json!({"op":op,"user_code":"BCDFGHJK","secret_hash":"f".repeat(64)});
        for (k, v) in extra.as_object().unwrap() {
            command[k] = v.clone();
        }
        command
    };
    at(
        &device,
        0,
        code(
            "device_create",
            json!({"client_name":"yoneda-cli","host":"ada-mbp"}),
        ),
    )
    .unwrap();
    at(&device, 1, code("device_approve", json!({"account":"alice","scopes":["repo:read"],"expires_days":7,"repos":null,"deny":false}))).unwrap();
    let granted = at(&device, 6_000, code("device_poll", json!({}))).unwrap();
    assert_eq!(
        (&granted["status"], &granted["host"]),
        (&json!("APPROVED"), &json!("ada-mbp"))
    );

    let db = account();
    at(
        &db,
        2000,
        pat(
            "pat_0123456789abcdef",
            'c',
            json!({"origin":"login","host":"ada-mbp"}),
        ),
    )
    .unwrap();
    at(&db, 2001, pat("pat_0123456789abcdee", 'd', json!({}))).unwrap();
    let listed = at(&db, 3000, json!({"op":"pat_list"})).unwrap()["tokens"].clone();
    let labels: Vec<(Value, Value)> = listed
        .as_array()
        .unwrap()
        .iter()
        .map(|t| (t["origin"].clone(), t["host"].clone()))
        .collect();
    assert_eq!(
        labels,
        [
            (json!("login"), json!("ada-mbp")),
            (Value::Null, Value::Null)
        ]
    );
    // A check answers the label too (the adapter's view of the token).
    let checked = at(
        &db,
        3001,
        json!({"op":"pat_check","token_hash":"c".repeat(64)}),
    )
    .unwrap();
    assert_eq!(checked["origin"], "login");
}

#[test]
fn hosts_and_origins_are_validated() {
    let device = NativeStore::memory().unwrap();
    for host in [json!(""), json!("a\nb"), json!("x".repeat(65)), json!(7)] {
        let command = json!({"op":"device_create","user_code":"BCDFGHJK","secret_hash":"f".repeat(64),"client_name":"yoneda-cli","host":host});
        assert_eq!(
            at(&device, 0, command).unwrap_err().code,
            "INVALID_INPUT",
            "{host}"
        );
    }
    // Without a host (an older CLI) the login still works, unlabelled by host.
    let command = json!({"op":"device_create","user_code":"BCDFGHJK","secret_hash":"f".repeat(64),"client_name":"yoneda-cli"});
    at(&device, 0, command).unwrap();
    let db = account();
    for extra in [
        json!({"origin":"web"}),
        json!({"origin":"login","host":"a\u{7}"}),
    ] {
        let refused = at(&db, 2000, pat("pat_0123456789abcdef", 'c', extra.clone()));
        assert_eq!(refused.unwrap_err().code, "INVALID_INPUT", "{extra}");
    }
}

#[test]
fn the_origin_migration_marks_old_logins_and_drops_agent_layer_records() {
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
    let live = [
        "account",
        "login_rate",
        "team_seq",
        "reviewer_policy",
        "session:aa",
    ];
    let retired = [
        "project:r0123456789abcdef0123",
        "provider:openai",
        "provider-retired:mimo",
        "platform-credential:r0123456789abcdef0123",
        "grant:g1",
        "reservation:x1",
        "budget",
        "workspace-spend:state",
    ];
    for id in live.iter().chain(&retired) {
        let payload = match *id {
            "account" => json!({"username":"bob","created_at":1}),
            "reviewer_policy" => json!({"expires": 9_999_999_999_999_i64}),
            _ => json!({"expires": 9_999_999_999_999_i64}),
        };
        old.query(
            "INSERT INTO workspace_records(id,payload) VALUES(?,?)",
            &[json!(id), json!(payload.to_string())],
        )
        .unwrap();
    }
    for (id, name, hash) in [
        ("pat_0123456789abcdef", "yoneda-cli", 'c'),
        ("pat_0123456789abcdee", "laptop", 'd'),
    ] {
        old.query(
            "INSERT INTO account_tokens(id,name,token_hash,scopes,repos,created_at,expires_at) VALUES(?,?,?,'[\"repo:read\"]',NULL,1,99999)",
            &[json!(id), json!(name), json!(hash.to_string().repeat(64))],
        )
        .unwrap();
    }
    let listed = at(&old, 2000, json!({"op":"pat_list"})).unwrap()["tokens"].clone();
    let by_name = |name: &str| -> Value {
        let tokens = listed.as_array().unwrap();
        tokens.iter().find(|t| t["name"] == name).unwrap().clone()
    };
    let (cli, laptop) = (by_name("yoneda-cli"), by_name("laptop"));
    assert_eq!(
        (&cli["origin"], &cli["host"]),
        (&json!("login"), &Value::Null)
    );
    assert_eq!(laptop["origin"], Value::Null);
    let ids = |db: &NativeStore| -> Vec<String> {
        db.query("SELECT id FROM workspace_records ORDER BY id", &[])
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap().to_owned())
            .collect()
    };
    let mut expected: Vec<String> = live.iter().map(|s| (*s).to_owned()).collect();
    expected.sort();
    assert_eq!(ids(&old), expected);
    // Repeat application changes nothing more.
    at(&old, 2001, json!({"op":"pat_list"})).unwrap();
    assert_eq!(ids(&old), expected);
    let versions = old
        .query("SELECT COUNT(*) AS n FROM workspace_migrations", &[])
        .unwrap();
    assert_eq!(versions[0]["n"], 9);
}
