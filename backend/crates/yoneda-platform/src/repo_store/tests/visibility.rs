//! Public and private repositories: who reads, who writes and who sees that a repository
//! exists, for callers without credentials, members and accounts that are not members, on
//! the authority and on the published head's snapshot.
use super::*;
use crate::storage::SqlStore;

fn as_caller(h: &Harness, credentials: Value, mut c: Value) -> yoneda_core::Result<Value> {
    *h.now.borrow_mut() += 1_000;
    c["now"] = json!(*h.now.borrow());
    for (key, value) in credentials.as_object().unwrap() {
        c[key] = value.clone();
    }
    execute_repo_store(&h.db, c)
}
fn anonymous() -> Value {
    json!({"_anonymous": true})
}
fn session(account: &str) -> Value {
    json!({"_session": {"workspace": account, "principal": format!("user:{account}"), "human": true}})
}
fn account_pat(account: &str) -> Value {
    json!({"_pat": {"workspace": account, "principal": format!("user:{account}"),
        "id": "pat_0123456789abcdef", "scopes": ["repo:read", "repo:write", "repo:admin"], "repos": null}})
}
fn set(h: &Harness, visibility: &str) -> Value {
    h.ok(
        OWNER,
        json!({"op":"repo_set_visibility","visibility":visibility}),
    )
}

/// A new repository with `visibility` (absent: the default), and its status.
fn created(visibility: Value) -> yoneda_core::Result<Value> {
    let db = crate::native::NativeStore::memory().unwrap();
    let owner = json!({"workspace": "ws-1", "principal": OWNER});
    execute_repo_store(
        &db,
        json!({"op":"repo_init","name":"demo","object_store":"r2:demo",
        "policy":{"required_checks":[],"approvals":0},"visibility":visibility,
        "_session":owner,"now":1}),
    )?;
    execute_repo_store(&db, json!({"op":"repo_status","_session":owner}))
}

#[test]
fn repositories_start_private_and_init_takes_a_visibility() {
    assert_eq!(created(Value::Null).unwrap()["visibility"], "private");
    assert_eq!(created(json!("public")).unwrap()["visibility"], "public");
    assert_eq!(code(created(json!("internal"))), "INVALID_INPUT");
    assert_eq!(code(created(json!(true))), "INVALID_INPUT");
}

/// Reads, writes and administration for each kind of caller, on a private then a public
/// repository: outsiders never see a private one, read a public one, and never write.
#[test]
fn the_access_matrix_holds_for_every_caller() {
    let (h, root) = seeded();
    h.ok(
        OWNER,
        json!({"op":"repo_member_put","account":"rita","role":"read"}),
    );
    h.ok(
        OWNER,
        json!({"op":"repo_member_put","account":"will","role":"write"}),
    );
    let reads = [
        json!({"op":"repo_status"}),
        json!({"op":"repo_log","ref":"main","limit":5}),
        json!({"op":"repo_refs"}),
        json!({"op":"repo_commit","commit":root}),
        json!({"op":"repo_git_access","service":"git-upload-pack"}),
        json!({"op":"repo_releases"}),
        json!({"op":"repo_changes"}),
    ];
    let writes = |n: u32| {
        [
            json!({"op":"repo_branch_set","ref":format!("x{n}"),"commit":root,"expected":null}),
            json!({"op":"repo_git_access","service":"git-receive-pack"}),
            // On the branch the first write made (only a writer's exists).
            json!({"op":"repo_change_create","title":"t","branch":format!("x{n}"),"base":"main"}),
        ]
    };
    let admin = [
        json!({"op":"repo_tokens"}),
        json!({"op":"repo_members"}),
        json!({"op":"repo_hooks"}),
        json!({"op":"repo_set_policy","policy":{"required_checks":[],"approvals":0}}),
        json!({"op":"repo_set_visibility","visibility":"private"}),
        json!({"op":"repo_clone_access"}),
    ];
    let callers = [
        ("anonymous", anonymous()),
        ("stranger session", session("stranger")),
        ("stranger token", account_pat("stranger")),
        ("read member", session("rita")),
        ("write member", session("will")),
    ];
    let mut n = 0;
    for public in [false, true] {
        set(&h, if public { "public" } else { "private" });
        for (who, credentials) in &callers {
            let outsider = !who.contains("member");
            for op in &reads {
                let expected = if outsider && !public {
                    "NOT_FOUND"
                } else {
                    "OK"
                };
                assert_eq!(
                    code(as_caller(&h, credentials.clone(), op.clone())),
                    expected,
                    "{who} public={public} {op}"
                );
            }
            n += 1;
            for op in writes(n) {
                let expected = match (*who, public) {
                    ("write member", _) => "OK",
                    ("read member", _) => "FORBIDDEN",
                    (_, false) => "NOT_FOUND",
                    ("anonymous", true) => "UNAUTHORIZED",
                    (_, true) => "FORBIDDEN",
                };
                assert_eq!(
                    code(as_caller(&h, credentials.clone(), op.clone())),
                    expected,
                    "{who} public={public} {op}"
                );
            }
            for op in &admin {
                let got = code(as_caller(&h, credentials.clone(), op.clone()));
                let refused = match (outsider, public, *who) {
                    (true, false, _) => got == "NOT_FOUND",
                    (true, true, "anonymous") => got == "UNAUTHORIZED",
                    _ => got == "FORBIDDEN",
                };
                // A member's clone access is a person's whole-repository read: allowed.
                let member_clone = !outsider && op["op"] == "repo_clone_access";
                assert!(
                    refused || (member_clone && got == "OK"),
                    "{who} public={public} {op}: {got}"
                );
            }
        }
    }
    // Public readers are named as themselves (anonymous, or the account).
    let viewer = as_caller(&h, anonymous(), json!({"op":"repo_status"})).unwrap()["viewer"].clone();
    assert_eq!(
        viewer,
        json!({"principal":"anonymous","owner":false,"role":null,"public":true})
    );
    let viewer =
        as_caller(&h, session("stranger"), json!({"op":"repo_status"})).unwrap()["viewer"].clone();
    assert_eq!(viewer["principal"], "user:stranger");
    assert_eq!(viewer["public"], true);
    let member = as_caller(&h, session("rita"), json!({"op":"repo_status"})).unwrap();
    assert_eq!(member["viewer"]["public"], false);
    assert_eq!(member["viewer"]["role"], "read");
}

/// Publishing lifts no restriction: a directory token stays inside its directory, a token
/// limited to an organization stays there, and a bad token is refused rather than read as
/// anonymous.
#[test]
fn tokens_keep_their_limits_on_a_public_repository() {
    let (h, _root) = seeded();
    set(&h, "public");
    const DOCS: &str = "token:public";
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"public","scopes":["read"],
        "paths":["docs/"],"_secret":"public-secret-0123456789abcdef0123456789"}),
    );
    assert_eq!(
        h.ok(DOCS, json!({"op":"repo_status"}))["grant"],
        json!(["docs/"])
    );
    assert_eq!(
        code(h.run(
            DOCS,
            json!({"op":"repo_git_access","service":"git-upload-pack"})
        )),
        "FORBIDDEN"
    );
    let mut limited = account_pat("stranger");
    limited["_pat"]["org"] = json!("acme");
    assert_eq!(
        code(as_caller(&h, limited, json!({"op":"repo_status"}))),
        "FORBIDDEN"
    );
    assert_eq!(
        code(as_caller(
            &h,
            json!({"_token":"yrp_unknown-0123456789abcdef0123456789"}),
            json!({"op":"repo_status"})
        )),
        "UNAUTHORIZED"
    );
}

#[test]
fn only_the_owner_account_changes_visibility() {
    let (h, _root) = seeded();
    h.ok(
        OWNER,
        json!({"op":"repo_member_put","account":"ada","role":"admin"}),
    );
    let flip = json!({"op":"repo_set_visibility","visibility":"public"});
    assert_eq!(
        code(as_caller(&h, session("ada"), flip.clone())),
        "FORBIDDEN"
    );
    assert_eq!(code(h.run(AGENT, flip.clone())), "FORBIDDEN");
    assert_eq!(
        code(h.run(
            OWNER,
            json!({"op":"repo_set_visibility","visibility":"internal"})
        )),
        "INVALID_INPUT"
    );
    assert_eq!(
        set(&h, "public"),
        json!({"visibility":"public","changed":true})
    );
    assert_eq!(
        set(&h, "public"),
        json!({"visibility":"public","changed":false})
    );
    // The owner's personal token with repo:admin is the owner's account.
    let owner_pat = json!({"_pat": {"workspace": "ws-1", "principal": "user:owner",
        "id": "pat_0123456789abcdef", "scopes": ["repo:admin"], "repos": null}});
    let back = as_caller(
        &h,
        owner_pat,
        json!({"op":"repo_set_visibility","visibility":"private"}),
    )
    .unwrap();
    assert_eq!(back["visibility"], "private");
    assert_eq!(
        code(as_caller(&h, anonymous(), json!({"op":"repo_status"}))),
        "NOT_FOUND"
    );
}

/// The published head carries visibility in its access snapshot: a flip changes the access
/// version (so caches reload it), and stateless reads decide on it.
#[test]
fn the_published_snapshot_follows_a_flip() {
    let (h, _root) = seeded();
    let head = || {
        h.ok(
            "platform:projection",
            json!({"op":"repo_head","ref":"main"}),
        )
    };
    let access = |head: &Value, credentials: Value| {
        crate::platform_head::head_access(&json!({"head": head, "credentials": credentials}))
    };
    let private = head();
    assert_eq!(private["visibility"], "private");
    assert_eq!(code(access(&private, anonymous())), "NOT_FOUND");
    set(&h, "public");
    let public = head();
    assert_ne!(public["access_version"], private["access_version"]);
    let read = access(&public, anonymous()).unwrap();
    assert_eq!(read["principal"], "anonymous");
    assert_eq!(read["public"], true);
    assert_eq!(read["grant"], Value::Null);
    // Nobody begins a commit from the snapshot without write.
    assert_eq!(
        code(crate::platform_head::head_begin(
            &json!({"head": public, "credentials": anonymous(), "paths": ["a"]})
        )),
        "FORBIDDEN"
    );
    // A head published before visibility carries none: private.
    let mut old = public.clone();
    old.as_object_mut().unwrap().remove("visibility");
    assert_eq!(code(access(&old, session("stranger"))), "NOT_FOUND");
    set(&h, "private");
    let again = head();
    assert_eq!(again["access_version"], private["access_version"]);
    assert_eq!(code(access(&again, anonymous())), "NOT_FOUND");
}

#[test]
fn upgrades_from_the_session_ids_schema_as_private() {
    let db = crate::native::NativeStore::memory().unwrap();
    let migrations = &super::super::migration::MIGRATIONS;
    let before = migrations
        .iter()
        .position(|(version, _)| *version == 35)
        .unwrap();
    super::super::migration::migrate_with(&db, "repo_schema_migrations", &migrations[..before])
        .unwrap();
    db.query("INSERT INTO repo_settings(id,name,workspace,owner,object_store,policy,policy_digest,created_at) VALUES('repository','demo','ws-1','user:owner','r2','{}','d',1)", &[]).unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    let row = db
        .query("SELECT name,visibility FROM repo_settings", &[])
        .unwrap();
    assert_eq!(row[0]["name"], "demo");
    assert_eq!(row[0]["visibility"], "private");
    // The column refuses anything but the two visibilities.
    assert!(
        db.query("UPDATE repo_settings SET visibility='internal'", &[])
            .is_err()
    );
}
